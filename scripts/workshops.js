/* Webinar and workshop pages, generated at build time from content/workshops/*.json.
 *
 * Why a generator and not hand-written pages: every session needs the same
 * page, and a new session must not need a rebuild of the site. One JSON file
 * per scheduled delivery is the whole authoring step.
 *
 * What it guarantees, so a bad file cannot reach an advert:
 *   - only status "published" files render; drafts never ship;
 *   - a published file with a missing field, a past date or any [BRACKETED]
 *     placeholder fails the build rather than publishing;
 *   - with nothing published, NOTHING is emitted: no /workshops route, no nav
 *     item, no sitemap entry. There is no empty page;
 *   - a series (content/workshops/series/*.json) may also list workshops that
 *     are still being planned. A planned entry is copy only: the validator
 *     refuses a date, fee or capacity on it, it has no database row and its
 *     page has no form, so it can never take a registration or a payment.
 *
 * The page states the price and time it was built with (data-price,
 * data-starts). The database is authoritative: /api/workshops/register
 * refuses a registration whose displayed price or start disagrees with it,
 * so a stale page can never charge a number the visitor did not see.
 *
 * Exports are used by scripts/build.js and by tests/workshops-build.test.js. */

const fs = require("fs");
const path = require("path");

const ORIGIN = "https://training.bulletproofautomations.com";
const REQUIRED = ["slug", "status", "kind", "title", "summary", "directory_line", "starts_at", "duration_minutes",
  "format", "price_ghs", "audience", "leave_with", "good_fit", "not_fit", "bring", "description"];

const INSTRUCTORS = {
  johnathan: {
    name: "Johnathan Lightfoot",
    bio: "Founder of Bulletproof Automations. Three decades in systems integration and technology leadership as a CTO and CIO, and a former U.S. Navy Operations Specialist.",
    photo: "/assets/images/about/johnathan-tall-480"
  }
};

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* Joining details are private: they live only on the session's database row
   and are emailed to confirmed participants. This repository is public, so a
   joining link in any content file, draft or not, fails the build. */
const MEETING_LINK = /https?:\/\/([a-z0-9-]+\.)*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com|webex\.com)\b/i;
function privateProblems(data) {
  const problems = [];
  if (/"join_(instructions|url|link)"/.test(JSON.stringify(data))) problems.push("joining details belong on the database row, never in a content file");
  walkStrings(data, function (text) { if (MEETING_LINK.test(text)) problems.push("meeting link in a content file: joining links are private"); });
  return problems;
}

function walkStrings(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) value.forEach(function (v) { walkStrings(v, visit); });
  else if (value && typeof value === "object") Object.keys(value).forEach(function (k) { walkStrings(value[k], visit); });
}

/* Throws with every problem in one message. `now` is injectable for tests. */
function validate(s, file, now) {
  const problems = [];
  for (const key of REQUIRED) {
    if (s[key] === undefined || s[key] === null || s[key] === "" || (Array.isArray(s[key]) && !s[key].length)) {
      problems.push("missing " + key);
    }
  }
  if (s.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.slug)) problems.push("slug must be lowercase words joined by hyphens");
  if (s.slug && path.basename(file, ".json") !== s.slug) problems.push("file name must match slug");
  if (s.status && !["draft", "published"].includes(s.status)) problems.push("status must be draft or published");
  if (s.kind && !["webinar", "workshop"].includes(s.kind)) problems.push("kind must be webinar or workshop");
  if (s.starts_at && isNaN(Date.parse(s.starts_at))) problems.push("starts_at must be an ISO date-time with offset");
  if (s.starts_at && !/(Z|[+-]\d\d:\d\d)$/.test(s.starts_at)) problems.push("starts_at must include a time zone offset");
  if (s.price_ghs !== undefined && !(typeof s.price_ghs === "number" && s.price_ghs >= 0)) problems.push("price_ghs must be a number, 0 for free");
  if (s.duration_minutes !== undefined && !(Number.isInteger(s.duration_minutes) && s.duration_minutes >= 15)) problems.push("duration_minutes must be a whole number of minutes");
  if (s.capacity !== undefined && s.capacity !== null && !(Number.isInteger(s.capacity) && s.capacity > 0)) problems.push("capacity must be a positive whole number");
  if (s.run_of_show && !s.run_of_show.every(function (r) { return r && r.at && r.title; })) problems.push("each run_of_show item needs at and title");
  if (s.instructor && !INSTRUCTORS[s.instructor]) problems.push("unknown instructor " + s.instructor);
  if (s.admission !== undefined && !["link", "invite"].includes(s.admission)) problems.push("admission must be link or invite");
  // Certificate-holder prices. The database row carries the same values and
  // decides every price; these only describe it on the page.
  if (s.foundations_discount_pct !== undefined && !(Number.isInteger(s.foundations_discount_pct) && s.foundations_discount_pct >= 0 && s.foundations_discount_pct <= 100)) problems.push("foundations_discount_pct must be a whole number from 0 to 100");
  if (s.reserved_graduate_seats !== undefined && !(Number.isInteger(s.reserved_graduate_seats) && s.reserved_graduate_seats >= 0)) problems.push("reserved_graduate_seats must be a whole number");
  if (s.graduate_free !== undefined && typeof s.graduate_free !== "boolean") problems.push("graduate_free must be true or false");
  if (s.graduate_free && !s.reserved_graduate_seats) problems.push("graduate_free needs reserved_graduate_seats");
  if (s.referral_discount_ghs !== undefined && !(typeof s.referral_discount_ghs === "number" && s.referral_discount_ghs >= 0 && s.referral_discount_ghs < (s.price_ghs || 0))) problems.push("referral_discount_ghs must be a number below price_ghs");
  problems.push.apply(problems, privateProblems(s));
  if (s.status === "published") {
    walkStrings(s, function (text) {
      if (/\[[A-Z0-9 ,.$:'\-]{2,}\]/.test(text)) problems.push("placeholder left in published file: " + text.slice(0, 60));
      if (/TODO|TBC|TBD|lorem ipsum/i.test(text)) problems.push("unfinished text in published file: " + text.slice(0, 60));
    });
    if (s.starts_at && Date.parse(s.starts_at) <= (now || Date.now())) problems.push("published session has already started; set it to draft");
  }
  if (problems.length) throw new Error("content/workshops/" + path.basename(file) + ": " + problems.join("; "));
  return s;
}

function loadSessions(dir, now) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith(".json") && f !== "refund-policy.json"; }).sort().map(function (f) {
    const file = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (err) { throw new Error("content/workshops/" + f + ": not valid JSON (" + err.message + ")"); }
    return validate(data, file, now);
  });
}

