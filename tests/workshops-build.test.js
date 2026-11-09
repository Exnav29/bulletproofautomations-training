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

const contentDir = path.join(__dirname, "..", "content", "workshops");

test("the real content publishes exactly one bookable session: Get Paid for Automation, workshop 01", () => {
  // These values must equal the workshop_sessions row; /api/workshops/register refuses a mismatch.
  const live = ws.loadSessions(contentDir).filter((s) => s.status === "published");
  assert.deepEqual(live.map((s) => s.slug), ["what-to-charge-for-automation"]);
  const s = live[0];
  assert.deepEqual([s.starts_at, s.duration_minutes, s.price_ghs, s.capacity, s.kind, s.time_zone],
    ["2026-12-12T11:30:00Z", 180, 350, 25, "workshop", "Africa/Accra"]);
  // 25 general places + 5 reserved for graduates = 30. GHS 280 with a Foundations certificate; graduates free.
  assert.deepEqual([s.reserved_graduate_seats, s.foundations_discount_pct, s.graduate_free, s.referral_discount_ghs, s.admission], [5, 20, true, 50, "invite"]);
  assert.equal(ws.when(s).accra, "11:30 AM");
  assert.equal(ws.when(s).lagos, "12:30 PM");
});

test("the series lists ten workshops; only workshop 01 is bookable and the nine planned ones carry no schedule", () => {
  const sessions = ws.loadSessions(contentDir);
  const [series] = ws.loadSeries(contentDir, sessions);
  assert.equal(series.name, "Get Paid for Automation");
  assert.deepEqual(series.entries.map((e) => e.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(series.entries.filter((e) => e.session).map((e) => e.number), [1]);
  for (const e of series.entries.slice(1)) {
    assert.equal(e.status, "planned");
    for (const key of ["starts_at", "price_ghs", "capacity", "duration_minutes", "date"]) assert.equal(e[key], undefined, e.slug + " has " + key);
  }
});

test("series pages: the directory, one detail page with a form, nine coming-soon pages with none", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ws-series-"));
  const sessions = ws.loadSessions(contentDir);
  const paths = ws.render(sessions, out, ws.loadSeries(contentDir, sessions));
  assert.equal(paths.length, 11);
  const read = (p) => fs.readFileSync(path.join(out, p, "index.html"), "utf8");
  const dir = read("workshops");
  assert.match(dir, /<h1>Get Paid for Automation<\/h1>/);
  assert.equal((dir.match(/Coming soon/g) || []).length, 9);
  assert.match(dir, /none of their owners sponsors, endorses or is affiliated/);
  assert.doesNotMatch(dir, /data-ws-form/);
  const w01 = read("workshops/what-to-charge-for-automation");
  assert.match(w01, /data-ws-form/);
  assert.match(w01, /data-price="350"/);
  assert.match(w01, /Get Paid for Automation, workshop 01, with Johnathan Lightfoot/);
  assert.match(w01, /11:30 AM in Accra<br>12:30 PM in Lagos/);
  for (const p of paths.filter((x) => x !== "/workshops" && x !== "/workshops/what-to-charge-for-automation")) {
    const html = read(p.slice(1));
    assert.match(html, /data-ws-page="planned"/, p);
    assert.doesNotMatch(html, /data-ws-form|data-slug=|data-price=|GHS |Register and pay/, p + " must not be bookable");
    assert.match(html, /not taking registrations/, p);
    assert.match(html, /href="\/workshops\/what-to-charge-for-automation"/, p + " links to the bookable workshop");
  }
});

test("a planned workshop with a date, fee or capacity fails the build", () => {
  const sessions = ws.loadSessions(contentDir);
  const series = JSON.parse(fs.readFileSync(path.join(contentDir, "series", "get-paid-for-automation.json"), "utf8"));
  const seriesFile = path.join("/x/content/workshops/series", "get-paid-for-automation.json");
  for (const extra of [{ starts_at: "2027-01-09T11:30:00Z" }, { price_ghs: 250 }, { capacity: 25 }]) {
    const copy = JSON.parse(JSON.stringify(series));
    Object.assign(copy.entries[1], extra);
    assert.throws(() => ws.validateSeries(copy, seriesFile, sessions), /must not carry/, JSON.stringify(extra));
  }
  const unpublished = JSON.parse(JSON.stringify(series));
  unpublished.entries[0].session = "no-such-session";
  assert.throws(() => ws.validateSeries(unpublished, seriesFile, sessions), /not a published session/);
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

test("a joining link or joining field in any content file fails the build, draft or published", () => {
  // The repository is public. Joining details live only on the database row.
  for (const change of [
    { join_instructions: "See you there" },
    { description: "Join at https://meet.google.com/abc-defg-hij" },
    { faq: [{ q: "Link?", a: "https://us02web.zoom.us/j/123" }] },
  ]) {
    for (const status of ["published", "draft"]) {
      const s = Object.assign(sample(), change, { status });
      assert.throws(() => ws.validate(s, file(s.slug)), /joining|meeting link/, status + " " + JSON.stringify(change));
    }
  }
  const series = { slug: "s", name: "S", presenter: "P", positioning: "x", intro: ["x"], standalone: "x",
    disclaimer: "x", entries: [{ number: 1, status: "planned", slug: "a", title: "A", headline: "h", problem: "p",
      audience: "a", outcomes: ["o"], series_fit: "Join on https://meet.google.com/abc-defg-hij" }] };
  assert.throws(() => ws.validateSeries(series, "/x/series/s.json", []), /meeting link/);
  // And the real content carries none.
  const raw = fs.readdirSync(contentDir, { recursive: true }).filter((f) => String(f).endsWith(".json"))
    .map((f) => fs.readFileSync(path.join(contentDir, String(f)), "utf8")).join("\n");
  assert.doesNotMatch(raw, /meet\.google\.com|join_instructions/);
});

test("refund policy: paid forms link to section 23 of the existing /refund-policy page, whose version is the one registrations record", () => {
  const s = ws.validate(sample(), file("sample-webinar"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pol-"));
  const paths = ws.render([s], out, []);
  assert.equal(ws.POLICY_HREF, "/refund-policy#workshops");
  assert.equal(paths.some((p) => /refund-policy/.test(p)), false, "no separate policy page");
  assert.equal(fs.existsSync(path.join(out, "workshops/refund-policy")), false);
  assert.match(fs.readFileSync(path.join(out, "workshops/sample-webinar/index.html"), "utf8"), /href="\/refund-policy#workshops">refund policy/);
  const page = fs.readFileSync(path.join(__dirname, "..", "refund-policy/index.html"), "utf8");
  const terms = /TERMS_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(__dirname, "..", "functions/api/_workshops.js"), "utf8"))[1];
  const section = page.slice(page.indexOf('id="workshops"'));
  assert.ok(page.includes('id="workshops"') && page.includes('href="#workshops"'), "section 23 and its contents entry");
  assert.match(section, new RegExp("Version " + terms + "\\."), "the section's version is the terms version registrations record");
  // The cohort terms are untouched: all 22 sections, in order, before the workshop section.
  for (let n = 1; n <= 22; n++) assert.ok(page.indexOf('<span class="policy__n">' + n + '.</span>') < page.indexOf('id="workshops"'), "section " + n);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "docs/workshops-refund-policy-draft.json")), false, "one copy of the text");
});

test("invitation-only sessions ask for the Google account to join with; others do not", () => {
  const live = ws.loadSessions(contentDir).filter((s) => s.status === "published");
  assert.equal(live[0].admission, "invite", "workshop 01 is joined by Google Calendar invitation");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ws-adm-"));
  ws.render(live, out, ws.loadSeries(contentDir, ws.loadSessions(contentDir)));
  const w01 = fs.readFileSync(path.join(out, "workshops/what-to-charge-for-automation/index.html"), "utf8");
  assert.match(w01, /name="attend_email" type="email"[^>]*required/);
  assert.match(w01, /Google account to join with/);
  assert.doesNotMatch(w01, /calendar file/, "the invitation is the calendar entry");
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "ws-adm-"));
  ws.render([ws.validate(sample(), file("sample-webinar"))], other);
  assert.doesNotMatch(fs.readFileSync(path.join(other, "workshops/sample-webinar/index.html"), "utf8"), /attend_email/);
  assert.throws(() => ws.validate(Object.assign(sample(), { admission: "door" }), file("sample-webinar")), /admission must be/);
});
