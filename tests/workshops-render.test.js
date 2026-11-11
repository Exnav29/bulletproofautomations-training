/* functions/api/_workshop_pages.js: which sessions get a page, and what the
 * page says. Since release 6 pages render from database rows on request.
 *   node --test tests/workshops-render.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../functions/api/_workshop_pages.js");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "workshop-rows.json"), "utf8"));
const NOW = Date.parse("2026-11-11T00:00:00Z");
const clone = (x) => JSON.parse(JSON.stringify(x));

test("the real rows publish one bookable workshop and nine coming-soon pages, in the series order", async () => {
  const p = await load();
  const cat = p.catalog(data.real, data.series, NOW);
  assert.deepEqual(cat.listed.map((s) => s.slug), ["what-to-charge-for-automation"]);
  assert.equal(cat.planned.length, 9);
  assert.deepEqual(cat.series[0].entries.map((e) => e.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const w01 = p.route("/workshops/what-to-charge-for-automation", cat);
  assert.match(w01.body, /data-ws-form/);
  assert.match(w01.body, /data-price="350"/);
  assert.equal(p.when(cat.listed[0]).accra, "11:30 AM");
  assert.equal(p.when(cat.listed[0]).lagos, "12:30 PM");
  for (const s of cat.planned) {
    const page = p.route("/workshops/" + s.slug, cat);
    assert.match(page.body, /data-ws-page="planned"/);
    assert.doesNotMatch(page.body, /data-ws-form|GHS/, s.slug + ": no form and no fee before a date is set");
  }
  assert.equal(p.paths(cat).length, 11, "the directory, workshop 01 and nine coming-soon pages");
});

test("drafts that are not announced, past sessions and unknown addresses have no page", async () => {
  const p = await load();
  const rows = clone(data.real);
  rows[1].announce = false;
  const cat = p.catalog(rows, data.series, NOW);
  assert.equal(p.route("/workshops/" + rows[1].slug, cat), null);
  assert.equal(p.route("/workshops/nothing-here", cat), null);
  assert.equal(p.route("/workshops/a/b", cat), null);
  // The day after workshop 01 runs it is past: no page, but it stays in its series as plain text.
  const after = p.catalog(data.real, data.series, Date.parse("2026-12-13T00:00:00Z"));
  assert.equal(p.route("/workshops/what-to-charge-for-automation", after), null);
  assert.match(p.route("/workshops", after).body, /<span>You know automation\. Do you know what to charge\?<\/span>/);
});

test("a closed or cancelled session keeps its page but leaves the listings", async () => {
  const p = await load();
  for (const status of ["closed", "cancelled"]) {
    const rows = clone(data.real);
    rows[0].status = status;
    const cat = p.catalog(rows, data.series, NOW);
    assert.ok(p.route("/workshops/what-to-charge-for-automation", cat), status + " still explains itself");
    assert.equal(cat.listed.length, 0);
    assert.equal(p.paths(cat).includes("/workshops/what-to-charge-for-automation"), false);
  }
});

test("content is escaped, and the page fills the shell", async () => {
  const p = await load();
  const rows = clone(data.samples);
  rows[0].title = '<script>alert("x")</script>';
  const cat = p.catalog(rows, [], NOW);
  const page = p.route("/workshops/" + rows[0].slug, cat);
  assert.doesNotMatch(page.body, /<script>alert/);
  const html = p.fill("<title>__WS_TITLE__</title><link href=\"__WS_CANONICAL__\"><!-- ws-body -->", page);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /https:\/\/training\.bulletproofautomations\.com\/workshops\/sample-webinar/);
  assert.doesNotMatch(html, /__WS_|ws-body/);
  assert.match(p.fill("</head>", p.registeredPage()), /noindex/);
});

test("refund policy: paid forms link to section 23 of the existing /refund-policy page, whose version is the one registrations record", async () => {
  const p = await load();
  const cat = p.catalog(data.samples, [], NOW);
  const detail = p.route("/workshops/sample-webinar", cat).body;
  assert.equal(p.POLICY_HREF, "/refund-policy#workshops");
  assert.match(detail, /href="\/refund-policy#workshops">webinar and workshop refund terms<\/a>\. I understand a paid registration is non-refundable/);
  assert.match(detail, /<input type="checkbox" name="ack_terms" required>/);
  const page = fs.readFileSync(path.join(__dirname, "..", "refund-policy/index.html"), "utf8");
  const terms = /TERMS_VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(__dirname, "..", "functions/api/_workshops.js"), "utf8"))[1];
  const section = page.slice(page.indexOf('id="workshops"'));
  assert.ok(page.includes('id="workshops"') && page.includes('href="#workshops"'), "section 23 and its contents entry");
  assert.match(section, new RegExp("Version " + terms + "\\."));
  for (let n = 1; n <= 22; n++) assert.ok(page.indexOf('<span class="policy__n">' + n + '.</span>') < page.indexOf('id="workshops"'), "section " + n);
});

test("invitation-only sessions ask for the Google account to join with; others do not", async () => {
  const p = await load();
  const cat = p.catalog(data.real.concat(data.samples), data.series, NOW);
  const w01 = p.route("/workshops/what-to-charge-for-automation", cat).body;
  assert.match(w01, /name="attend_email" type="email"[^>]*required/);
  const other = p.route("/workshops/sample-webinar", cat).body;
  assert.doesNotMatch(other, /attend_email/);
});

test("certificate and referral wording: anyone's referral code, and the certificate email applies at once", async () => {
  const p = await load();
  const w01 = p.route("/workshops/what-to-charge-for-automation", p.catalog(data.real, data.series, NOW)).body;
  assert.match(w01, /GHS 300 with a referral code/);
  assert.match(w01, /From someone's referral link or code: GHS 300/);
  assert.match(w01, /Applied straight away if the email above is the one on your certificate/);
  assert.doesNotMatch(w01, /graduate's referral|Intermediate graduate's link/);
});

test("the request handler never selects a private column", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "functions", "workshops", "[[path]].js"), "utf8");
  const cols = /SESSION_COLUMNS = "([^;]+);/.exec(src)[1];
  assert.doesNotMatch(cols, /join_instructions|calendar_event_id|admin_notes|\*/);
});
