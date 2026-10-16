/* Certificate PDF archival on the existing /admin credential register.
 * Uses the signed-in administrator's Supabase JWT and storage.objects RLS.
 * Never stores a service-role key in the browser.
 *
 * Archive order: PRIVATE master -> durable backend job -> verified PDF + PNG paths.
 * Object keys are immutable and versioned. An upload error cannot create a
 * broken public link, and older master copies remain available to reissue.
 */
(function () {
  "use strict";

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

  function processor(path, options) {
    var current = session();
    if (!current) return Promise.reject(new Error("Not signed in"));
    var token = current.expires_at && Date.now() > current.expires_at
      ? refresh() : Promise.resolve(current);
    return token.then(function (fresh) {
      return fetch(SUPABASE_URL + "/functions/v1/certificate-processor/" + path, {
        method: options ? "POST" : "GET",
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + fresh.access_token,
          "Content-Type": "application/json" },
        body: options ? JSON.stringify(options) : undefined
      });
    }).then(function (r) { return failResponse(r, "Certificate processing request failed"); })
      .then(function (r) { return r.json(); });
  }

  function pause() { return new Promise(function (resolve) { setTimeout(resolve, 1500); }); }
  function waitJob(job, onProgress) {
    var started = Date.now();
    function check(current) {
      onProgress(current.stage || "Processing certificate");
      if (current.state === "completed") return current;
      if (current.state === "failed" || current.state === "attention") {
        throw new Error((current.error || "Processing failed") +
          " Private master retained. Open Manage PDF to retry without uploading again.");
      }
      if (Date.now() - started > 180000) {
        throw new Error("Processing continues on the server. Open Manage PDF to check the saved job; do not upload again.");
      }
      return pause().then(function () { return processor("jobs?id=" + current.id); })
        .then(function (rows) { if (!rows[0]) throw new Error("Job status unavailable"); return check(rows[0]); });
    }
    return check(job);
  }
  function processVersion(row, key, mode, onProgress) {
    return processor("jobs", { credential_id: row.credential_id, master_path: key, mode: mode,
      expected_pdf_path: row.pdf_path || null, expected_updated_at: row.updated_at })
      .then(function (job) { return waitJob(job, onProgress); })
      .then(function (job) {
        row.pdf_path = job.result.pdf_path;
        row.preview_path = job.result.preview_path;
        if (job.result.record_updated_at) row.updated_at = job.result.record_updated_at;
        return job;
      });
  }
  window.processCredentialArchive = processVersion;
  window.certificateProcessor = processor;

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

  function archive(file, row, onProgress) {
    var key = freshKey(row.credential_id);
    var progress = onProgress || function (text) { report(status, text, false); };
    return validFile(file, row.credential_id).then(function () {
      progress("Uploading PDF");
      return upload(MASTER_BUCKET, key, file);
    }).then(function () {
      return processVersion(row, key, "publish", progress);
    }).catch(function (error) {
      throw new Error(error.message + " If the PDF upload succeeded, use Earlier versions to process its retained master.");
    });
  }

  function setBusy(value) {
    busy = value;
    document.getElementById("archive-upload-btn").disabled = value;
    batchButton.disabled = value;
    document.getElementById("archive-close-btn").disabled = value;
  }

  function listVersions() {
    var fresh = credState.rows.filter(function (r) { return r.id === archiveRow.id; })[0];
    if (fresh) archiveRow = fresh;
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
            restore.textContent = "Process & make current";
            restore.addEventListener("click", function () {
              if (busy || !window.confirm("Use this archived version as the published certificate for " +
                archiveRow.holder_name + "? The previous master will be retained.")) return;
              setBusy(true);
              processVersion(archiveRow, key, "restore", function (text) { report(status, text, false); })
                .then(function () {
                  report(status, "Complete. This version and its matching preview are now published.", false);
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

  function loadJobs() {
    var box = document.getElementById("archive-jobs");
    box.textContent = "Loading processing jobs…";
    processor("jobs?credential=" + archiveRow.credential_id).then(function (jobs) {
      box.textContent = "";
      jobs.slice(0, 10).forEach(function (job) {
        var item = document.createElement("div"); item.className = "archive-version";
        var text = document.createElement("span");
        text.textContent = job.state + " — " + job.stage + (job.error ? ": " + job.error : ""); item.appendChild(text);
        if (["failed", "queued", "running"].indexOf(job.state) !== -1) {
          var retry = document.createElement("button"); retry.type = "button"; retry.className = "mini";
          retry.textContent = job.state === "failed" ? "Retry saved PDF" : "Check progress";
          retry.addEventListener("click", function () {
            if (busy) return; setBusy(true);
            var task = job.state === "failed" ? processor("retry", { id: job.id }) : Promise.resolve(job);
            task.then(function (j) { return waitJob(j, function (t) { report(status, t, false); }); })
              .then(loadCredentials).then(loadJobs).then(listVersions)
              .catch(function (e) { report(status, e.message, true); }).then(function () { setBusy(false); });
          }); item.appendChild(retry);
        }
        box.appendChild(item);
      });
      if (!jobs.length) box.textContent = "No processing jobs yet.";
    }).catch(function (e) { box.textContent = e.message; });
  }
  document.getElementById("archive-regenerate-btn").addEventListener("click", function () {
    if (busy || !archiveRow || !archiveRow.pdf_path) return;
    setBusy(true);
    processVersion(archiveRow, archiveRow.pdf_path, "repair", function (t) { report(status, t, false); })
      .then(loadCredentials).then(loadJobs)
      .catch(function (e) { report(status, e.message, true); }).then(function () { setBusy(false); });
  });

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
    loadJobs();
    var links = document.getElementById("archive-current-links");
    links.textContent = "";
    [["View verification", "/verify/" + row.credential_id],
      ["Download PDF", row.pdf_path ? SUPABASE_URL + "/storage/v1/object/public/credentials/" + row.pdf_path : null],
      ["View certificate preview", row.preview_path ? SUPABASE_URL + "/storage/v1/object/public/credentials/" + row.preview_path : null]]
      .forEach(function (pair) { if (!pair[1]) return; var a = document.createElement("a");
        a.textContent = pair[0]; a.href = pair[1]; a.target = "_blank"; a.rel = "noopener"; a.className = "mini"; links.appendChild(a); });
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
    report(status, "Uploading PDF", false);
    setBusy(true);
    archive(file, archiveRow).then(function () {
      report(status, "Complete. PDF and generated preview are archived and verified.", false);
      document.getElementById("archive-current").textContent = "Public PDF linked: " + archiveRow.pdf_path;
      fileInput.value = "";
      return loadCredentials();
    }).then(listVersions).then(loadJobs)
      .catch(function (err) { report(status, err.message, true); })
      .then(function () { setBusy(false); });
  });

  batchButton.addEventListener("click", function () {
    if (busy) return;
    var files = Array.prototype.slice.call(batchInput.files);
    if (!files.length) { report(batchStatus, "Choose the PDFs to archive.", true); return; }
    var jobs = [];
    var preflightErrors = [];
    var seen = {};
    for (var i = 0; i < files.length; i++) {
      var match = files[i].name.match(/^(BPA-(?:FND|BCAB)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6})\.pdf$/i);
      if (!match) {
        preflightErrors.push(files[i].name + ": Requires attention — filename must be the certificate ID.");
        continue;
      }
      var id = match[1].toUpperCase();
      var row = credState.rows.filter(function (r) { return r.credential_id === id; })[0];
      if (!row || seen[id]) {
        preflightErrors.push(id + ": Requires attention — duplicate or unregistered ID.");
        continue;
      }
      seen[id] = true;
      jobs.push({ file: files[i], row: row });
    }
    var replacements = jobs.filter(function (job) { return !!job.row.pdf_path; });
    if (replacements.length && !window.confirm(replacements.length + " selected credentials already " +
      "have public PDFs. Archive new versions and make them current? Earlier masters are retained.")) return;

    setBusy(true);
    var successes = [], errors = preflightErrors;
    var chain = Promise.resolve();
    jobs.forEach(function (job, index) {
      chain = chain.then(function () {
        report(batchStatus, "Archiving " + (index + 1) + " of " + jobs.length +
          ": " + job.row.holder_name + "…", false);
        return archive(job.file, job.row, function (text) { report(batchStatus, job.row.holder_name + ": " + text, false); }).then(function () {
          successes.push(job.row.credential_id);
        }).catch(function (err) {
          errors.push(job.row.credential_id + ": " + err.message);
        });
      });
    });
    chain.then(function () {
      return loadCredentials();
    }).then(function () {
      report(batchStatus, "Archived " + successes.length + " of " + files.length +
        ". " + (errors.length ? "Failed / requires attention: " + errors.join(" | ") : "All PDFs and generated previews linked successfully."),
        !!errors.length);
      if (!errors.length) batchInput.value = "";
    }).catch(function (err) {
      report(batchStatus, "Archive status uncertain: " + err.message, true);
    }).then(function () { setBusy(false); });
  });
})();