/* ---------------------------------------------------------------------------
   Series. One file groups sessions under one name and lists the workshops
   still being planned, in order. An entry is either
     { "number": 1, "session": "<slug of a published session file>" }  bookable
     { "number": 2, "status": "planned", "slug": ..., ... }              copy only
   ------------------------------------------------------------------------- */
const SERIES_REQUIRED = ["slug", "name", "presenter", "positioning", "intro", "standalone", "disclaimer", "entries"];
const PLANNED_REQUIRED = ["slug", "title", "headline", "problem", "audience", "outcomes", "series_fit"];
// A planned workshop has no schedule yet. Any of these would be an invented fact.
const PLANNED_FORBIDDEN = ["starts_at", "price_ghs", "capacity", "duration_minutes", "time_zone", "format", "date", "seats"];

function validateSeries(series, file, sessions) {
  const problems = [];
  for (const key of SERIES_REQUIRED) {
    if (series[key] === undefined || series[key] === null || series[key] === "" || (Array.isArray(series[key]) && !series[key].length)) problems.push("missing " + key);
  }
  if (series.slug && path.basename(file, ".json") !== series.slug) problems.push("file name must match slug");
  const published = new Set(sessions.filter(function (s) { return s.status === "published"; }).map(function (s) { return s.slug; }));
  const taken = new Set(sessions.map(function (s) { return s.slug; }).concat(["registered"]));
  (series.entries || []).forEach(function (e, i) {
    const label = "entry " + (i + 1);
    if (e.number !== i + 1) problems.push(label + ": number must be " + (i + 1));
    if (e.session !== undefined) {
      if (!published.has(e.session)) problems.push(label + ": session " + e.session + " is not a published session file; publish it or make the entry planned");
      return;
    }
    if (e.status !== "planned") problems.push(label + ": needs a session slug or status planned");
    for (const key of PLANNED_REQUIRED) {
      if (e[key] === undefined || e[key] === null || e[key] === "" || (Array.isArray(e[key]) && !e[key].length)) problems.push(label + ": missing " + key);
    }
    for (const key of PLANNED_FORBIDDEN) if (e[key] !== undefined) problems.push(label + ": a planned workshop must not carry " + key);
    if (e.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.slug)) problems.push(label + ": slug must be lowercase words joined by hyphens");
    if (e.slug && taken.has(e.slug)) problems.push(label + ": slug " + e.slug + " is already used");
    if (e.slug) taken.add(e.slug);
  });
  problems.push.apply(problems, privateProblems(series));
  walkStrings(series, function (text) {
    if (/\[[A-Z0-9 ,.$:'\-]{2,}\]/.test(text)) problems.push("placeholder left in series: " + text.slice(0, 60));
    if (/TODO|TBC|TBD|lorem ipsum/i.test(text)) problems.push("unfinished text in series: " + text.slice(0, 60));
  });
  if (problems.length) throw new Error("content/workshops/series/" + path.basename(file) + ": " + problems.join("; "));
  return series;
}

function loadSeries(dir, sessions) {
  const seriesDir = path.join(dir, "series");
  if (!fs.existsSync(seriesDir)) return [];
  return fs.readdirSync(seriesDir).filter(function (f) { return f.endsWith(".json"); }).sort().map(function (f) {
    const file = path.join(seriesDir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (err) { throw new Error("content/workshops/series/" + f + ": not valid JSON (" + err.message + ")"); }
    return validateSeries(data, file, sessions);
  });
}

/* ---------------------------------------------------------------------------
   The webinar and workshop refund policy (content/workshops/refund-policy.json).
   Until the owner approves the wording ("approved": true) nothing is published
   and paid forms keep linking to /refund-policy, exactly as before. Once
   approved, /workshops/refund-policy is built and every paid form links to it.
   ------------------------------------------------------------------------- */
const POLICY_HREF = "/workshops/refund-policy";
function loadPolicy(dir) {
  const file = path.join(dir, "refund-policy.json");
  if (!fs.existsSync(file)) return null;
  let p;
  try { p = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { throw new Error("content/workshops/refund-policy.json: not valid JSON (" + err.message + ")"); }
  const problems = [];
  if (typeof p.approved !== "boolean") problems.push("approved must be true or false");
  for (const key of ["title", "version", "intro", "sections"]) if (!p[key] || (Array.isArray(p[key]) && !p[key].length)) problems.push("missing " + key);
  (p.sections || []).forEach(function (sec, i) {
    if (!sec || !sec.heading || !Array.isArray(sec.paragraphs) || !sec.paragraphs.length) problems.push("section " + (i + 1) + " needs heading and paragraphs");
  });
  if (p.legal_review !== undefined && !["pending", "complete"].includes(p.legal_review)) problems.push("legal_review must be pending or complete");
  // The owner approves the wording only after the legal review is complete.
  if (p.approved && p.legal_review !== "complete") problems.push("an approved policy needs legal_review complete");
  if (p.approved) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.version))) problems.push("an approved policy's version is its effective date, YYYY-MM-DD");
    walkStrings(p, function (text) {
      if (/\[[A-Z0-9 ,.$:'\-]{2,}\]/.test(text)) problems.push("placeholder left in approved policy: " + text.slice(0, 60));
      if (/TODO|TBC|TBD|DRAFT|lorem ipsum/.test(text)) problems.push("unfinished text in approved policy: " + text.slice(0, 60));
    });
  }
  if (problems.length) throw new Error("content/workshops/refund-policy.json: " + problems.join("; "));
  return p;
}

function policyHref(policy) { return policy && policy.approved ? POLICY_HREF : "/refund-policy"; }

function policyPage(p) {
  const body =
'<main id="main" class="ws" data-ws-page="policy">\n' +
'<div class="ws-wrap">\n<div class="ws-main">\n' +
'  <p class="ws-crumbs"><a href="/workshops">Webinars and workshops</a></p>\n' +
'  <section class="ws-hero" aria-labelledby="ws-title"><div>\n' +
'    <h1 class="ws-title" id="ws-title">' + esc(p.title) + '</h1>\n' +
'    <p class="ws-lede">' + esc(p.intro) + '</p>\n' +
'    <p class="ws-small">Version ' + esc(p.version) + '</p>\n' +
'  </div></section>\n' +
'  <div class="ws-content">\n' +
      p.sections.map(function (sec, i) {
        return '    <section class="ws-sec" aria-labelledby="ws-p' + (i + 1) + '"><h2 id="ws-p' + (i + 1) + '">' + esc(sec.heading) + '</h2>' +
          sec.paragraphs.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join("") + '</section>\n';
      }).join("") +
'  </div>\n</div>\n</div>\n</main>';
  return page(p.title + " — Bulletproof Automations Training",
    "How refunds, transfers and cancellations work for paid Bulletproof Automations webinars and workshops.",
    ORIGIN + POLICY_HREF, body);
}

/* The series and entry a session belongs to, if any. */
function membership(seriesList, slug) {
  for (const series of seriesList || []) {
    const entry = series.entries.find(function (e) { return e.session === slug; });
    if (entry) return { series: series, entry: entry };
  }
  return null;
}
function num(n) { return n < 10 ? "0" + n : String(n); }

/* ---------------------------------------------------------------------------
   Formatting. Times are shown in Accra (GMT) and Lagos (WAT, GMT+1), the two
   audiences, computed from the one stored instant.
   ------------------------------------------------------------------------- */
function fmt(iso, tz, opts) {
  return new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: tz }, opts)).format(new Date(iso));
}
function when(s) {
  const tz = s.time_zone || "Africa/Accra";
  const clock = { hour: "numeric", minute: "2-digit", hour12: true };
  return {
    long: fmt(s.starts_at, tz, { weekday: "long", day: "numeric", month: "long" }),
    year: fmt(s.starts_at, tz, { year: "numeric" }),
    day: fmt(s.starts_at, tz, { day: "numeric" }),
    mon: fmt(s.starts_at, tz, { month: "short" }),
    wd: fmt(s.starts_at, tz, { weekday: "short" }),
    accra: fmt(s.starts_at, "Africa/Accra", clock).toUpperCase(),
    lagos: fmt(s.starts_at, "Africa/Lagos", clock).toUpperCase(),
    gmt: fmt(s.starts_at, "UTC", clock).toUpperCase()
  };
}
function duration(min) {
  if (min % 60 === 0) return min / 60 === 1 ? "1 hour" : min / 60 + " hours";
  return min + " minutes";
}
function fee(s) { return s.price_ghs === 0 ? "Free" : "GHS\u00a0" + s.price_ghs.toLocaleString("en-GB"); }
// Same rounding as workshop_register: to the pesewa.
function foundationsFee(s) {
  return "GHS\u00a0" + (Math.round(s.price_ghs * (100 - s.foundations_discount_pct)) / 100).toLocaleString("en-GB");
}
function hasBenefits(s) { return s.price_ghs > 0 && (s.foundations_discount_pct > 0 || s.graduate_free === true); }
function referralFee(s) { return "GHS " + (s.price_ghs - s.referral_discount_ghs).toLocaleString("en-GB"); }
function kindLabel(s) { return s.kind === "workshop" ? "Workshop" : "Webinar"; }
function cta(s) { return s.price_ghs === 0 ? "Register for free" : "Register and pay " + fee(s); }

