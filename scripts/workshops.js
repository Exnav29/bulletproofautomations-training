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
 *     item, no sitemap entry. There is no empty or coming-soon page.
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
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith(".json"); }).sort().map(function (f) {
    const file = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (err) { throw new Error("content/workshops/" + f + ": not valid JSON (" + err.message + ")"); }
    return validate(data, file, now);
  });
}

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
function kindLabel(s) { return s.kind === "workshop" ? "Workshop" : "Webinar"; }
function cta(s) { return s.price_ghs === 0 ? "Register for free" : "Register and pay " + fee(s); }

/* ---------------------------------------------------------------------------
   Shared fragments
   ------------------------------------------------------------------------- */
function head(title, description, canonical) {
  return '<!-- include: head.html title="' + esc(title) + '" description="' + esc(description) + '" canonical="' + esc(canonical) + '" -->\n' +
    '<link rel="preload" href="/assets/fonts/eb-garamond-600.woff2" as="font" type="font/woff2" crossorigin>\n' +
    '<link rel="preload" href="/assets/fonts/bpa-reading-400.woff2" as="font" type="font/woff2" crossorigin>\n' +
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
    '  <dt>Fee</dt><dd>' + esc(fee(s)) + (s.price_ghs > 0 ? '<small>MoMo or card, through Paystack</small>' : '') + '</dd>\n' +
    (s.capacity ? '  <dt>Places</dt><dd>' + esc(s.capacity) + ' people</dd>\n' : '') +
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
    ['email', 'Confirmation email', 'Your joining link and a calendar file'],
    ['join', 'Join live', w.long + ', ' + w.accra + ' in Accra']
  ].filter(Boolean);
  return '<ol class="ws-trace" data-trace>\n' + steps.map(function (st, i) {
    return '  <li class="ws-step' + (i === 0 ? ' is-active' : ' is-idle') + '" data-step="' + st[0] + '">' +
      '<span class="ws-step__dot" aria-hidden="true">' + (i + 1) + '</span>' +
      '<div class="ws-step__body"><p class="ws-step__name">' + esc(st[1]) + '</p>' +
      '<p class="ws-step__detail" data-step-detail>' + esc(st[2]) + '</p></div></li>';
  }).join("\n") + '\n</ol>';
}

function form(s) {
  return '<form class="ws-form" data-ws-form novalidate>\n' +
    '  <div class="ws-field"><label for="ws-name">Full name</label><input id="ws-name" name="full_name" type="text" autocomplete="name" required maxlength="120"></div>\n' +
    '  <div class="ws-field"><label for="ws-email">Email <span class="ws-hint">Your joining link goes here</span></label><input id="ws-email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="160"></div>\n' +
    '  <div class="ws-field"><label for="ws-wa">WhatsApp <span class="ws-hint">Optional</span></label><input id="ws-wa" name="whatsapp" type="tel" autocomplete="tel" inputmode="tel" maxlength="40" placeholder="+233"></div>\n' +
    '  <label class="ws-check" data-wa-consent hidden><input type="checkbox" name="whatsapp_consent"> <span>Send me session reminders on WhatsApp.</span></label>\n' +
    '  <label class="ws-check"><input type="checkbox" name="ack_terms" required> <span>I agree to the <a href="/privacy">privacy notice</a>' +
    (s.price_ghs > 0 ? ' and the <a href="/refund-policy">refund policy</a>' : '') + '.</span></label>\n' +
    '  <div class="ws-hp" aria-hidden="true"><label for="ws-company">Company website</label><input id="ws-company" name="company_website" type="text" tabindex="-1" autocomplete="off"></div>\n' +
    '  <p class="ws-error" data-ws-error role="alert" hidden></p>\n' +
    '  <button class="ws-btn ws-btn--block" type="submit" data-ws-submit>' + esc(cta(s)) + '</button>\n' +
    (s.price_ghs > 0 ? '  <p class="ws-note">You pay on Paystack\'s secure page. Your place is confirmed once Paystack confirms the payment.</p>\n' : '') +
    '</form>';
}

/* ---------------------------------------------------------------------------
   Pages
   ------------------------------------------------------------------------- */
