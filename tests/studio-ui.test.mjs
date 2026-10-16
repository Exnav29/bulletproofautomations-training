import { JSDOM } from "jsdom";
import fs from "node:fs";
import assert from "node:assert/strict";
const dom = new JSDOM(fs.readFileSync("admin/index.html", "utf8"), {
    url: "https://training.bulletproofautomations.com/admin",
    runScripts: "outside-only",
  }),
  w = dom.window;
w.HTMLElement.prototype.scrollIntoView = function () {};
w.URL.createObjectURL = () => "blob:test";
w.URL.revokeObjectURL = () => {};
w.confirm = () => true;
let calls = [],
  m = {
    courses: [],
    cohorts: [],
    batches: [],
    graduates: [],
    deliveries: [],
    enrollments: [
      {
        id: "student",
        full_name: "Enrolled Student",
        email: "controlled@example.com",
      },
    ],
    audit: [],
  };
w.authFetch = async (_url, opts) => {
  const { action, data } = JSON.parse(opts.body);
  calls.push({ action, data });
  let result = {};
  if (action === "health") result = { email_configured: false };
  if (action === "list") result = structuredClone(m);
  if (action === "course") {
    m.courses.push({ id: "course1", data: data.course });
    result = { id: "course1" };
  }
  if (action === "cohort") {
    m.cohorts.push({
      id: "cohort1",
      course_id: data.course_id,
      data: data.cohort,
    });
    result = { id: "cohort1" };
  }
  if (action === "batch") {
    m.batches.push({
      id: "batch1",
      cohort_id: "cohort1",
      state: "draft",
      revision: 1,
      snapshot: {
        course_name: m.courses[0].data.name,
        cohort_name: m.cohorts[0].data.name,
      },
    });
    result = { id: "batch1" };
  }
  if (action === "graduates")
    m.graduates.push(
      ...data.graduates.map((g, i) => ({
        id: "g" + (m.graduates.length + i),
        batch_id: "batch1",
        data: g,
        eligible: false,
        state: "draft",
      })),
    );
  if (action === "eligibility") {
    m.graduates.find((g) => g.id === data.id).eligible = data.eligible;
    m.batches[0].revision++;
  }
  if (action === "review")
    m.graduates.find((g) => g.id === data.id).reviewed_revision = data.revision;
  if (action === "proof")
    return { ok: true, blob: async () => new w.Blob(["proof"]) };
  if (action === "approve") m.batches[0].state = "approved";
  if (action === "issue") {
    m.graduates.find((g) => g.id === data.id).state = "issued";
    m.graduates.find((g) => g.id === data.id).credential_id =
      "BPA-TRN-2026-T3ST01";
    m.batches[0].state = "issued";
  }
  if (action === "print_pack" || action === "download")
    return { ok: true, blob: async () => new w.Blob(["PDF"]) };
  return { ok: true, json: async () => result };
};
w.eval(fs.readFileSync("assets/js/admin-studio.js", "utf8"));
const tick = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
async function click(label) {
  const b = [...w.document.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  assert.ok(b, "Missing button " + label);
  b.click();
  await tick();
}
function field(label, value) {
  const l = [...w.document.querySelectorAll("label")].find(
    (l) => l.textContent === label,
  );
  assert.ok(l, "Missing field " + label);
  w.document.getElementById(l.htmlFor).value = value;
}
await click("Create & Send Certificates");
assert.equal(w.document.getElementById("certificate-studio").hidden, false);
field("Course name", "UI Controlled Course");
field("Course code", "UI");
field("Completion requirements", "Demonstrated completion");
await click("Save course");
field("Cohort name", "Controlled session");
field("First session date", "2026-10-01");
field("Last session date", "2026-10-16");
await click("Save cohort");
await click("Create issuance batch →");
field("Exact full name", "Controlled Graduate");
await click("Add graduate");
const check = [...w.document.querySelectorAll("label")].find(
  (l) => l.textContent === "Approve completion eligibility",
);
const input = w.document.getElementById(check.htmlFor);
input.checked = true;
input.dispatchEvent(new w.Event("change"));
await tick();
await click("Review draft proofs →");
await click("Generate preview");
assert.ok(w.document.querySelector("img.studio-proof"));
await click("Mark proof reviewed");
await click("Continue to issuance →");
await click("Approve & Issue Certificates");
assert.equal(calls.filter((c) => c.action === "send_email").length, 0);
await click("Choose delivery →");
field("Delivery method", "print");
const select = [...w.document.querySelectorAll("label")].find(
  (l) => l.textContent === "Delivery method",
);
w.document.getElementById(select.htmlFor).dispatchEvent(new w.Event("change"));
await tick();
assert.ok(
  [...w.document.querySelectorAll("button")].some(
    (b) => b.textContent === "Print All Certificates",
  ),
);
assert.ok(
  ![...w.document.querySelectorAll("button")].some((b) =>
    b.textContent.includes("send this email"),
  ),
);
await click("Mark handed out");
assert.equal(
  calls.at(-2)?.action === "print" ||
    calls.some((c) => c.action === "print" && c.data.status === "handed_out"),
  true,
);
assert.equal(calls.filter((c) => c.action === "send_email").length, 0);
console.log(
  "PASS: actual admin DOM course/cohort wizard, manual print-only roster, eligibility, PDF proof gallery, explicit issuance, print-only no-email behavior and explicit handout tracking.",
);
w.close();