/* ---------------------------------------------------------------------------
   Shared fragments
   ------------------------------------------------------------------------- */
function head(title, description, canonical) {
  return '<!-- include: head.html title="' + esc(title) + '" description="' + esc(description) + '" canonical="' + esc(canonical) + '" -->\n' +
    '<link rel="preload" href="/assets/fonts/eb-garamond-600.woff2" as="font" type="font/woff2" crossorigin>\n' +
    '<link rel="stylesheet" href="/assets/css/workshops.css">\n' +
    '<script src="/assets/js/workshop-tracking.js" defer></script>\n' +
    '<script src="/assets/js/workshops.js" defer></script>';
}

const CONSENT_BAR =
  '<aside class="ws-consent" aria-label="Advert measurement" data-ad-consent hidden>\n' +
  '  <p>Can we measure which adverts bring people here? This uses Meta\'s tracking and sets cookies. Registration works the same either way.</p>\n' +
  '  <div class="ws-consent__actions"><button class="ws-btn ws-btn--small" type="button" data-ad-consent-allow>Allow</button>' +
  '<button class="ws-btn ws-btn--small ws-btn--quiet" type="button" data-ad-consent-deny>No thanks</button></div>\n' +
  '  <p class="ws-consent__more"><a href="/privacy">How we use this</a></p>\n' +
  '</aside>';

