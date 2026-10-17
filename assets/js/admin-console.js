/* Route-aware training operations console. Six real /admin/... pages use the
   same proven forms and business logic, never separate copies of state.
   No additional authentication, storage, or network service is introduced. */
(function () {
  "use strict";
  var view = document.documentElement.getAttribute("data-admin-view") || "overview";
  var pages = {
    overview: ["Overview", "What needs your attention today."],
    enrollments: ["Enrollments", "Students, follow-ups, cohorts and payment plans."],
    payments: ["Payments", "Every Paystack event, reconciliation and export in one place."],
    credentials: ["Credentials", "Issued records, corrections, document archives and revocations."],
    studio: ["Certificate Studio", "Create, approve, print and deliver your course certificates."],
    verification: ["Verification activity", "People and organizations checking issued credentials."]
  };
  if (!Object.prototype.hasOwnProperty.call(pages, view)) view = "overview";
  var title = document.getElementById("ops-page-title");
  var summary = document.getElementById("ops-page-summary");
  if (title) title.textContent = pages[view][0];
  if (summary) summary.textContent = pages[view][1];
  document.title = pages[view][0] + " | Bulletproof Automations Training";
  Array.prototype.forEach.call(document.querySelectorAll("[data-ops-link]"), function (link) {
    if (link.getAttribute("data-ops-link") === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  var params = new URLSearchParams(window.location.search);
  if (view === "credentials" && params.get("q")) {
    document.getElementById("cq").value = params.get("q").slice(0, 100);
  }
  if (view === "enrollments" && params.get("flag")) {
    var flag = document.getElementById("f-flag");
    var found = Array.prototype.some.call(flag.options, function (option) {
      return option.value === params.get("flag");
    });
    if (found) flag.value = params.get("flag");
  }
  // A genuine URL is supplied by the build for each page, so bookmarks,
  // refresh, keyboard links and middle-click all preserve the chosen section.
})();
