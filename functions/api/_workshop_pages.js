/* Webinar and workshop pages, rendered on request from the database.
 *
 * Release 6 moved page content from content/workshops/*.json onto the
 * workshop_sessions rows (content jsonb) and workshop_series, so a workshop
 * created or edited in /admin/workshops/ is live at once, with no deploy.
 * The markup is the release 1 generator's, unchanged, so assets/css/workshops.css
 * and assets/js/workshops.js work as before.
 *
 * Pure: no I/O. functions/workshops/[[path]].js loads the rows and the built
 * page shell; tests render straight from rows.
 *
 * What it guarantees, as the generator did:
 *   - only published (or closed or cancelled, so a shared link still explains
 *     itself) sessions that have not started get a page; drafts never do;
 *   - an announced draft is "coming soon": copy only, no date, no fee, no form;
 *   - the page states the price and time it was rendered with (data-price,
 *     data-starts) and /api/workshops/register refuses a mismatch;
 *   - joining details are never selected, so they cannot reach a page. */

export const ORIGIN = "https://training.bulletproofautomations.com";
export const POLICY_HREF = "/refund-policy#workshops";
const SHOWN = ["published", "closed", "cancelled"];

const INSTRUCTORS = {
  johnathan: {
    name: "Johnathan Lightfoot",
    bio: "Founder of Bulletproof Automations. Three decades in systems integration and technology leadership as a CTO and CIO, and a former U.S. Navy Operations Specialist.",
    photo: "/assets/images/about/johnathan-tall-480"
  }
};

export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const arr = function (v) { return Array.isArray(v) ? v.filter(function (x) { return x !== null && x !== ""; }) : []; };
const txt = function (v) { return typeof v === "string" ? v.trim() : ""; };

/* A database row (with its content) as the page model. */
export function fromRow(row, now) {
  const c = row.content && typeof row.content === "object" ? row.content : {};
  const s = {
    id: row.id, slug: row.slug, status: row.status, kind: row.kind, title: row.title,
    starts_at: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    duration_minutes: Number(row.duration_minutes) || 60, time_zone: row.time_zone || "Africa/Accra",
    format: row.format || "live online", price_ghs: Number(row.price_ghs) || 0,
    capacity: row.capacity == null ? null : Number(row.capacity), admission: row.admission || "link",
    reserved_graduate_seats: Number(row.reserved_graduate_seats) || 0,
    foundations_discount_pct: Number(row.foundations_discount_pct) || 0, graduate_free: row.graduate_free === true,
    referral_discount_ghs: Number(row.referral_discount_ghs) || 0, is_test: row.is_test === true,
    series_slug: row.series_slug || null, series_number: row.series_number == null ? null : Number(row.series_number),
    announce: row.announce === true,
    summary: txt(c.summary), directory_line: txt(c.directory_line) || txt(c.summary), description: txt(c.description) || txt(c.summary),
    audience: txt(c.audience), why: arr(c.why), outcomes: arr(c.outcomes), leave_with: arr(c.leave_with),
    run_of_show: arr(c.run_of_show).filter(function (r) { return r && txt(r.at) && txt(r.title); }),
    good_fit: txt(c.good_fit), not_fit: txt(c.not_fit), bring: txt(c.bring),
    faq: arr(c.faq).filter(function (f) { return f && txt(f.q) && txt(f.a); }),
    instructor: INSTRUCTORS[c.instructor] ? c.instructor : "johnathan",
    problem: txt(c.problem), series_fit: txt(c.series_fit)
  };
  s.past = !!s.starts_at && Date.parse(s.starts_at) <= (now || Date.now());
  return s;
}