function page(title, description, canonical, body, extraBodyAttrs) {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' + head(title, description, canonical) + '\n</head>\n' +
    '<body class="ws-body"' + (extraBodyAttrs || "") + '>\n<!-- include: header.html nav="workshops" -->\n' +
    body + '\n' + CONSENT_BAR + '\n<!-- include: footer.html -->\n</body>\n</html>\n';
}

function factsList(s, w) {
  return '<dl class="ws-facts">\n' +
    '  <dt>When</dt><dd><span class="ws-date">' + esc(w.long) + '</span><small>' + esc(w.accra) + ' in Accra<br>' + esc(w.lagos) + ' in Lagos</small></dd>\n' +
    '  <dt>Length</dt><dd>' + esc(duration(s.duration_minutes)) + ', ' + esc(s.format) + '</dd>\n' +
    '  <dt>Fee</dt><dd>' + esc(fee(s)) + (s.price_ghs > 0 ? '<small>MoMo or card, through Paystack</small>' : '') +
      (s.referral_discount_ghs > 0 ? '<small>' + esc(referralFee(s)) + ' with a graduate\'s referral code</small>' : '') +
      (s.foundations_discount_pct > 0 ? '<small>' + esc(foundationsFee(s)) + ' with a Foundations certificate</small>' : '') +
      (s.graduate_free ? '<small>Free for eligible Intermediate graduates</small>' : '') + '</dd>\n' +
    (s.capacity ? '  <dt>Places</dt><dd>' + esc(s.capacity + (s.reserved_graduate_seats || 0)) + ' people' +
      (s.reserved_graduate_seats ? '<small>' + esc(s.capacity) + ' open places and ' + esc(s.reserved_graduate_seats) + ' reserved for Intermediate graduates</small>' : '') + '</dd>\n' : '') +
    '  <dt>For</dt><dd>' + esc(s.audience) + '</dd>\n</dl>';
}

/* The payment trace: one ordered list whose steps change state. The page
   ships it in its starting state; assets/js/workshops.js moves it on only
   from server answers. */
function trace(s, w) {
  const paid = s.price_ghs > 0;
  const steps = [
    ['register', 'Your details', 'About a minute'],
    paid ? ['pay', 'Pay ' + fee(s), 'On Paystack\'s secure page, with mobile money or card'] : null,
    s.admission === "invite"
      ? ['email', 'Confirmation, then your invitation', 'We add your Google account to the workshop invitation, and Google emails you the Meet link']
      : ['email', 'Confirmation email', 'Your joining link and a calendar file'],
    ['join', 'Join live', w.long + ', ' + w.accra + ' in Accra']
  ].filter(Boolean);
  return '<ol class="ws-trace" data-trace>\n' + steps.map(function (st, i) {
    return '  <li class="ws-step' + (i === 0 ? ' is-active' : ' is-idle') + '" data-step="' + st[0] + '">' +
      '<span class="ws-step__dot" aria-hidden="true">' + (i + 1) + '</span>' +
      '<div class="ws-step__body"><p class="ws-step__name">' + esc(st[1]) + '</p>' +
      '<p class="ws-step__detail" data-step-detail>' + esc(st[2]) + '</p></div></li>';
  }).join("\n") + '\n</ol>';
}

