/* Certificate PDF archival on the existing /admin credential register.
 * Uses the signed-in administrator's Supabase JWT and storage.objects RLS.
 * Never stores a service-role key in the browser.
 *
 * Archive order: PRIVATE master -> PUBLIC copy -> credentials.pdf_path.
 * Object keys are immutable and versioned. An upload error cannot create a
 * broken public link, and older master copies remain available to reissue.
 */
(function () {
  "use strict";

  var PUBLIC_BUCKET = "credentials";
  var MASTER_BUCKET = "credential-masters";
  var MAX_BYTES = 15 * 1024 * 1024;
  var archiveRow = null;
  var busy = false;
  var dialog = document.getElementById("credential-archive-dialog");
  var fileInput = document.getElementById("archive-file");
  var batchInput = document.getElementById("archive-batch-files");
  var batchButton = document.getElementById("archive-batch-btn");
  var status = document.getElementById("archive-status");
  var batchStatus = document.getElementById("archive-batch-status");
  var versions = document.getElementById("archive-versions");

  function report(el, message, isError) {
    el.textContent = message;
    el.hidden = !message;
    el.className = isError ? "msg msg--bad" : "msg";
  }

  function urlFor(bucket, key) {
    return "/storage/v1/object/" + encodeURIComponent(bucket) + "/" +
      key.split("/").map(encodeURIComponent).join("/");
  }

  function freshKey(id) {
    var ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "");
    var random = new Uint8Array(4);
    crypto.getRandomValues(random);
    var hex = Array.prototype.map.call(random, function (n) {
      return n.toString(16).padStart(2, "0");
    }).join("");
    return id + "/" + ts + "-" + hex + ".pdf";
  }

  function failResponse(response, defaultMessage) {
    if (response.ok) return response;
    return response.text().then(function (t) {
      var detail = t.slice(0, 250);
      try {
        var parsed = JSON.parse(t);
        detail = parsed.message || parsed.error || detail;
      } catch (e) { /* Not JSON */ }
      throw new Error(defaultMessage + " (" + response.status + "): " + detail);
    });
  }

  function storage(bucket, key, opts) {
    return authFetch(urlFor(bucket, key), opts);
  }

  function upload(bucket, key, file) {
    return storage(bucket, key, {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "x-upsert": "false" },
      body: file
    }).then(function (response) {
      return failResponse(response, "Upload to " + bucket + " failed");
    });
  }

  function pdfDownload(bucket, key) {
    return storage(bucket, key, { method: "GET" })
      .then(function (response) { return failResponse(response, "Cannot retrieve archived PDF"); })
      .then(function (response) { return response.blob(); });
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function linkRecord(row, key) {
    return authFetch("/rest/v1/credentials?id=eq." + encodeURIComponent(row.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ pdf_path: key })
    }).then(function (response) { return failResponse(response, "Could not link the archived PDF"); })
      .then(function (response) { return response.json(); })
      .then(function (items) {
        if (!Array.isArray(items) || items.length !== 1 || items[0].pdf_path !== key) {
          throw new Error("No credential record was updated; the archive was not linked.");
        }
      });
  }

  function validFile(file, id) {
    if (!file || !/\.pdf$/i.test(file.name) || (file.type && file.type !== "application/pdf")) {
      return Promise.reject(new Error("Select a PDF certificate file."));
    }
    if (!file.size || file.size > MAX_BYTES) {
      return Promise.reject(new Error("PDF must be nonempty and no larger than 15 MB."));
    }
    // Refuse accidentally misnamed or HTML files rather than publishing them.
    return file.slice(0, 5).text().then(function (header) {
      if (header !== "%PDF-") throw new Error("This file is not a valid PDF.");
      if (!id || !/^BPA-(?:FND|BCAB)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/.test(id)) {
        throw new Error("Unrecognised certificate ID.");
      }
    });
  }

  function archive(file, row) {
    var key = freshKey(row.credential_id);
    return validFile(file, row.credential_id).then(function () {
      // A master is saved before anything becomes accessible publicly.
      return upload(MASTER_BUCKET, key, file);
    }).then(function () {
      return upload(PUBLIC_BUCKET, key, file);
    }).then(function () {
      // This is the ONLY operation that affects the public verification page.
      return linkRecord(row, key);
    }).then(function () {
      row.pdf_path = key;
      return key;
    }).catch(function (error) {
      throw new Error(error.message + " If an upload succeeded, its master remains in Storage; " +
        "check Manage PDF > Earlier versions before retrying.");
    });
  }

  function setBusy(value) {
    busy = value;
    document.getElementById("archive-upload-btn").disabled = value;
    batchButton.disabled = value;
    document.getElementById("archive-close-btn").disabled = value;
  }

  function listVersions() {
    versions.textContent = "Loading archived versions…";
    var keyPrefix = archiveRow.credential_id + "/";
    return authFetch("/storage/v1/object/list/" + MASTER_BUCKET, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: keyPrefix, limit: 100,
        sortBy: { column: "created_at", order: "desc" } })
    }).then(function (response) { return failResponse(response, "Cannot list master archives"); })
      .then(function (response) { return response.json(); })
      .then(function (items) {
        versions.textContent = "";
        if (!Array.isArray(items) || !items.length) {
          versions.textContent = "No master PDF archived yet.";
          return;
        }
        items.forEach(function (entry) {
          if (!entry.name || !/\.pdf$/i.test(entry.name)) return;
          var key = keyPrefix + entry.name;
          var item = document.createElement("div");
          item.className = "archive-version";
          var label = document.createElement("span");
          label.className = "mono";
          label.textContent = entry.name + (archiveRow.pdf_path === key ? " (current)" : "");
          item.appendChild(label);

          var get = document.createElement("button");
          get.type = "button"; get.className = "mini";
          get.textContent = "Download master";
          get.addEventListener("click", function () {
            get.disabled = true;
            pdfDownload(MASTER_BUCKET, key).then(function (blob) {
              saveBlob(blob, archiveRow.credential_id + ".pdf");
            }).catch(function (err) { report(status, err.message, true); })
              .then(function () { get.disabled = false; });
          });
          item.appendChild(get);

          if (archiveRow.pdf_path !== key) {
            var restore = document.createElement("button");
            restore.type = "button"; restore.className = "mini";
            restore.textContent = "Make current";
            restore.addEventListener("click", function () {
              if (busy || !window.confirm("Use this archived version as the published certificate for " +
                archiveRow.holder_name + "? The previous master will be retained.")) return;
              setBusy(true);
              pdfDownload(MASTER_BUCKET, key).then(function (blob) {
                // Repair a missing public copy; do not overwrite an existing one.
                return storage(PUBLIC_BUCKET, key, { method: "HEAD" }).then(function (r) {
                  if (r.ok) return;
                  if (r.status !== 404 && r.status !== 400) {
                    return failResponse(r, "Could not check public archive");
                  }
                  return upload(PUBLIC_BUCKET, key, blob);
                });
              }).then(function () { return linkRecord(archiveRow, key); })
                .then(function () {
                  archiveRow.pdf_path = key;
                  report(status, "This archived version is now the current PDF.", false);
                  return loadCredentials();
                }).then(listVersions)
                .catch(function (err) { report(status, err.message, true); })
                .then(function () { setBusy(false); });
            });
            item.appendChild(restore);
          }
          versions.appendChild(item);
        });
      }).catch(function (err) { versions.textContent = err.message; });
  }

  window.openCredentialArchive = function (row) {
    if (busy) return;
    archiveRow = row;
    fileInput.value = "";
    report(status, "", false);
    document.getElementById("archive-holder").textContent =
      row.holder_name + " — " + row.credential_id;
    document.getElementById("archive-current").textContent =
      row.pdf_path ? "Public PDF linked: " + row.pdf_path : "No public PDF is linked yet.";
    dialog.hidden = false;
    document.getElementById("archive-upload-btn").focus();
    listVersions();
  };

  document.getElementById("archive-close-btn").addEventListener("click", function () {
    if (!busy) dialog.hidden = true;
  });

  document.getElementById("archive-upload-btn").addEventListener("click", function () {
    if (busy || !archiveRow) return;
    var file = fileInput.files[0];
    if (!file) { report(status, "Choose the certificate PDF first.", true); return; }
    if (archiveRow.pdf_path && !window.confirm("This credential already has a published PDF. " +
      "Archive a new version and make it current? The old master is retained.")) return;
    report(status, "Saving private master, public copy, and record…", false);
    setBusy(true);
    archive(file, archiveRow).then(function (key) {
      report(status, "Archived and linked " + key + ". Public verification can now show the PDF.", false);
      document.getElementById("archive-current").textContent = "Public PDF linked: " + key;
      fileInput.value = "";
      return loadCredentials();
    }).then(listVersions)
      .catch(function (err) { report(status, err.message, true); })
      .then(function () { setBusy(false); });
  });

  batchButton.addEventListener("click", function () {
    if (busy) return;
    var files = Array.prototype.slice.call(batchInput.files);
    if (!files.length) { report(batchStatus, "Choose the PDFs to archive.", true); return; }
    var jobs = [];
    var seen = {};
    for (var i = 0; i < files.length; i++) {
      var match = files[i].name.match(/^(BPA-(?:FND|BCAB)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6})\.pdf$/i);
      if (!match) {
        report(batchStatus, "Rename each file to its exact certificate ID, e.g. BPA-FND-2026-WHXRTT.pdf.", true);
        return;
      }
      var id = match[1].toUpperCase();
      var row = credState.rows.filter(function (r) { return r.credential_id === id; })[0];
      if (!row || seen[id]) {
        report(batchStatus, "Duplicate or unregistered ID in selected files: " + id, true);
        return;
      }
      seen[id] = true;
      jobs.push({ file: files[i], row: row });
    }
    var replacements = jobs.filter(function (job) { return !!job.row.pdf_path; });
    if (replacements.length && !window.confirm(replacements.length + " selected credentials already " +
      "have public PDFs. Archive new versions and make them current? Earlier masters are retained.")) return;

    setBusy(true);
    var successes = [], errors = [];
    var chain = Promise.resolve();
    jobs.forEach(function (job, index) {
      chain = chain.then(function () {
        report(batchStatus, "Archiving " + (index + 1) + " of " + jobs.length +
          ": " + job.row.holder_name + "…", false);
        return archive(job.file, job.row).then(function () {
          successes.push(job.row.credential_id);
        }).catch(function (err) {
          errors.push(job.row.credential_id + ": " + err.message);
        });
      });
    });
    chain.then(function () {
      return loadCredentials();
    }).then(function () {
      report(batchStatus, "Archived " + successes.length + " of " + jobs.length +
        ". " + (errors.length ? "Failures: " + errors.join(" | ") : "All public PDFs linked successfully."),
        !!errors.length);
      if (!errors.length) batchInput.value = "";
    }).catch(function (err) {
      report(batchStatus, "Archive status uncertain: " + err.message, true);
    }).then(function () { setBusy(false); });
  });
})();