/* Which sessions get a page, which are listed, and the series around them. */
export function catalog(rows, seriesRows, now) {
  const all = (rows || []).map(function (r) { return fromRow(r, now); });
  const live = all.filter(function (s) { return SHOWN.includes(s.status) && s.starts_at && !s.past; })
    .sort(function (a, b) { return Date.parse(a.starts_at) - Date.parse(b.starts_at); });
  const listed = live.filter(function (s) { return s.status === "published"; });
  const past = all.filter(function (s) { return s.status !== "draft" && s.past; });
  const planned = all.filter(function (s) { return s.status === "draft" && s.announce; });
  const series = (seriesRows || []).map(function (x) {
    const members = all.filter(function (s) { return s.series_slug === x.slug && s.series_number; })
      .filter(function (s) { return listed.includes(s) || planned.includes(s) || past.includes(s); })
      .sort(function (a, b) { return a.series_number - b.series_number; });
    return {
      slug: x.slug, name: x.name, presenter: x.presenter, positioning: x.positioning || "",
      intro: arr(x.intro), standalone: x.standalone || "", disclaimer: x.disclaimer || "",
      entries: members.map(function (s) {
        return s.status === "draft"
          ? { number: s.series_number, status: "planned", slug: s.slug, title: s.title, headline: s.summary, problem: s.problem,
              audience: s.audience, outcomes: s.outcomes, series_fit: s.series_fit }
          : { number: s.series_number, session: s.slug };
      })
    };
  }).filter(function (x) { return x.entries.length; });
  listed.past = past;
  return { all: all, live: live, listed: listed, past: past, planned: planned, series: series };
}

function membership(seriesList, slug) {
  for (const series of seriesList || []) {
    const entry = series.entries.find(function (e) { return e.session === slug || (e.status === "planned" && e.slug === slug); });
    if (entry) return { series: series, entry: entry };
  }
  return null;
}
function num(n) { return n < 10 ? "0" + n : String(n); }

/* ---------------------------------------------------------------------------
   Formatting. Times are shown in Accra (GMT) and Lagos (WAT, GMT+1).
   ------------------------------------------------------------------------- */
function fmt(iso, tz, opts) {
  return new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: tz }, opts)).format(new Date(iso));
}
export function when(s) {
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
    gmt: fmt(s.starts_at, "UTC", clock).toUpperCase(),
    // Registration closes 168 hours before the start; the database enforces it.
    closes: fmt(closesAt(s), "Africa/Accra", { weekday: "long", day: "numeric", month: "long" }) + ", " +
      fmt(closesAt(s), "Africa/Accra", clock).toUpperCase()
  };
}
function closesAt(s) { return new Date(Date.parse(s.starts_at) - 168 * 3600000).toISOString(); }
function duration(min) {
  if (min % 60 === 0) return min / 60 === 1 ? "1 hour" : min / 60 + " hours";
  return min + " minutes";
}
export function fee(s) { return s.price_ghs === 0 ? "Free" : "GHS " + s.price_ghs.toLocaleString("en-GB"); }
function foundationsFee(s) {
  return "GHS " + (Math.round(s.price_ghs * (100 - s.foundations_discount_pct)) / 100).toLocaleString("en-GB");
}
function hasBenefits(s) { return s.price_ghs > 0 && (s.foundations_discount_pct > 0 || s.graduate_free === true); }
function hasReferral(s) { return s.price_ghs > 0 && s.referral_discount_ghs > 0; }
function referralFee(s) { return "GHS " + Math.max(0, s.price_ghs - s.referral_discount_ghs).toLocaleString("en-GB"); }
function kindLabel(s) { return s.kind === "workshop" ? "Workshop" : "Webinar"; }
function cta(s) { return s.price_ghs === 0 ? "Register for free" : "Register and pay " + fee(s); }