function detailPage(s) {
  const w = when(s);
  const url = ORIGIN + "/workshops/" + s.slug;
  const ins = INSTRUCTORS[s.instructor || "johnathan"];
  const run = (s.run_of_show || []).length
    ? '<section class="ws-sec" aria-labelledby="ws-plan"><h2 id="ws-plan">The ' + esc(duration(s.duration_minutes)) + '</h2>\n<ol class="ws-run">' +
      s.run_of_show.map(function (r) {
        return '<li><span class="ws-run__at">' + esc(r.at) + '</span><div><b>' + esc(r.title) + '</b>' + (r.detail ? '<span>' + esc(r.detail) + '</span>' : '') + '</div></li>';
      }).join("") + '</ol></section>'
    : '';
  const faq = (s.faq || []).length
    ? '<section class="ws-sec" aria-labelledby="ws-faq"><h2 id="ws-faq">Questions</h2>' +
      s.faq.map(function (f) { return '<details class="ws-faq"><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>'; }).join("") + '</section>'
    : '';
  const body =
'<main id="main" class="ws" data-ws-page="detail" data-slug="' + esc(s.slug) + '" data-price="' + esc(s.price_ghs) + '" data-starts="' + esc(new Date(s.starts_at).toISOString()) + '" data-title="' + esc(s.title) + '">\n' +
'<div class="ws-wrap ws-layout">\n<div class="ws-main">\n' +
'  <p class="ws-crumbs"><a href="/workshops">Webinars and workshops</a></p>\n' +
'  <section class="ws-hero" aria-labelledby="ws-title">\n' +
'    <div><p class="ws-kind">' + esc(kindLabel(s)) + ' with ' + esc(ins.name) + '</p>\n' +
'    <h1 class="ws-title" id="ws-title">' + esc(s.title) + '</h1>\n' +
'    <p class="ws-lede">' + esc(s.summary) + '</p></div>\n' +
'    ' + factsList(s, w) + '\n' +
'    <p class="ws-jump"><a class="ws-btn ws-btn--block" href="#register">' + esc(cta(s)) + '</a></p>\n' +
'  </section>\n' +
'  <div class="ws-content">\n' +
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
'    <p class="ws-small">Attending a webinar or workshop is training. It is not a certification and does not count towards one.</p>\n' +
'  </div>\n</div>\n' +
'<aside class="ws-aside" id="register" aria-labelledby="ws-reg">\n' +
'  <div class="ws-sheet" data-ws-sheet>\n' +
'    <h2 id="ws-reg">Register</h2>\n' +
'    <p class="ws-sumline">' + esc(w.long) + ', ' + esc(w.gmt) + ' GMT. ' + esc(fee(s)) + '.</p>\n' +
'    <p class="ws-banner" data-ws-banner role="status" hidden></p>\n' +
'    ' + trace(s, w).replace(/\n/g, "\n    ") + '\n' +
'    ' + form(s).replace(/\n/g, "\n    ") + '\n' +
'    <div class="ws-after" data-ws-after hidden></div>\n' +
'  </div>\n</aside>\n</div>\n' +
'<div class="ws-stickybar" data-ws-sticky hidden><a class="ws-btn ws-btn--block" href="#register">' + esc(cta(s)) + '</a></div>\n</main>';
  return page(s.title + " — " + kindLabel(s) + " — Bulletproof Automations Training", s.description, url, body);
}

function directoryPage(list) {
  const rows = list.map(function (s) {
    const w = when(s);
    return '<li class="ws-row">\n' +
      '  <div class="ws-row__date"><b>' + esc(w.day) + '</b><span>' + esc(w.mon) + ', ' + esc(w.wd) + '</span></div>\n' +
      '  <div class="ws-row__text"><h2><a href="/workshops/' + esc(s.slug) + '">' + esc(s.title) + '</a></h2>\n' +
      '  <p class="ws-row__meta">' + esc(kindLabel(s)) + ', ' + esc(duration(s.duration_minutes)) + ', ' + esc(w.accra) + ' in Accra' + (s.capacity ? ', ' + esc(s.capacity) + ' places' : '') + '</p>\n' +
      '  <p class="ws-row__out">' + esc(s.directory_line) + '</p></div>\n' +
      '  <div class="ws-row__side"><span class="ws-row__fee">' + esc(fee(s)) + '</span><a class="ws-btn ws-btn--small" href="/workshops/' + esc(s.slug) + '" aria-label="View details: ' + esc(s.title) + '">View details</a></div>\n' +
      '</li>';
  }).join("\n");
  const body = '<main id="main" class="ws" data-ws-page="directory">\n<div class="ws-wrap">\n' +
    '<div class="ws-dir-head"><h1>Webinars and workshops</h1>\n' +
    '<p>Live sessions with Johnathan Lightfoot. Each one builds one working automation you can use the next day. Attending is training, not a certification.</p></div>\n' +
    '<ul class="ws-rows">\n' + rows + '\n</ul>\n</div>\n</main>';
  return page("Webinars and workshops — Bulletproof Automations Training",
    "Live, instructor-led webinars and workshops on practical automation, with dates, times in Accra and Lagos, and fees in cedis.",
    ORIGIN + "/workshops", body);
}

function registeredPage() {
  const body = '<main id="main" class="ws" data-ws-page="registered">\n<div class="ws-wrap ws-done" data-ws-done>\n' +
    '  <h1 data-done-title>Checking your registration</h1>\n' +
    '  <p class="ws-lede" data-done-lede>One moment while we confirm with our records.</p>\n' +
    '  <div data-done-body></div>\n' +
    '  <noscript><p class="ws-lede">Your confirmation email has your joining details. If it has not arrived within ten minutes, check spam, then WhatsApp +233 54 652 7779.</p></noscript>\n' +
    '  <p class="ws-small">Questions? WhatsApp <a href="https://wa.me/233546527779">+233 54 652 7779</a> or email <a href="mailto:info@bulletproofautomations.com">info@bulletproofautomations.com</a>.</p>\n' +
    '</div>\n</main>';
  return page("Your registration — Bulletproof Automations Training",
    "Registration status for a Bulletproof Automations webinar or workshop.",
    ORIGIN + "/workshops/registered", body);
}

/* Writes the pages into outDir/workshops and returns the public paths. */
function render(sessions, outDir) {
  const live = sessions.filter(function (s) { return s.status === "published"; })
    .sort(function (a, b) { return Date.parse(a.starts_at) - Date.parse(b.starts_at); });
  if (!live.length) return [];
  const base = path.join(outDir, "workshops");
  fs.mkdirSync(path.join(base, "registered"), { recursive: true });
  fs.writeFileSync(path.join(base, "index.html"), directoryPage(live));
  fs.writeFileSync(path.join(base, "registered", "index.html"),
    registeredPage().replace("</head>", '<meta name="robots" content="noindex">\n</head>'));
  const paths = ["/workshops"];
  for (const s of live) {
    fs.mkdirSync(path.join(base, s.slug), { recursive: true });
    fs.writeFileSync(path.join(base, s.slug, "index.html"), detailPage(s));
    paths.push("/workshops/" + s.slug);
  }
  return paths;
}

module.exports = { loadSessions, validate, render, when, fee, ORIGIN };