function form(s, policy) {
  return '<form class="ws-form" data-ws-form novalidate>\n' +
    '  <div class="ws-field"><label for="ws-name">Full name</label><input id="ws-name" name="full_name" type="text" autocomplete="name" required maxlength="120"></div>\n' +
    '  <div class="ws-field"><label for="ws-email">Email <span class="ws-hint">' + (s.admission === "invite" ? "Your confirmation goes here" : "Your joining link goes here") + '</span></label><input id="ws-email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="160"></div>\n' +
    (s.admission === "invite"
      ? '  <div class="ws-field"><label for="ws-attend">Google account to join with <span class="ws-hint">Only this account can get into the meeting. It can differ from the email above</span></label><input id="ws-attend" name="attend_email" type="email" autocomplete="email" inputmode="email" required maxlength="160"></div>\n'
      : '') +
    (s.referral_discount_ghs > 0
      ? '  <div class="ws-field"><label for="ws-ref">Referral code <span class="ws-hint">Optional. From an Intermediate graduate\'s link or code: ' + esc(referralFee(s)) + '</span></label>' +
        '<input id="ws-ref" name="ref" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" data-ws-ref></div>\n'
      : '') +
    (hasBenefits(s)
      ? '  <div class="ws-field" data-ws-cert><label for="ws-cert">Certificate ID <span class="ws-hint">Optional. ' +
        (s.foundations_discount_pct > 0 ? 'Foundations certificate: ' + esc(foundationsFee(s)) + '. ' : '') +
        (s.graduate_free ? 'Intermediate graduates: free, in a reserved place. ' : '') +
        'We email a code to the address on your certificate</span></label>' +
        '<input id="ws-cert" name="certificate_id" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="BPA-">' +
        '<button class="ws-btn ws-btn--small ws-btn--quiet" type="button" data-ws-cert-send>Send me a code</button>' +
        '<div data-ws-cert-code hidden><label for="ws-cert-code">Code from the email <span class="ws-hint">6 digits, valid for 10 minutes</span></label>' +
        '<input id="ws-cert-code" name="cert_code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6">' +
        '<button class="ws-btn ws-btn--small" type="button" data-ws-cert-confirm>Confirm code</button></div>' +
        '<p class="ws-hint" data-ws-cert-status role="status"></p></div>\n'
      : '') +
    '  <div class="ws-field"><label for="ws-wa">WhatsApp <span class="ws-hint">Optional</span></label><input id="ws-wa" name="whatsapp" type="tel" autocomplete="tel" inputmode="tel" maxlength="40" placeholder="+233"></div>\n' +
    '  <label class="ws-check" data-wa-consent hidden><input type="checkbox" name="whatsapp_consent"> <span>Send me session reminders on WhatsApp.</span></label>\n' +
    '  <label class="ws-check"><input type="checkbox" name="ack_terms" required> <span>I agree to the <a href="/privacy">privacy notice</a>' +
    (s.price_ghs > 0 ? ' and the <a href="' + policyHref(policy) + '">refund policy</a>' : '') + '.</span></label>\n' +
    '  <div class="ws-hp" aria-hidden="true"><label for="ws-company">Company website</label><input id="ws-company" name="company_website" type="text" tabindex="-1" autocomplete="off"></div>\n' +
    '  <p class="ws-error" data-ws-error role="alert" hidden></p>\n' +
    (s.referral_discount_ghs > 0 || hasBenefits(s) ? '  <p class="ws-note" data-ws-quote aria-live="polite">You pay ' + esc(fee(s)) + '.</p>\n' : '') +
    '  <button class="ws-btn ws-btn--block" type="submit" data-ws-submit>' + esc(cta(s)) + '</button>\n' +
    (s.price_ghs > 0 ? '  <p class="ws-note">You pay on Paystack\'s secure page. Your place is confirmed once Paystack confirms the payment.</p>\n' : '') +
    '</form>';
}

/* ---------------------------------------------------------------------------
   Pages
   ------------------------------------------------------------------------- */