function factsList(s, w) {
  return '<dl class="ws-facts">\n' +
    '  <dt>When</dt><dd><span class="ws-date">' + esc(w.long) + '</span><small>' + esc(w.accra) + ' in Accra<br>' + esc(w.lagos) + ' in Lagos</small></dd>\n' +
    '  <dt>Registration closes</dt><dd><strong>' + esc(w.closes) + ' in Accra</strong><small>Seven days before the start. No registrations after that, at any price.</small></dd>\n' +
    '  <dt>Length</dt><dd>' + esc(duration(s.duration_minutes)) + ', ' + esc(s.format) + '</dd>\n' +
    '  <dt>Fee</dt><dd>' + esc(fee(s)) + (s.price_ghs > 0 ? '<small>MoMo or card, through Paystack</small>' : '') +
      (hasReferral(s) ? '<small>' + esc(referralFee(s)) + ' with a referral code</small>' : '') +
      (s.price_ghs > 0 && s.foundations_discount_pct > 0 ? '<small>' + esc(foundationsFee(s)) + ' with a Foundations certificate</small>' : '') +
      (s.price_ghs > 0 && s.graduate_free ? '<small>Free for eligible Intermediate graduates</small>' : '') + '</dd>\n' +
    (s.capacity ? '  <dt>Places</dt><dd>' + esc(s.capacity + (s.reserved_graduate_seats || 0)) + ' people' +
      (s.reserved_graduate_seats ? '<small>' + esc(s.capacity) + ' open places and ' + esc(s.reserved_graduate_seats) + ' reserved for Intermediate graduates</small>' : '') + '</dd>\n' : '') +
    (s.audience ? '  <dt>For</dt><dd>' + esc(s.audience) + '</dd>\n' : '') + '</dl>';
}

