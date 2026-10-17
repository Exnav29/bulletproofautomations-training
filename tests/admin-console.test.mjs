import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const pages = ["overview", "enrollments", "payments", "credentials", "studio", "verification"];
const paths = Object.fromEntries(pages.map((p) => [
  p, p === "overview" ? "dist/admin/index.html" : "dist/admin/" + p + "/index.html"
]));
const essentialIds = [
  "signin","signin-form","dash","cohort","refresh","csv","signout",
  "board","queues","mix","rows","drawer","drawer-form",
  "pay-board","pay-rows","pdrawer","cred-rows","issue-form",
  "credential-archive-dialog","archive-file","archive-batch-files",
  "preview-repair-btn","enq-rows","certificate-studio","studio-open"
];
const script = fs.readFileSync("assets/js/admin-console.js", "utf8");
const css = fs.readFileSync("assets/css/admin-console.css", "utf8");

for (const page of pages) {
  const html = fs.readFileSync(paths[page], "utf8");
  assert.match(html, new RegExp('data-admin-view="' + page + '"'));
  assert.equal((html.match(/data-ops-link=/g) || []).length, 6);
  assert.equal((html.match(/data-ops-view=/g) || []).length, 6);
  for (const id of essentialIds) {
    assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1,
      "Missing/duplicate legacy " + id + " on " + page);
  }
  assert.ok(html.includes('href="/assets/css/admin-console.css?v=20261017-b"'));
  assert.ok(html.includes('/assets/js/admin-console.js?v=20261017-a'));
  const url = "https://training.bulletproofautomations.com/admin/" +
    (page === "overview" ? "" : page + "/");
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  const w = dom.window;
  w.eval(script);
  const active = [...w.document.querySelectorAll("[data-ops-link][aria-current='page']")];
  assert.equal(active.length, 1, "Exactly one active navigation entry for " + page);
  assert.equal(active[0].dataset.opsLink, page);
  assert.equal(w.document.getElementById("ops-page-title").textContent.length > 2, true);
  dom.window.close();
}
assert.match(css, /html\[data-admin-view="payments"\] \[data-ops-view="payments"\]/);
assert.match(css, /@media\(max-width:750px\)/);
assert.match(css, /prefers-reduced-motion/);

{
  const html = fs.readFileSync(paths.credentials, "utf8");
  const dom = new JSDOM(html, {
    url: "https://training.bulletproofautomations.com/admin/credentials/?q=BPA-FND-2026-WHXRTT",
    runScripts:"outside-only"
  });
  dom.window.eval(script);
  assert.equal(dom.window.document.getElementById("cq").value, "BPA-FND-2026-WHXRTT");
  dom.window.close();
}
{
  const html = fs.readFileSync(paths.enrollments, "utf8");
  const dom = new JSDOM(html, {
    url:"https://training.bulletproofautomations.com/admin/enrollments/?flag=unpaid",
    runScripts:"outside-only"
  });
  dom.window.eval(script);
  assert.equal(dom.window.document.getElementById("f-flag").value, "unpaid");
  dom.window.close();
}
const admin = fs.readFileSync("assets/js/admin.js", "utf8");
const studio = fs.readFileSync("assets/js/admin-studio.js", "utf8");
assert.match(admin, /\/admin\/studio\/\?correction=/);
assert.match(admin, /holderCell\.appendChild\(quickCorrection\)/);
assert.match(admin, /\/admin\/enrollments\/\?flag=/);
assert.match(studio, /window\.openStudioCorrection/);
assert.match(studio, /admin:authenticated/);
assert.match(studio, /root\.dataset\.routeOpen/);
console.log("PASS: 6 independent routes, consistent authenticated DOM, navigation, deep links, responsive styles and audited certificate-correction routing.");