function detailPage(s, seriesList, live, policy) {
  const w = when(s);
  const member = membership(seriesList, s.slug);
  const url = ORIGIN + "/workshops/" + s.slug;
  const ins = INSTRUCTORS[s.instructor || "johnathan"];
  const run = (s.run_of_show || []).length
    ? '<section class="ws-sec" aria-labelledby="ws-plan"><h2 id="ws-plan">The ' + esc(duration(s.duration_minutes)) + '</h2>\n<ol class="ws-run">' +
      s.run_of_show.map(function (r) {
        return '<li><span class="ws-run__at">' + esc(r.at) + '</span><div><b>' + esc(r.title) + '</b>' + (r.detail ? '<span>' + esc(r.detail) + '</span>' : '') + '</div></li>';
      }).join("") + '</ol></section>'
    : '';
  const why = (s.why || []).length
    ? '<section class="ws-sec" aria-labelledby="ws-why"><h2 id="ws-why">Why this ' + esc(kindLabel(s).toLowerCase()) + '</h2>' +
      s.why.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join("") + '</section>'
    : '';
  const outcomes = (s.outcomes || []).length
    ? '<section class="ws-sec" aria-labelledby="ws-learn"><h2 id="ws-learn">What you will be able to do</h2><ol class="ws-list ws-list--num">' +
      s.outcomes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ol></section>'
    : '';
  const inSeries = member
    ? '<section class="ws-sec" aria-labelledby="ws-series"><h2 id="ws-series">Part of ' + esc(member.series.name) + '</h2>' +
      '<p>' + esc(member.series.standalone) + '</p>' + seriesItems(member.series, live, member.entry.number) + '</section>'
    : '';
  const faq = (s.faq || []).length
    ? '<section class="ws-sec" aria-labelledby="ws-faq"><h2 id="ws-faq">Questions</h2>' +
      s.faq.map(function (f) { return '<details class="ws-faq"><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>'; }).join("") + '</section>'
    : '';
  const body =
'<main id="main" class="ws" data-ws-page="detail" data-slug="' + esc(s.slug) + '" data-price="' + esc(s.price_ghs) + '" data-starts="' + esc(new Date(s.starts_at).toISOString()) + '" data-title="' + esc(s.title) + '">\n' +
'<div class="ws-wrap ws-layout">\n<div class="ws-main">\n' +
'  <p class="ws-crumbs"><a href="/workshops">' + esc(member ? member.series.name : "Webinars and workshops") + '</a></p>\n' +
'  <section class="ws-hero" aria-labelledby="ws-title">\n' +
'    <div><p class="ws-kind">' + (member
      ? esc(member.series.name) + ', ' + esc(kindLabel(s).toLowerCase()) + ' ' + num(member.entry.number) + ', with ' + esc(ins.name)
      : esc(kindLabel(s)) + ' with ' + esc(ins.name)) + '</p>\n' +
'    <h1 class="ws-title" id="ws-title">' + esc(s.title) + '</h1>\n' +
'    <p class="ws-lede">' + esc(s.summary) + '</p></div>\n' +
'    ' + factsList(s, w) + '\n' +
'    <p class="ws-jump"><a class="ws-btn ws-btn--block" href="#register">' + esc(cta(s)) + '</a></p>\n' +
'  </section>\n' +
'  <div class="ws-content">\n' +
(why ? '    ' + why + '\n' : '') +
(outcomes ? '    ' + outcomes + '\n' : '') +
'    <section class="ws-sec" aria-labelledby="ws-leave"><h2 id="ws-leave">What you leave with</h2><ul class="ws-list">' +
      s.leave_with.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul></section>\n' +
'    ' + run + '\n' +
'    <section class="ws-sec" aria-labelledby="ws-fit"><h2 id="ws-fit">Is this for you</h2><div class="ws-two">' +
      '<div><h3>Good fit</h3><p>' + esc(s.good_fit) + '</p></div><div><h3>Not a fit</h3><p>' + esc(s.not_fit) + '</p></div></div>' +
      '<p><b>Bring:</b> ' + esc(s.bring) + '</p></section>\n' +
'    <section class="ws-sec" aria-labelledby="ws-teach"><h2 id="ws-teach">Who teaches it</h2><div class="ws-instructor">' +
      '<picture><source srcset="' + ins.photo + '.avif" type="image/avif"><source srcset="' + ins.photo + '.webp" type="image/webp">' +
      '<img src="' + ins.photo + '.jpg" alt="' + esc(ins.name) + '" width="88" height="110" loading="lazy" decoding="async"></picture>' +
      '<div><b>' + esc(ins.name) + '</b><p>' + esc(ins.bio) + '</p><p><a href="/about">More about ' + esc(ins.name.split(" ")[0]) + '</a></p></div></div></section>\n' +
'    ' + faq + '\n' +
(inSeries ? '    ' + inSeries + '\n' : '') +
(member ? '    <p class="ws-small">' + esc(member.series.disclaimer) + '</p>\n' : '') +
'    <p class="ws-small">Attending a webinar or workshop is training. It is not a certification and does not count towards one.</p>\n' +
'  </div>\n</div>\n' +
'<aside class="ws-aside" id="register" aria-labelledby="ws-reg">\n' +
'  <div class="ws-sheet" data-ws-sheet>\n' +
'    <h2 id="ws-reg">Register</h2>\n' +
'    <p class="ws-sumline">' + esc(w.long) + ', ' + esc(w.gmt) + ' GMT. ' + esc(fee(s)) + '.</p>\n' +
'    <p class="ws-banner" data-ws-banner role="status" hidden></p>\n' +
'    ' + trace(s, w).replace(/\n/g, "\n    ") + '\n' +
'    ' + form(s, policy).replace(/\n/g, "\n    ") + '\n' +
'    <div class="ws-after" data-ws-after hidden></div>\n' +
'  </div>\n</aside>\n</div>\n' +
'<div class="ws-stickybar" data-ws-sticky hidden><a class="ws-btn ws-btn--block" href="#register">' + esc(cta(s)) + '</a></div>\n</main>';
  return page(s.title + " — " + kindLabel(s) + " — Bulletproof Automations Training", s.description, url, body);
}

function directoryRow(s) {
    const w = when(s);
    return '<li class="ws-row">\n' +
      '  <div class="ws-row__date"><b>' + esc(w.day) + '</b><span>' + esc(w.mon) + ', ' + esc(w.wd) + '</span></div>\n' +
      '  <div class="ws-row__text"><h2><a href="/workshops/' + esc(s.slug) + '">' + esc(s.title) + '</a></h2>\n' +
      '  <p class="ws-row__meta">' + esc(kindLabel(s)) + ', ' + esc(duration(s.duration_minutes)) + ', ' + esc(w.accra) + ' in Accra' + (s.capacity ? ', ' + esc(s.capacity) + ' places' : '') + '</p>\n' +
      '  <p class="ws-row__out">' + esc(s.directory_line) + '</p></div>\n' +
      '  <div class="ws-row__side"><span class="ws-row__fee">' + esc(fee(s)) + '</span><a class="ws-btn ws-btn--small" href="/workshops/' + esc(s.slug) + '" aria-label="View details: ' + esc(s.title) + '">View details</a></div>\n' +
      '</li>';
}

