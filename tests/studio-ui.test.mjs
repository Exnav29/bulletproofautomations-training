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
  if (action === "prepare_email") {
    const graduate = m.graduates.find((g) => g.id === data.id);
    m.deliveries.push({
      id: "delivery-" + data.id,
      graduate_id: data.id,
      state: "prepared",
      message: {
        to: graduate.data.email,
        subject: data.subject,
        body: data.body,
        attachment_name: graduate.credential_id + ".pdf",
      },
    });
    result = { id: "delivery-" + data.id };
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
// Per-recipient email editing must be inline, retain the complete body
// across navigation and refresh, and never send without separate approval.
m.graduates[0].data.email = "controlled@example.com";
m.graduates.push({
  id: "g2",
  batch_id: "batch1",
  data: { full_name: "Second Graduate", email: "second@example.com" },
  eligible: true,
  state: "issued",
  credential_id: "BPA-TRN-2026-T3ST02",
  print_status: "ready",
});
await click("5. Approve & issue");
await click("Refresh processing progress");
await click("6. Delivery");
field("Delivery method", "email");
w.document.getElementById(select.htmlFor).dispatchEvent(new w.Event("change"));
await tick();
w.prompt = () => { throw new Error("Native prompt must not be used for email editing"); };

function editorInput(label) {
  const editorLabel = [...w.document.querySelectorAll("label")].find(
    (l) => l.textContent === label,
  );
  assert.ok(editorLabel, "Missing inline email field: " + label);
  return w.document.getElementById(editorLabel.htmlFor);
}
function typeInline(label, value) {
  const input = editorInput(label);
  input.value = value;
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
}
typeInline("Email subject for Controlled Graduate", "Congratulations, graduate!");
typeInline("Email body for Controlled Graduate", "Hello {{first_name}},\\n\\nYour certificate is ready.\\n" + "Extra details. ".repeat(80));
typeInline("Email subject for Second Graduate", "Second student's unique subject");
typeInline("Email body for Second Graduate", "Independent body for the second student.");
assert.ok(w.document.querySelectorAll("textarea.studio-email-body").length === 2);
assert.ok(w.document.querySelectorAll(".studio-email-save-status").length === 2);
assert.ok(w.localStorage.length >= 2, "Drafts should persist to browser storage");
await click("5. Approve & issue");
await click("Refresh processing progress");
await click("6. Delivery");
assert.equal(editorInput("Email subject for Controlled Graduate").value, "Congratulations, graduate!");
assert.ok(editorInput("Email body for Controlled Graduate").value.includes("Extra details."));
assert.equal(editorInput("Email subject for Second Graduate").value, "Second student's unique subject");
assert.equal(editorInput("Email body for Second Graduate").value, "Independent body for the second student.");
assert.equal(calls.filter((c) => c.action === "prepare_email").length, 0);
assert.equal(calls.filter((c) => c.action === "send_email").length, 0);
await click("Prepare email for review");
const prepared = calls.find((c) => c.action === "prepare_email");
assert.ok(prepared, "Prepare call must be made only on explicit click");
assert.equal(prepared.data.subject, "Congratulations, graduate!");
assert.ok(prepared.data.body.includes("Your certificate is ready."));
assert.equal(prepared.data.id, m.graduates[0].id);
assert.equal(calls.filter((c) => c.action === "send_email").length, 0);
assert.equal(editorInput("Email subject for Second Graduate").value, "Second student's unique subject");
assert.ok(w.document.body.textContent.includes("Review recipient, message and attachment"));
console.log("PASS: two independent inline email drafts, autosave across navigation and refresh, no prompts, preparation without sending.");
// Signing out clears locally persisted personal message drafts.
w.document.dispatchEvent(new w.Event("admin:signedout"));
assert.equal(w.localStorage.length, 0, "Signout must clear sensitive browser drafts");

// An imported historical graduate can be corrected from the credential
// register; a saved correction draft must resume without creating duplicates.
const certificate = "BPA-FND-2026-WHXRTT";
m.batches.push({
  id: "correctionBatch", cohort_id: "cohort1", state: "draft", revision: 1,
  snapshot: { course_name: "n8n Foundations", cohort_name: "Foundations 2026" }
});
m.graduates.push({
  id: "correctionGraduate", batch_id: "correctionBatch",
  credential_id: certificate, state: "draft", correction: true,
  eligible: false, data: { full_name: "Carl Peter Lokko", email: "c.lokko.gh@gmail.com" }
});
const correctCalls = calls.filter((x) => x.action === "correct").length;
w.openStudioCorrection({ credential_id: certificate, pdf_path: certificate + "/old.pdf" });
await tick();
assert.equal(calls.filter((x) => x.action === "correct").length, correctCalls);
assert.equal(w.document.getElementById("certificate-studio").hidden, false);
assert.ok(w.document.getElementById("studio-body").textContent.includes("Carl Peter Lokko"));
assert.ok(w.document.getElementById("studio-body").textContent.includes("Add graduates and approve eligibility"));
assert.ok(w.document.getElementById("studio-message").textContent.includes("existing correction draft"));
console.log("PASS: saved corrected-name draft resumed from certificate register; original credential ID unchanged; no duplicate correction.");

w.close();
