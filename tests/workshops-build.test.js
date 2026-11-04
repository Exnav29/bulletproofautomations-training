/* scripts/workshops.js: validation guards and generated markup.
 *   node --test tests/workshops-build.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ws = require("../scripts/workshops.js");

const fixtureDir = path.join(__dirname, "fixtures", "workshops");
const sample = () => JSON.parse(fs.readFileSync(path.join(fixtureDir, "sample-webinar.json"), "utf8"));
const file = (slug) => path.join("/x/content/workshops", slug + ".json");

test("the real content directory publishes nothing today", () => {
  const live = ws.loadSessions(path.join(__dirname, "..", "content", "workshops")).filter((s) => s.status === "published");
  assert.equal(live.length, 0, "no real session has been supplied; nothing may publish");
});

test("fixtures validate and render a directory, detail and confirmation page", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const paths = ws.render(ws.loadSessions(fixtureDir), out);
  assert.deepEqual(paths, ["/workshops", "/workshops/sample-webinar", "/workshops/sample-free"]);
  const detail = fs.readFileSync(path.join(out, "workshops/sample-webinar/index.html"), "utf8");
  assert.match(detail, /data-price="150"/);
  assert.match(detail, /data-starts="2099-11-21T11:30:00.000Z"/);
  assert.match(detail, /11:30 AM in Accra<br>12:30 PM in Lagos/);
  assert.match(detail, /Register and pay GHS 150/);
  assert.match(detail, /refund-policy/);
  assert.match(detail, /data-step="pay"/);
  assert.match(detail, /not a certification/);
  const free = fs.readFileSync(path.join(out, "workshops/sample-free/index.html"), "utf8");
  assert.match(free, /Register for free/);
  assert.doesNotMatch(free, /data-step="pay"/, "a free session has no payment step");
  const registered = fs.readFileSync(path.join(out, "workshops/registered/index.html"), "utf8");
  assert.match(registered, /name="robots" content="noindex"/);
});

test("drafts never render, and nothing published means nothing emitted", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const draft = Object.assign(sample(), { status: "draft" });
  assert.deepEqual(ws.render([ws.validate(draft, file(draft.slug))], out), []);
  assert.equal(fs.existsSync(path.join(out, "workshops")), false);
});

test("a published file with a placeholder, TBC or missing field fails the build", () => {
  for (const change of [{ title: "[SESSION TITLE]" }, { summary: "Agenda TBC" }, { price_ghs: undefined }, { leave_with: [] }]) {
    const s = Object.assign(sample(), change);
    assert.throws(() => ws.validate(s, file(s.slug)), /content\/workshops/, JSON.stringify(change));
  }
});

test("a past or offset-less start time is refused for a published session", () => {
  assert.throws(() => ws.validate(Object.assign(sample(), { starts_at: "2020-01-01T10:00:00Z" }), file("sample-webinar")), /already started/);
  assert.throws(() => ws.validate(Object.assign(sample(), { starts_at: "2099-01-01T10:00:00" }), file("sample-webinar")), /time zone offset/);
});

test("file name must match slug, and content is escaped", () => {
  assert.throws(() => ws.validate(sample(), file("other-name")), /file name must match slug/);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
  const s = Object.assign(sample(), { title: "Invoices <script>alert(1)</script> & you" });
  ws.render([ws.validate(s, file(s.slug))], out);
  const html = fs.readFileSync(path.join(out, "workshops/sample-webinar/index.html"), "utf8");
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /Invoices &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; you/);
});
