/* Existing admin certificate archive: attach image previews to already-issued PDFs.
 * No new verifier, key, bucket or authentication mechanism.
 * An image is published only under the immutable key of the current PDF.
 * Failures never change the PDF path or the credential's validity.
 */
(function () {
  "use strict";

  var box = document.getElementById("preview-upload-files");
  var button = document.getElementById("preview-upload-btn");
  var result = document.getElementById("preview-upload-result");
  if (!box || !button || !result) return;

  var MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
  var ID_PATTERN = /^BPA-(?:FND|BCAB)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

  function message(text, bad) {
    result.textContent = text;
    result.hidden = false;
    result.className = bad ? "msg msg--bad" : "msg";
  }

  function url(key) {
    return "/storage/v1/object/credentials/" +
      key.split("/").map(encodeURIComponent).join("/");
  }

  function apiError(response, title) {
    if (response.ok) return Promise.resolve(response);
    return response.text().then(function (raw) {
      var detail = raw.slice(0, 180);
      try { detail = JSON.parse(raw).message || detail; } catch (e) { /* expected */ }
      throw new Error(title + " (" + response.status + "): " + detail);
    });
  }

  function previewKey(row) {
    if (!row.pdf_path || !/^BPA-(?:FND|BCAB)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}\/\d{8}T\d{6}-[0-9a-f]{8}\.pdf$/.test(row.pdf_path)) {
      throw new Error("The registered PDF does not have a supported archive path.");
    }
    if (row.pdf_path.split("/")[0] !== row.credential_id) {
      throw new Error("Credential ID and archived PDF path do not agree.");
    }
    return row.pdf_path.slice(0, -4) + ".png";
  }

  function validate(file) {
    if (!file || !/\.png$/i.test(file.name) || (file.type && file.type !== "image/png"))
      return Promise.reject(new Error("Select a PNG preview file."));
    if (!file.size || file.size > MAX_PREVIEW_BYTES)
      return Promise.reject(new Error("PNG preview must be nonempty and under 5 MB."));
    return file.slice(0, 8).arrayBuffer().then(function (bytes) {
      var h = Array.from(new Uint8Array(bytes));
      var correct = [137,80,78,71,13,10,26,10];
      if (h.length !== 8 || !h.every(function (byte,i) { return byte === correct[i]; }))
        throw new Error("Invalid PNG file signature.");
    });
  }

  function checkAlreadyUploaded(key) {
    return authFetch(url(key), { method: "HEAD" }).then(function (response) {
      if (response.ok) return true;
      if (response.status === 404 || response.status === 400) return false;
      return apiError(response, "Cannot inspect existing preview");
    });
  }

  function insertPreview(key, file) {
    return authFetch(url(key), {
      method: "POST",
      headers: { "Content-Type": "image/png", "x-upsert": "false" },
      body: file
    }).then(function (response) {
      if (response.ok) return;
      if (response.status === 400 || response.status === 409) {
        // A prior attempt may have uploaded the image, then failed its
        // record PATCH. Reconnect an existing image rather than overwrite it.
        return checkAlreadyUploaded(key).then(function (exists) {
          if (!exists) return apiError(response, "Preview upload failed");
        });
      }
      return apiError(response, "Preview upload failed");
    });
  }

  function linkPreview(row, key) {
    // Guard against publishing a preview against a PDF changed in another tab
    // since the register was loaded. PostgREST returns [] if the PDF differs.
    return authFetch("/rest/v1/credentials?id=eq." + encodeURIComponent(row.id) +
      "&pdf_path=eq." + encodeURIComponent(row.pdf_path), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ preview_path: key })
    }).then(function (r) { return apiError(r, "Cannot link preview"); })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].preview_path !== key)
          throw new Error("The PDF changed or record update failed; preview link not saved.");
        row.preview_path = key;
      });
  }

  function one(file, row) {
    return validate(file).then(function () {
      var key = previewKey(row);
      return checkAlreadyUploaded(key).then(function (exists) {
        return exists ? Promise.resolve() : insertPreview(key, file);
      }).then(function () {
        return linkPreview(row, key);
      });
    });
  }

  button.addEventListener("click", function () {
    if (button.disabled) return;
    var files = Array.from(box.files || []);
    if (!files.length) { message("Select the PNG previews first.", true); return; }
    var jobs = [], seen = {};
    try {
      files.forEach(function (file) {
        var name = file.name.match(/^(BPA-(?:FND|BCAB)-\d{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6})\.png$/i);
        if (!name || !ID_PATTERN.test(name[1].toUpperCase()))
          throw new Error("Each preview must be named by its certificate ID, for example BPA-FND-2026-WHXRTT.png.");
        var id = name[1].toUpperCase();
        if (seen[id]) throw new Error("Duplicate preview: " + id);
        var row = credState.rows.filter(function (r) { return r.credential_id === id; })[0];
        if (!row) throw new Error("No credential is registered for " + id);
        if (!row.pdf_path) throw new Error("The PDF must be archived first for " + id);
        previewKey(row);
        seen[id] = true;
        jobs.push({ file: file, row: row });
      });
    } catch (e) { message(e.message, true); return; }

    if (jobs.some(function (j) { return !!j.row.preview_path; }) &&
        !window.confirm("One or more credentials already have previews. Re-link the matching archived previews?")) return;

    button.disabled = true;
    var ok = [], errors = [];
    var chain = Promise.resolve();
    jobs.forEach(function (job, i) {
      chain = chain.then(function () {
        message("Uploading preview " + (i + 1) + " of " + jobs.length +
          ": " + job.row.holder_name + "…", false);
        return one(job.file, job.row).then(function () {
          ok.push(job.row.credential_id);
        }).catch(function (e) {
          errors.push(job.row.credential_id + ": " + e.message);
        });
      });
    });
    chain.then(function () { return loadCredentials(); })
      .then(function () {
        message("Previews linked " + ok.length + " of " + jobs.length +
          (errors.length ? ". Failed: " + errors.join(" | ") : ". All preview images are now linked."),
          errors.length > 0);
        if (!errors.length) box.value = "";
      }).catch(function (err) {
        message("Preview status uncertain: " + err.message, true);
      }).then(function () { button.disabled = false; });
  });
})();