function trace(s, w) {
  const paid = s.price_ghs > 0;
  const steps = [
    ['register', 'Your details', 'About a minute'],
    paid ? ['pay', 'Pay ' + fee(s), 'On Paystack\'s secure page, with mobile money or card'] : null,
    s.admission === "invite"
      ? ['email', 'Confirmation, then your invitation', 'We add your Google account to the workshop invitation, and Google emails you the Meet link']
      : ['email', 'Confirmation email', 'Your joining link'],
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
    '  <div class="ws-field"><label for="ws-email">Email <span class="ws-hint">' + (s.admission === "invite" ? "Your confirmation goes here" : "Your joining link goes here") + '</span></label><input id="ws-email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="160"></div>\n' +
    (s.admission === "invite"
      ? '  <div class="ws-field"><label for="ws-attend">Google account to join with <span class="ws-hint">Only this account can get into the meeting. It can differ from the email above</span></label><input id="ws-attend" name="attend_email" type="email" autocomplete="email" inputmode="email" required maxlength="160"></div>\n'
      : '') +
    (hasReferral(s)
      ? '  <div class="ws-field"><label for="ws-ref">Referral code <span class="ws-hint">Optional. From someone\'s referral link or code: ' + esc(referralFee(s)) + '</span></label>' +
        '<input id="ws-ref" name="ref" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" data-ws-ref></div>\n'
      : '') +
    (hasBenefits(s)
      ? '  <div class="ws-field" data-ws-cert><label for="ws-cert">Certificate ID <span class="ws-hint">Optional. ' +
        (s.foundations_discount_pct > 0 ? 'Foundations certificate: ' + esc(foundationsFee(s)) + '. ' : '') +
        (s.graduate_free ? 'Intermediate graduates: free, in a reserved place. ' : '') +
        'Applied straight away if the email above is the one on your certificate</span></label>' +
        '<input id="ws-cert" name="certificate_id" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40" placeholder="BPA-">' +
        '<button class="ws-btn ws-btn--small ws-btn--quiet" type="button" data-ws-cert-send>Apply my certificate</button>' +
        '<div data-ws-cert-code hidden><label for="ws-cert-code">Code from the email <span class="ws-hint">6 digits, sent to the address on the certificate, valid for 10 minutes</span></label>' +
        '<input id="ws-cert-code" name="cert_code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6">' +
        '<button class="ws-btn ws-btn--small" type="button" data-ws-cert-confirm>Confirm code</button></div>' +
        '<p class="ws-hint" data-ws-cert-status role="status"></p></div>\n'
      : '') +
    '  <div class="ws-field"><label for="ws-wa">WhatsApp <span class="ws-hint">Optional</span></label><input id="ws-wa" name="whatsapp" type="tel" autocomplete="tel" inputmode="tel" maxlength="40" placeholder="+233"></div>\n' +
    '  <label class="ws-check" data-wa-consent hidden><input type="checkbox" name="whatsapp_consent"> <span>Send me session reminders on WhatsApp.</span></label>\n' +
    '  <label class="ws-check"><input type="checkbox" name="ack_terms" required> <span>I agree to the <a href="/privacy">privacy notice</a>' +
    (s.price_ghs > 0 ? ' and the <a href="' + POLICY_HREF + '">webinar and workshop refund terms</a>. I understand a paid registration is non-refundable except as those terms or the law provide' : '') + '.</span></label>\n' +
    '  <div class="ws-hp" aria-hidden="true"><label for="ws-company">Company website</label><input id="ws-company" name="company_website" type="text" tabindex="-1" autocomplete="off"></div>\n' +
    '  <p class="ws-error" data-ws-error role="alert" hidden></p>\n' +
    (hasReferral(s) || hasBenefits(s) ? '  <p class="ws-note" data-ws-quote aria-live="polite">You pay ' + esc(fee(s)) + '.</p>\n' : '') +
    '  <button class="ws-btn ws-btn--block" type="submit" data-ws-submit>' + esc(cta(s)) + '</button>\n' +
    (s.price_ghs > 0 ? '  <p class="ws-note">You pay on Paystack\'s secure page. Your place is confirmed once Paystack confirms the payment.</p>\n' : '') +
    '</form>';
}

/* ---------------------------------------------------------------------------
   Pages. Each returns { title, description, canonical, body }; the function
   puts the body into the built shell (header, footer, consent bar).
   ------------------------------------------------------------------------- */
export function detailPage(s, cat) {
  const w = when(s);
  const member = membership(cat.series, s.slug);
  const ins = INSTRUCTORS[s.instructor] || INSTRUCTORS.johnathan;
  const sec = function (id, title, inner) { return '<section class="ws-sec" aria-labelledby="' + id + '"><h2 id="' + id + '">' + title + '</h2>' + inner + '</section>'; };
  const run = s.run_of_show.length
    ? sec("ws-plan", 'The ' + esc(duration(s.duration_minutes)), '\n<ol class="ws-run">' + s.run_of_show.map(function (r) {
        return '<li><span class="ws-run__at">' + esc(r.at) + '</span><div><b>' + esc(r.title) + '</b>' + (txt(r.detail) ? '<span>' + esc(r.detail) + '</span>' : '') + '</div></li>';
      }).join("") + '</ol>') : '';
  const why = s.why.length ? sec("ws-why", 'Why this ' + esc(kindLabel(s).toLowerCase()), s.why.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join("")) : '';
  const outcomes = s.outcomes.length ? sec("ws-learn", "What you will be able to do", '<ol class="ws-list ws-list--num">' +
    s.outcomes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ol>') : '';
  const leave = s.leave_with.length ? sec("ws-leave", "What you leave with", '<ul class="ws-list">' +
    s.leave_with.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul>') : '';
  const fit = s.good_fit || s.not_fit || s.bring ? sec("ws-fit", "Is this for you",
    (s.good_fit || s.not_fit ? '<div class="ws-two">' + (s.good_fit ? '<div><h3>Good fit</h3><p>' + esc(s.good_fit) + '</p></div>' : '') +
      (s.not_fit ? '<div><h3>Not a fit</h3><p>' + esc(s.not_fit) + '</p></div>' : '') + '</div>' : '') +
    (s.bring ? '<p><b>Bring:</b> ' + esc(s.bring) + '</p>' : '')) : '';
  const faq = s.faq.length ? sec("ws-faq", "Questions", s.faq.map(function (f) {
    return '<details class="ws-faq"><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>';
  }).join("")) : '';
  const inSeries = member ? sec("ws-series", 'Part of ' + esc(member.series.name),
    (member.series.standalone ? '<p>' + esc(member.series.standalone) + '</p>' : '') + seriesItems(member.series, cat, member.entry.number)) : '';
  const body =
'<main id="main" class="ws" data-ws-page="detail" data-slug="' + esc(s.slug) + '" data-price="' + esc(s.price_ghs) + '" data-starts="' + esc(new Date(s.starts_at).toISOString()) + '" data-title="' + esc(s.title) + '">\n' +
'<div class="ws-wrap ws-layout">\n<div class="ws-main">\n' +
'  <p class="ws-crumbs"><a href="/workshops">' + esc(member ? member.series.name : "Webinars and workshops") + '</a></p>\n' +
'  <section class="ws-hero" aria-labelledby="ws-title">\n' +
'    <div><p class="ws-kind">' + (member
      ? esc(member.series.name) + ', ' + esc(kindLabel(s).toLowerCase()) + ' ' + num(member.entry.number) + ', with ' + esc(ins.name)
      : esc(kindLabel(s)) + ' with ' + esc(ins.name)) + '</p>\n' +
'    <h1 class="ws-title" id="ws-title">' + esc(s.title) + '</h1>\n' +
(s.summary ? '    <p class="ws-lede">' + esc(s.summary) + '</p>' : '') + '</div>\n' +
'    ' + factsList(s, w) + '\n' +
'    <p class="ws-jump"><a class="ws-btn ws-btn--block" href="#register">' + esc(cta(s)) + '</a></p>\n' +
'  </section>\n' +
'  <div class="ws-content">\n' +
    [why, outcomes, leave, run, fit].filter(Boolean).map(function (x) { return '    ' + x + '\n'; }).join("") +
'    <section class="ws-sec" aria-labelledby="ws-teach"><h2 id="ws-teach">Who teaches it</h2><div class="ws-instructor">' +
      '<picture><source srcset="' + ins.photo + '.avif" type="image/avif"><source srcset="' + ins.photo + '.webp" type="image/webp">' +
      '<img src="' + ins.photo + '.jpg" alt="' + esc(ins.name) + '" width="88" height="110" loading="lazy" decoding="async"></picture>' +
      '<div><b>' + esc(ins.name) + '</b><p>' + esc(ins.bio) + '</p><p><a href="/about">More about ' + esc(ins.name.split(" ")[0]) + '</a></p></div></div></section>\n' +
    (faq ? '    ' + faq + '\n' : '') +
    (inSeries ? '    ' + inSeries + '\n' : '') +
    (member && member.series.disclaimer ? '    <p class="ws-small">' + esc(member.series.disclaimer) + '</p>\n' : '') +
'    <p class="ws-small">Attending a webinar or workshop is training. It is not a certification and does not count towards one.</p>\n' +
'  </div>\n</div>\n' +
'<aside class="ws-aside" id="register" aria-labelledby="ws-reg">\n' +
'  <div class="ws-sheet" data-ws-sheet>\n' +
'    <h2 id="ws-reg">Register</h2>\n' +
'    <p class="ws-sumline">' + esc(w.long) + ', ' + esc(w.gmt) + ' GMT. ' + esc(fee(s)) + '. Registration closes ' + esc(w.closes) + ' in Accra.</p>\n' +
'    <p class="ws-banner" data-ws-banner role="status" hidden></p>\n' +
'    ' + trace(s, w).replace(/\n/g, "\n    ") + '\n' +
'    ' + form(s).replace(/\n/g, "\n    ") + '\n' +
'    <div class="ws-after" data-ws-after hidden></div>\n' +
'  </div>\n</aside>\n</div>\n' +
'<div class="ws-stickybar" data-ws-sticky hidden><a class="ws-btn ws-btn--block" href="#register">' + esc(cta(s)) + '</a></div>\n</main>';
  return { title: s.title + " — " + kindLabel(s) + " — Bulletproof Automations Training",
    description: s.description || s.summary || s.title, canonical: ORIGIN + "/workshops/" + s.slug, body: body };
}

function directoryRow(s) {
  const w = when(s);
  return '<li class="ws-row">\n' +
    '  <div class="ws-row__date"><b>' + esc(w.day) + '</b><span>' + esc(w.mon) + ', ' + esc(w.wd) + '</span></div>\n' +
    '  <div class="ws-row__text"><h2><a href="/workshops/' + esc(s.slug) + '">' + esc(s.title) + '</a></h2>\n' +
    '  <p class="ws-row__meta">' + esc(kindLabel(s)) + ', ' + esc(duration(s.duration_minutes)) + ', ' + esc(w.accra) + ' in Accra' + (s.capacity ? ', ' + esc(s.capacity) + ' places' : '') + '</p>\n' +
    (s.directory_line ? '  <p class="ws-row__out">' + esc(s.directory_line) + '</p>' : '') + '</div>\n' +
    '  <div class="ws-row__side"><span class="ws-row__fee">' + esc(fee(s)) + '</span><a class="ws-btn ws-btn--small" href="/workshops/' + esc(s.slug) + '" aria-label="View details: ' + esc(s.title) + '">View details</a></div>\n' +
    '</li>';
}

/* The series in order. The entry for the page being viewed is not a link. */
function seriesItems(series, cat, current) {
  const bySlug = new Map(cat.listed.concat(cat.past).map(function (s) { return [s.slug, s]; }));
  return '<ol class="ws-series">' + series.entries.map(function (e) {
    const s = e.session ? bySlug.get(e.session) : null;
    const slug = s ? s.slug : e.slug;
    const title = s ? s.title : e.title;
    const line = s ? s.directory_line : e.headline;
    const w = s ? when(s) : null;
    const name = e.number === current
      ? '<span aria-current="page">' + esc(title) + '</span>'
      : s && s.past ? '<span>' + esc(title) + '</span>'
      : '<a href="/workshops/' + esc(slug) + '">' + esc(title) + '</a>';
    return '<li class="ws-ser"><span class="ws-ser__n">' + num(e.number) + '</span>' +
      '<div class="ws-ser__text"><h3>' + name + '</h3>' + (line ? '<p>' + esc(line) + '</p>' : '') + '</div>' +
      '<span class="ws-ser__tag' + (s ? ' is-date' : '') + '">' + esc(w ? w.wd + " " + w.day + " " + w.mon : "Coming soon") + '</span></li>';
  }).join("") + '</ol>';
}

export function directoryPage(cat) {
  const series = cat.series[0] || null;
  if (series) {
    const inSeries = new Set(series.entries.map(function (e) { return e.session; }).filter(Boolean));
    const featured = cat.listed.filter(function (s) { return inSeries.has(s.slug); });
    const others = cat.listed.filter(function (s) { return !inSeries.has(s.slug); });
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
    const count = words[series.entries.length] || String(series.entries.length);
    const body = '<main id="main" class="ws" data-ws-page="directory">\n<div class="ws-wrap">\n' +
      '<div class="ws-dir-head"><p class="ws-kind">A live workshop series from ' + esc(series.presenter) + '</p>\n' +
      '<h1>' + esc(series.name) + '</h1>\n' +
      (series.positioning ? '<p class="ws-dir-lede">' + esc(series.positioning) + '</p>\n' : '') +
      series.intro.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join("\n") + '</div>\n' +
      (featured.length ? '<section class="ws-dir-sec" aria-labelledby="ws-next"><h2 class="ws-dir-h2" id="ws-next">' + (featured.length === 1 ? "Next workshop" : "Coming up") + '</h2>\n<ul class="ws-rows">\n' +
        featured.map(directoryRow).join("\n") + '\n</ul></section>\n' : '') +
      '<section class="ws-dir-sec" aria-labelledby="ws-all"><h2 class="ws-dir-h2" id="ws-all">The ' + esc(count) + ' workshops</h2>\n' +
      (series.standalone ? '<p>' + esc(series.standalone) + '</p>\n' : '') + seriesItems(series, cat, null) + '</section>\n' +
      (others.length ? '<section class="ws-dir-sec" aria-labelledby="ws-other"><h2 class="ws-dir-h2" id="ws-other">Other sessions</h2>\n<ul class="ws-rows">\n' +
        others.map(directoryRow).join("\n") + '\n</ul></section>\n' : '') +
      '<p class="ws-small ws-dir-note">' + (series.disclaimer ? esc(series.disclaimer) + ' ' : '') + 'Attending is training, not a certification.</p>\n' +
      '</div>\n</main>';
    return { title: series.name + " — live workshops for automation practitioners — Bulletproof Automations Training",
      description: (series.positioning ? series.positioning + " " : "") + "Live workshops on pricing, finding clients, proposals and delivery, from " + series.presenter + ".",
      canonical: ORIGIN + "/workshops", body: body };
  }
  const body = '<main id="main" class="ws" data-ws-page="directory">\n<div class="ws-wrap">\n' +
    '<div class="ws-dir-head"><h1>Webinars and workshops</h1>\n' +
    '<p>Live sessions with Johnathan Lightfoot. Attending is training, not a certification.</p></div>\n' +
    (cat.listed.length
      ? '<ul class="ws-rows">\n' + cat.listed.map(directoryRow).join("\n") + '\n</ul>\n'
      : '<p class="ws-lede">No session is open for registration right now. New dates are announced here first.</p>\n') +
    '</div>\n</main>';
  return { title: "Webinars and workshops — Bulletproof Automations Training",
    description: "Live, instructor-led webinars and workshops on practical automation, with dates, times in Accra and Lagos, and fees in cedis.",
    canonical: ORIGIN + "/workshops", body: body };
}

/* A workshop still being planned: copy, no date, no fee, no form. */
export function plannedPage(s, cat) {
  const member = membership(cat.series, s.slug);
  const series = member ? member.series : null;
  const n = member ? member.entry.number : null;
  // The series' first bookable workshop, as before; outside a series, the next one on sale.
  const firstEntry = series ? series.entries.find(function (x) { return x.session && cat.listed.some(function (l) { return l.slug === x.session; }); }) : null;
  const firstLive = firstEntry ? cat.listed.find(function (l) { return l.slug === firstEntry.session; }) : (series ? null : cat.listed[0] || null);
  const nextLabel = firstEntry ? "Workshop " + num(firstEntry.number) : "The next one";
  const sec = function (id, title, inner) { return '    <section class="ws-sec" aria-labelledby="' + id + '"><h2 id="' + id + '">' + title + '</h2>' + inner + '</section>\n'; };
  const body =
'<main id="main" class="ws" data-ws-page="planned">\n' +
'<div class="ws-wrap ws-layout">\n<div class="ws-main">\n' +
'  <p class="ws-crumbs"><a href="/workshops">' + esc(series ? series.name : "Webinars and workshops") + '</a></p>\n' +
'  <section class="ws-hero" aria-labelledby="ws-title">\n' +
'    <div><p class="ws-kind">' + (series ? esc(series.name) + ', workshop ' + num(n) : esc(kindLabel(s))) + '</p>\n' +
'    <h1 class="ws-title" id="ws-title">' + esc(s.title) + '</h1>\n' +
(s.summary ? '    <p class="ws-lede">' + esc(s.summary) + '</p>\n' : '') +
'    <p class="ws-soon">Coming soon</p></div>\n' +
'  </section>\n' +
'  <div class="ws-content">\n' +
(s.problem ? sec("ws-problem", "The problem it solves", '<p>' + esc(s.problem) + '</p>') : '') +
(s.audience ? sec("ws-who", "Who it is for", '<p>' + esc(s.audience) + '</p>') : '') +
(s.outcomes.length ? sec("ws-learn", "What you will be able to do", '<ol class="ws-list ws-list--num">' +
  s.outcomes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ol>') : '') +
(series ? sec("ws-series", "Where it fits in the series", (s.series_fit ? '<p>' + esc(s.series_fit) + '</p>' : '') + seriesItems(series, cat, n)) : '') +
(series && series.disclaimer ? '    <p class="ws-small">' + esc(series.disclaimer) + '</p>\n' : '') +
'    <p class="ws-small">Attending a webinar or workshop is training. It is not a certification and does not count towards one.</p>\n' +
'  </div>\n</div>\n' +
'<aside class="ws-aside" aria-labelledby="ws-soon-h">\n' +
'  <div class="ws-sheet">\n' +
'    <h2 id="ws-soon-h">Coming soon</h2>\n' +
'    <p>This workshop does not have a date or a fee yet, and it is not taking registrations.</p>\n' +
(firstLive
  ? '    <p>' + esc(nextLabel) + ', ' + esc(firstLive.title) + ', is on ' + esc(when(firstLive).long) + '.</p>\n' +
    '    <a class="ws-btn ws-btn--block" href="/workshops/' + esc(firstLive.slug) + '">See ' + esc(firstEntry ? "workshop " + num(firstEntry.number) : "the next workshop") + '</a>\n'
  : '') +
'    <a class="ws-btn ws-btn--block ws-btn--quiet" href="/workshops">' + (series ? 'See all ' + esc(series.entries.length) + ' workshops' : 'See all workshops') + '</a>\n' +
'  </div>\n</aside>\n</div>\n</main>';
  return { title: s.title + (series ? " — " + series.name + ", workshop " + num(n) : "") + " — Bulletproof Automations Training",
    description: (series ? series.name + ", workshop " + num(n) + ". " : "") + (s.summary ? s.summary + " " : "") +
      "Coming soon" + (series ? " from " + series.presenter : "") + ".",
    canonical: ORIGIN + "/workshops/" + s.slug, body: body };
}

export function registeredPage() {
  const body = '<main id="main" class="ws" data-ws-page="registered">\n<div class="ws-wrap ws-done" data-ws-done>\n' +
    '  <h1 data-done-title>Checking your registration</h1>\n' +
    '  <p class="ws-lede" data-done-lede>One moment while we confirm with our records.</p>\n' +
    '  <div data-done-body></div>\n' +
    '  <noscript><p class="ws-lede">Your confirmation email has your joining details. If it has not arrived within ten minutes, check spam, then email info@bulletproofautomations.com.</p></noscript>\n' +
    '  <p class="ws-small">Questions? Reply to your confirmation email, or email <a href="mailto:info@bulletproofautomations.com">info@bulletproofautomations.com</a>.</p>\n' +
    '</div>\n</main>';
  return { title: "Your registration — Bulletproof Automations Training",
    description: "Registration status for a Bulletproof Automations webinar or workshop.",
    canonical: ORIGIN + "/workshops/registered", body: body, noindex: true };
}

/* The page for a path under /workshops, or null for a 404. */
export function route(path, cat) {
  const parts = String(path || "").replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "workshops") return null;
  if (parts.length === 1) return directoryPage(cat);
  if (parts.length !== 2 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(parts[1])) return null;
  if (parts[1] === "registered") return registeredPage();
  const live = cat.live.find(function (s) { return s.slug === parts[1]; });
  if (live) return detailPage(live, cat);
  const planned = cat.planned.find(function (s) { return s.slug === parts[1]; });
  if (planned) return plannedPage(planned, cat);
  return null;
}

/* Every public URL, for the sitemap. */
export function paths(cat) {
  return ["/workshops"].concat(cat.live.filter(function (s) { return s.status === "published"; }).map(function (s) { return "/workshops/" + s.slug; }),
    cat.planned.map(function (s) { return "/workshops/" + s.slug; }));
}

/* The body placed into the built shell. */
export function fill(shell, page) {
  let html = shell.split("__WS_TITLE__").join(esc(page.title))
    .split("__WS_DESCRIPTION__").join(esc(page.description))
    .split("__WS_CANONICAL__").join(esc(page.canonical))
    .replace("<!-- ws-body -->", function () { return page.body; });
  if (page.noindex) html = html.replace("</head>", '<meta name="robots" content="noindex">\n</head>');
  return html;
}