function directoryPage(list) {
  const rows = list.map(directoryRow).join("\n");
  const body = '<main id="main" class="ws" data-ws-page="directory">\n<div class="ws-wrap">\n' +
    '<div class="ws-dir-head"><h1>Webinars and workshops</h1>\n' +
    '<p>Live sessions with Johnathan Lightfoot. Each one builds one working automation you can use the next day. Attending is training, not a certification.</p></div>\n' +
    '<ul class="ws-rows">\n' + rows + '\n</ul>\n</div>\n</main>';
  return page("Webinars and workshops — Bulletproof Automations Training",
    "Live, instructor-led webinars and workshops on practical automation, with dates, times in Accra and Lagos, and fees in cedis.",
    ORIGIN + "/workshops", body);
}

/* The series in order. The entry for the page being viewed is not a link. */
function seriesItems(series, live, current) {
  const bySlug = new Map((live || []).map(function (s) { return [s.slug, s]; }));
  return '<ol class="ws-series">' + series.entries.map(function (e) {
    const s = e.session ? bySlug.get(e.session) : null;
    const slug = s ? s.slug : e.slug;
    const title = s ? s.title : e.title;
    const line = s ? s.directory_line : e.headline;
    const w = s ? when(s) : null;
    const name = e.number === current
      ? '<span aria-current="page">' + esc(title) + '</span>'
      : '<a href="/workshops/' + esc(slug) + '">' + esc(title) + '</a>';
    return '<li class="ws-ser"><span class="ws-ser__n">' + num(e.number) + '</span>' +
      '<div class="ws-ser__text"><h3>' + name + '</h3><p>' + esc(line) + '</p></div>' +
      '<span class="ws-ser__tag' + (s ? ' is-date' : '') + '">' + esc(w ? w.wd + " " + w.day + " " + w.mon : "Coming soon") + '</span></li>';
  }).join("") + '</ol>';
}

/* The directory when a series exists: the series first, its bookable
   session featured, then the whole sequence, then any sessions outside it. */
function seriesDirectoryPage(series, live) {
  const inSeries = new Set(series.entries.map(function (e) { return e.session; }).filter(Boolean));
  const featured = live.filter(function (s) { return inSeries.has(s.slug); });
  const others = live.filter(function (s) { return !inSeries.has(s.slug); });
  const count = series.entries.length === 10 ? "ten" : String(series.entries.length);
  const body = '<main id="main" class="ws" data-ws-page="directory">\n<div class="ws-wrap">\n' +
    '<div class="ws-dir-head"><p class="ws-kind">A live workshop series from ' + esc(series.presenter) + '</p>\n' +
    '<h1>' + esc(series.name) + '</h1>\n' +
    '<p class="ws-dir-lede">' + esc(series.positioning) + '</p>\n' +
    series.intro.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join("\n") + '</div>\n' +
    (featured.length ? '<section class="ws-dir-sec" aria-labelledby="ws-next"><h2 class="ws-dir-h2" id="ws-next">Next workshop</h2>\n<ul class="ws-rows">\n' +
      featured.map(directoryRow).join("\n") + '\n</ul></section>\n' : '') +
    '<section class="ws-dir-sec" aria-labelledby="ws-all"><h2 class="ws-dir-h2" id="ws-all">The ' + esc(count) + ' workshops</h2>\n' +
    '<p>' + esc(series.standalone) + '</p>\n' + seriesItems(series, live, null) + '</section>\n' +
    (others.length ? '<section class="ws-dir-sec" aria-labelledby="ws-other"><h2 class="ws-dir-h2" id="ws-other">Other sessions</h2>\n<ul class="ws-rows">\n' +
      others.map(directoryRow).join("\n") + '\n</ul></section>\n' : '') +
    '<p class="ws-small ws-dir-note">' + esc(series.disclaimer) + ' Attending is training, not a certification.</p>\n' +
    '</div>\n</main>';
  return page(series.name + " — live workshops for automation practitioners — Bulletproof Automations Training",
    series.positioning + " Live workshops on pricing, finding clients, proposals and delivery, from " + series.presenter + ".",
    ORIGIN + "/workshops", body);
}

