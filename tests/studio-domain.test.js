const { test } = require("node:test"),
  assert = require("node:assert/strict");
const file = "../supabase/functions/certificate-studio/domain.mjs";
test("CSV handles BOM, quoted commas, escaped quotes, CRLF; consent is explicit", async () => {
  const { parseRoster } = await import(file);
  const g = parseRoster(
    '\uFEFFfull_name,email\r\n"Doe, Jane",jane@example.com\r\n"Joe ""JJ"" Smith",joe@example.com',
  );
  assert.equal(g[0].full_name, "Doe, Jane");
  assert.equal(g[1].full_name, 'Joe "JJ" Smith');
  assert.equal(g[0].publish_consent, false);
});
test("CSV rejects malformed, missing, duplicate and invalid email rows atomically", async () => {
  const { parseRoster } = await import(file);
  for (const csv of [
    "name,email\nJane,j@example.com",
    'full_name,email\n"Jane,j@example.com',
    "full_name,email\nJane,j@example.com\nJane,j@example.com",
    "full_name,email\nJane,broken",
  ])
    assert.throws(() => parseRoster(csv));
});
test("manual names and email validation include print-only graduates", async () => {
  const { validateGraduate } = await import(file);
  assert.equal(
    validateGraduate({ full_name: "Johnathan Lightfoot" }).email,
    "",
  );
  assert.throws(() => validateGraduate({ full_name: "J" }));
  assert.throws(() =>
    validateGraduate({
      full_name: "Jane",
      email: "a@example.com,b@example.com",
    }),
  );
});
test("one recipient and exactly matching PDF attachment with personalized details", async () => {
  const { emailMessage } = await import(file);
  const m = emailMessage(
    {
      full_name: "Jane Doe",
      email: "j@example.com",
      credential_id: "BPA-TRN-2026-ABC123",
    },
    { course_name: "Course", issue_date: "2026-10-16" },
    {
      subject: "Congratulations {{first_name}}",
      body: "{{name}} {{course}} {{credential_id}} {{url}}",
    },
  );
  assert.equal(m.to, "j@example.com");
  assert.equal(m.attachment_name, "BPA-TRN-2026-ABC123.pdf");
  assert.match(m.body, /Jane Doe Course BPA-TRN/);
  assert.equal(m.subject, "Congratulations Jane");
});

test("certificate course label avoids duplicated level", async () => {
  const { certificateCourseLabel } = await import(file);
  assert.equal(certificateCourseLabel("n8n Automation Studio: Intermediate", "Intermediate"), "n8n Automation Studio: Intermediate");
  assert.equal(certificateCourseLabel("n8n Foundations", "Beginner"), "n8n Foundations — Beginner");
  assert.equal(certificateCourseLabel("Automation Studio Intermediate", "Intermediate"), "Automation Studio Intermediate");
});
