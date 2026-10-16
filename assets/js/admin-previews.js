/* Backend-only bulk repair. There are no PNG inputs or browser PNG uploads. */
(function () {
  "use strict";
  var button = document.getElementById("preview-repair-btn");
  var result = document.getElementById("preview-repair-result");
  if (!button || !result) return;
  button.addEventListener("click", function () {
    if (button.disabled) return;
    button.disabled = true; result.hidden = false;
    var jobs = credState.rows.filter(function (row) { return row.pdf_path && !row.preview_path; });
    var reports = [];
    var chain = Promise.resolve();
    jobs.forEach(function (row) {
      chain = chain.then(function () {
        return window.processCredentialArchive(row, row.pdf_path, "repair", function (stage) {
          result.textContent = row.holder_name + ": " + stage;
        }).then(function (job) {
          reports.push(row.credential_id + ": " + (job.result.already_processed ? "Already processed" : "Completed"));
        }).catch(function (e) { reports.push(row.credential_id + ": Failed / requires attention — " + e.message); });
      });
    });
    chain.then(loadCredentials).then(function () {
      result.textContent = reports.length ? reports.join(" | ") : "No missing previews in the register. Use Manage PDF → Regenerate Preview to check or repair a broken image.";
    }).catch(function (e) { result.textContent = e.message; })
      .then(function () { button.disabled = false; });
  });
})();