/* A workshop still being planned: copy, no date, no fee, no form. */
function plannedPage(series, e, live) {
  const first = series.entries.find(function (x) { return x.session; });
  const firstSession = first ? (live || []).find(function (s) { return s.slug === first.session; }) : null;
  const body =
'<main id="main" class="ws" data-ws-page="planned">\n' +
'<div class="ws-wrap ws-layout">\n<div class="ws-main">\n' +
'  <p class="ws-crumbs"><a href="/workshops">' + esc(series.name) + '</a></p>\n' +
'  <section class="ws-hero" aria-labelledby="ws-title">\n' +
'    <div><p class="ws-kind">' + esc(series.name) + ', workshop ' + num(e.number) + '</p>\n' +
'    <h1 class="ws-title" id="ws-title">' + esc(e.title) + '</h1>\n' +
'    <p class="ws-lede">' + esc(e.headline) + '</p>\n' +
'    <p class="ws-soon">Coming soon</p></div>\n' +
'  </section>\n' +
'  <div class="ws-content">\n' +
'    <section class="ws-sec" aria-labelledby="ws-problem"><h2 id="ws-problem">The problem it solves</h2><p>' + esc(e.problem) + '</p></section>\n' +
'    <section class="ws-sec" aria-labelledby="ws-who"><h2 id="ws-who">Who it is for</h2><p>' + esc(e.audience) + '</p></section>\n' +
'    <section class="ws-sec" aria-labelledby="ws-learn"><h2 id="ws-learn">What you will be able to do</h2><ol class="ws-list ws-list--num">' +
      e.outcomes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ol></section>\n' +
'    <section class="ws-sec" aria-labelledby="ws-series"><h2 id="ws-series">Where it fits in the series</h2><p>' + esc(e.series_fit) + '</p>' +
      seriesItems(series, live, e.number) + '</section>\n' +
'    <p class="ws-small">' + esc(series.disclaimer) + '</p>\n' +
'    <p class="ws-small">Attending a webinar or workshop is training. It is not a certification and does not count towards one.</p>\n' +
'  </div>\n</div>\n' +
'<aside class="ws-aside" aria-labelledby="ws-soon-h">\n' +
'  <div class="ws-sheet">\n' +
'    <h2 id="ws-soon-h">Coming soon</h2>\n' +
'    <p>This workshop does not have a date or a fee yet, and it is not taking registrations.</p>\n' +
(firstSession
  ? '    <p>Workshop 01, ' + esc(firstSession.title) + ', is on ' + esc(when(firstSession).long) + '.</p>\n' +
    '    <a class="ws-btn ws-btn--block" href="/workshops/' + esc(firstSession.slug) + '">See workshop 01</a>\n'
  : '') +
'    <a class="ws-btn ws-btn--block ws-btn--quiet" href="/workshops">See all ' + esc(series.entries.length) + ' workshops</a>\n' +
'  </div>\n</aside>\n</div>\n</main>';
  return page(e.title + " — " + series.name + ", workshop " + num(e.number) + " — Bulletproof Automations Training",
    series.name + ", workshop " + num(e.number) + ". " + e.headline + " Coming soon from " + series.presenter + ".",
    ORIGIN + "/workshops/" + e.slug, body);
}

function registeredPage() {
  const body = '<main id="main" class="ws" data-ws-page="registered">\n<div class="ws-wrap ws-done" data-ws-done>\n' +
    '  <h1 data-done-title>Checking your registration</h1>\n' +
    '  <p class="ws-lede" data-done-lede>One moment while we confirm with our records.</p>\n' +
    '  <div data-done-body></div>\n' +
    '  <noscript><p class="ws-lede">Your confirmation email has your joining details. If it has not arrived within ten minutes, check spam, then email info@bulletproofautomations.com.</p></noscript>\n' +
    '  <p class="ws-small">Questions? Reply to your confirmation email, or email <a href="mailto:info@bulletproofautomations.com">info@bulletproofautomations.com</a>.</p>\n' +
    '</div>\n</main>';
  return page("Your registration — Bulletproof Automations Training",
    "Registration status for a Bulletproof Automations webinar or workshop.",
    ORIGIN + "/workshops/registered", body);
}

/* Writes the pages into outDir/workshops and returns the public paths.
   A series only renders alongside at least one published session, so there
   is never a directory with nothing on it that can be booked. */
function render(sessions, outDir, seriesList, policy) {
  const live = sessions.filter(function (s) { return s.status === "published"; })
    .sort(function (a, b) { return Date.parse(a.starts_at) - Date.parse(b.starts_at); });
  if (!live.length) return [];
  const series = (seriesList || [])[0] || null;
  const base = path.join(outDir, "workshops");
  fs.mkdirSync(path.join(base, "registered"), { recursive: true });
  fs.writeFileSync(path.join(base, "index.html"), series ? seriesDirectoryPage(series, live) : directoryPage(live));
  fs.writeFileSync(path.join(base, "registered", "index.html"),
    registeredPage().replace("</head>", '<meta name="robots" content="noindex">\n</head>'));
  const paths = ["/workshops"];
  for (const s of live) {
    fs.mkdirSync(path.join(base, s.slug), { recursive: true });
    fs.writeFileSync(path.join(base, s.slug, "index.html"), detailPage(s, seriesList, live, policy));
    paths.push("/workshops/" + s.slug);
  }
  if (series) {
    for (const e of series.entries) {
      if (e.session) continue;
      fs.mkdirSync(path.join(base, e.slug), { recursive: true });
      fs.writeFileSync(path.join(base, e.slug, "index.html"), plannedPage(series, e, live));
      paths.push("/workshops/" + e.slug);
    }
  }
  if (policy && policy.approved && live.some(function (s) { return s.price_ghs > 0; })) {
    fs.mkdirSync(path.join(base, "refund-policy"), { recursive: true });
    fs.writeFileSync(path.join(base, "refund-policy", "index.html"), policyPage(policy));
    paths.push(POLICY_HREF);
  }
  return paths;
}

module.exports = { loadSessions, loadSeries, loadPolicy, validate, validateSeries, render, when, fee, ORIGIN, POLICY_HREF };
