/* Webinars and workshops: shared server-side helpers.
 *
 * Not routed (leading underscore). Every database write goes through the
 * service-role RPCs in supabase/migrations/20261103120000_workshops.sql; this
 * file never decides an amount and never marks anything paid by itself.
 */

import { rpc } from "./_shared.js";
import { sendMail, esc, MAILBOX } from "./_mail.js";
import { sendConversions, metaConfigured } from "./_meta.js";

export const WORKSHOP_APP = "bulletproof-training-workshops";

/* ---------------------------------------------------------------------------
   Paystack for webinars uses a SEPARATE Paystack business, "Bulletproof
   Automations Webinars", with its own keys and its own webhook
   (supabase/functions/workshop-paystack-webhook). Webinar charges therefore
   never reach the training webhook (v9), cohort enrollments, installments or
   Bulletproof Scheduling. Nothing here imports functions/api/_paystack.js.

   WORKSHOP_PAYSTACK_SECRET_KEY is the webinar business's secret key. It is
   refused (checkout stays off) when it is missing, malformed, or identical to
   the training business's PAYSTACK_SECRET_KEY, because the same key would mean
   the same Paystack business and therefore the training webhook.
   --------------------------------------------------------------------------- */
export function workshopKey(env) {
  const key = String((env && env.WORKSHOP_PAYSTACK_SECRET_KEY) || "");
  if (!/^sk_(test|live)_[A-Za-z0-9_]{8,}$/.test(key)) return null;
  if (env.PAYSTACK_SECRET_KEY && key === env.PAYSTACK_SECRET_KEY) return null;
  return key;
}
export function workshopMode(env) {
  const key = workshopKey(env);
  return key ? (key.indexOf("sk_live_") === 0 ? "live" : "test") : "off";
}

/* WORKSHOP_PAYSTACK_API_BASE (local testing) is honoured only under a test
   key: a live key always talks to api.paystack.co. */
function paystackBase(env) {
  return workshopMode(env) === "test" && typeof env.WORKSHOP_PAYSTACK_API_BASE === "string" && env.WORKSHOP_PAYSTACK_API_BASE
    ? env.WORKSHOP_PAYSTACK_API_BASE.replace(/\/+$/, "")
    : "https://api.paystack.co";
}

/* Amount in pesewas from the caller (taken from the database attempt row). */
export async function initializeWorkshopCheckout(env, o) {
  const secret = workshopKey(env);
  if (!secret) return { ok: false, reason: "paystack-not-configured" };
  let res;
  try {
    res = await fetch(paystackBase(env) + "/transaction/initialize", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: o.email,
        amount: o.amountMinor,
        currency: "GHS",
        reference: o.reference,
        callback_url: o.callbackUrl,
        channels: o.channels,
        metadata: o.metadata
      })
    });
  } catch (err) {
    return { ok: false, reason: "paystack-unreachable" };
  }
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || data.status !== true || !data.data || !data.data.authorization_url) {
    return { ok: false, reason: "paystack-" + res.status + ": " + String((data && data.message) || "").slice(0, 200) };
  }
  return { ok: true, url: data.data.authorization_url };
}

export async function verifyWorkshopTransaction(env, reference) {
  const secret = workshopKey(env);
  if (!secret) return { ok: false, reason: "paystack-not-configured" };
  let res;
  try {
    res = await fetch(paystackBase(env) + "/transaction/verify/" + encodeURIComponent(reference), {
      headers: { Authorization: "Bearer " + secret }
    });
  } catch (err) {
    return { ok: false, reason: "paystack-unreachable" };
  }
  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || data.status !== true || !data.data) return { ok: false, reason: "paystack-verify-" + res.status };
  const t = data.data;
  return { ok: true, status: t.status, reference: t.reference,
    amountMinor: typeof t.amount === "number" ? Math.round(t.amount) : null,
    currency: t.currency || null, domain: t.domain || null, paidAt: t.paid_at || t.paidAt || null };
}
export const TERMS_VERSION = "2026-11-03";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/* BPA-WEB- (live) / BPA-WTEST- (test). Distinct from the cohort's BPA-CAB- and
   BPA-TEST-, and from Scheduling's BPS-, so the webhook can route on prefix. */
export function mintWorkshopReference(mode) {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let tail = "";
  for (let i = 0; i < bytes.length; i++) tail += ALPHABET[bytes[i] % 32];
  return (mode === "live" ? "BPA-WEB-" : "BPA-WTEST-") + new Date().getUTCFullYear() + "-" + tail;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

/* 256-bit bearer token, base64url. Only its SHA-256 is stored. */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function looksLikeToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function looksLikeReference(value) {
  return typeof value === "string" && /^BPA-W(EB|TEST)-[0-9]{4}-[0-9A-Z]{10}$/.test(value);
}

/* Which checkout, if any, this request may reach.
 *
 *   live key  -> "live" only when WORKSHOP_PAID_CHECKOUT=on. That switch is set
 *                by the owner after the webinar business's webhook
 *                (workshop-paystack-webhook) is deployed and validated.
 *   (The key here is ALWAYS the webinar business's: see workshopKey().)
 *   test key  -> "test" only for a request that opted in (?paystack=test),
 *                the same rule as the cohort page. Nobody reaches a test
 *                checkout by accident.
 *   otherwise -> null: the registration is recorded and payment is not taken. */
export function checkoutMode(env, testOptIn) {
  const mode = workshopMode(env);
  if (mode === "live") return env.WORKSHOP_PAID_CHECKOUT === "on" ? "live" : null;
  if (mode === "test") return testOptIn === true ? "test" : null;
  return null;
}

const UTM = /^[A-Za-z0-9 _.~%+:|{}\-]{1,200}$/;

/* Attribution from the page, cleaned. UTMs are first-party campaign
   parameters and are always kept; Meta identifiers and the request context
   for the Conversions API only with ad consent. */
export function cleanAttribution(raw, request, consent) {
  const a = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
    if (typeof a[key] === "string" && UTM.test(a[key])) out[key] = a[key];
  }
  if (typeof a.landing_path === "string" && /^\/[A-Za-z0-9/_\-.]{0,199}$/.test(a.landing_path)) out.landing_path = a.landing_path;
  if (typeof a.referrer_host === "string" && /^[a-z0-9.-]{1,200}$/i.test(a.referrer_host)) out.referrer_host = a.referrer_host.toLowerCase();
  if (consent) {
    if (typeof a.fbclid === "string" && /^[A-Za-z0-9_-]{8,500}$/.test(a.fbclid)) out.fbclid = a.fbclid;
    if (typeof a.fbc === "string" && /^fb\.[0-9]\.[0-9]{10,16}\.[A-Za-z0-9_-]{8,500}$/.test(a.fbc)) out.fbc = a.fbc;
    if (typeof a.fbp === "string" && /^fb\.[0-9]\.[0-9]{10,16}\.[0-9]{5,25}$/.test(a.fbp)) out.fbp = a.fbp;
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip && ip.length <= 64) out.client_ip = ip;
    const ua = request.headers.get("User-Agent");
    if (ua) out.client_user_agent = ua.slice(0, 400);
  }
  return out;
}

/* Browser and server use the same ids so Meta deduplicates the pair. */
export function eventIds(registrationId) {
  return {
    initiate_checkout: "ic_" + registrationId,
    complete_registration: "cr_" + registrationId,
    purchase: "pu_" + registrationId
  };
}

export function rest(env, path, init) {
  return fetch(env.SUPABASE_URL + "/rest/v1/" + path, Object.assign({}, init || {}, {
    headers: Object.assign({
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json"
    }, (init && init.headers) || {})
  }));
}

/* Call a Postgres function that returns void. PostgREST answers those with an
   empty body, which the shared rpc() parses as JSON and throws on, so these
   calls check the status only. Never throws: a failure is reported, and the
   caller's row stays where it was (an email left "sending" is reclaimed after
   ten minutes; a sent one is never resent, because it is marked sent first). */
export async function rpcVoid(env, name, args) {
  try {
    const res = await rest(env, "rpc/" + name, { method: "POST", body: JSON.stringify(args) });
    if (!res.ok) return { ok: false, reason: "rpc-" + name + "-" + res.status };
    await res.text();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "rpc-" + name + "-unreachable" };
  }
}

/* ---------------------------------------------------------------------------
   Server-side verification of one reference against Paystack, applied through
   the same idempotent RPC the webhook uses. Returns the RPC outcome, or null
   when nothing was applied (throttled, unpaid, unreachable).
   --------------------------------------------------------------------------- */
export async function verifyAndApply(env, reference) {
  if (!looksLikeReference(reference)) return null;
  if (workshopMode(env) === "off") return null;
  const claim = await rpc(env, "workshop_claim_verify", { p_reference: reference });
  if (!claim.ok || claim.data !== true) return null;
  const v = await verifyWorkshopTransaction(env, reference);
  if (!v.ok || v.status !== "success" || v.reference !== reference) return null;
  const applied = await rpc(env, "workshop_apply_charge", {
    p_reference: reference,
    p_amount_minor: v.amountMinor,
    p_currency: v.currency,
    p_domain: v.domain,
    p_paid_at: v.paidAt,
    p_via: "verify",
    p_payment_event_id: null
  });
  return applied.ok ? applied.data : null;
}

/* ---------------------------------------------------------------------------
   Formatting
   --------------------------------------------------------------------------- */
export function formatWhen(session) {
  const start = new Date(session.starts_at);
  const tz = session.time_zone || "Africa/Accra";
  const date = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(start);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).format(start);
  const gmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" }).format(start);
  const zoneLabel = tz === "Africa/Accra" ? "GMT" : tz + " (" + gmt + " GMT)";
  const clock = { hour: "numeric", minute: "2-digit", hour12: true };
  const accra = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: "Africa/Accra" }, clock)).format(start).toUpperCase();
  const lagos = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: "Africa/Lagos" }, clock)).format(start).toUpperCase();
  const end = new Date(start.getTime() + Number(session.duration_minutes || 60) * 60000);
  const span = function (zone) {
    const f = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: zone }, clock));
    return (f.format(start) + "–" + f.format(end)).toUpperCase();
  };
  // Same wording as the pages: both audiences' clocks from the one stored instant.
  return { date: date, time: time.toUpperCase().replace(/\s/g, " "), zone: zoneLabel, both: accra + " in Accra, " + lagos + " in Lagos",
    ghana: span("Africa/Accra") + " (GMT)", lagos: span("Africa/Lagos") + " (WAT)" };
}

/* The first https link in a session's private joining instructions: the
   button in the email and the LOCATION of the calendar file. */
export function joinUrl(session) {
  const m = /https:\/\/[^\s<>"']+/.exec(String((session && session.join_instructions) || ""));
  return m ? m[0].replace(/[.,;:)]+$/, "") : null;
}

/* A Google Calendar "add" link. It opens a prefilled event in the attendee's
   own calendar; nothing is sent to the host and no invitation is created. */
export function googleCalendarLink(session) {
  const start = new Date(session.starts_at);
  const end = new Date(start.getTime() + Number(session.duration_minutes || 60) * 60000);
  const url = joinUrl(session);
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: session.title,
    dates: icsStamp(start) + "/" + icsStamp(end),
    details: "Bulletproof Automations Training." + (url ? " Join: " + url : ""),
    location: url || "Online"
  });
  return "https://calendar.google.com/calendar/render?" + q.toString();
}

function money(minorOrGhs, isMinor) {
  const ghs = isMinor ? Number(minorOrGhs || 0) / 100 : Number(minorOrGhs || 0);
  return "GHS " + ghs.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function calendarFile(session, origin) {
  const start = new Date(session.starts_at);
  const end = new Date(start.getTime() + Number(session.duration_minutes || 60) * 60000);
  const fold = function (s) { return String(s).replace(/[\\,;]/g, function (c) { return "\\" + c; }).replace(/\r?\n/g, "\\n"); };
  // RFC 5545 3.1: content lines longer than 75 octets are folded.
  const line = function (s) {
    const out = [];
    let rest = s;
    while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = " " + rest.slice(74); }
    out.push(rest);
    return out.join("\r\n");
  };
  // Joining details appear only when the caller passed them, which it does
  // only for a confirmed registration. METHOD:PUBLISH with no ORGANIZER or
  // ATTENDEE: opening the file adds an event and sends no invitation.
  const url = joinUrl(session);
  const description = session.join_instructions
    ? "Bulletproof Automations Training.\n\n" + session.join_instructions
    : "Bulletproof Automations Training. Joining details are in your confirmation email.";
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bulletproof Automations//Training//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + session.id + "@training.bulletproofautomations.com",
    "DTSTAMP:" + icsStamp(new Date()),
    "DTSTART:" + icsStamp(start),
    "DTEND:" + icsStamp(end),
    "SUMMARY:" + fold(session.title),
    "DESCRIPTION:" + fold(description),
    url ? "LOCATION:" + fold(url) : null,
    "URL:" + origin + "/workshops/" + session.slug,
    "END:VEVENT", "END:VCALENDAR", ""
  ].filter(function (l) { return l !== null; }).map(line).join("\r\n");
}

/* ---------------------------------------------------------------------------
   Email content. Branded, plain, and true for the state it is sent in: a
   payment under review is never described as a confirmed place, and no
   response time is promised unless the business has set one.
   --------------------------------------------------------------------------- */
/* The support WhatsApp number is NOT hardcoded. It appears only when
   WORKSHOP_SUPPORT_WHATSAPP is set (international format, e.g. +233546527779)
   after the owner has verified it; otherwise people are told to reply to the
   email, which reaches the Bulletproof Automations mailbox it was sent from. */
export function supportWhatsApp(env) {
  const raw = String((env && env.WORKSHOP_SUPPORT_WHATSAPP) || "").replace(/[\s-]/g, "");
  return /^\+[1-9][0-9]{7,14}$/.test(raw) ? raw : null;
}

export function emailFor(kind, registration, session, links, env) {
  const first = String(registration.full_name || "there").trim().split(/\s+/)[0] || "there";
  const when = formatWhen(session);
  const facts = [
    ["Date", when.date],
    ["Ghana time", when.ghana],
    ["Lagos time", when.lagos],
    ["Duration", session.duration_minutes + " minutes"],
    ["Format", session.format]
  ];
  const join = session.join_instructions
    ? String(session.join_instructions).trim()
    : "We will email your joining link before the session starts.";
  const url = joinUrl(session);
  const joinLabel = url && /^https:\/\/meet\.google\.com\//.test(url) ? "Join on Google Meet" : "Open the joining link";
  // Escaped first, then any https link made clickable, so nothing in the
  // stored text can inject markup.
  const joinHtml = esc(join).replace(/https:\/\/[^\s<>"']+/g, function (u) {
    const clean = u.replace(/[.,;:)]+$/, "");
    return '<a href="' + clean + '" style="color:#116149;font-weight:700">' + clean + "</a>" + u.slice(clean.length);
  }).replace(/\r?\n/g, "<br>");
  const reviewDays = /^[0-9]{1,2}$/.test(String(env.WORKSHOP_REVIEW_RESPONSE_DAYS || ""))
    ? " within " + env.WORKSHOP_REVIEW_RESPONSE_DAYS + " business days"
    : "";

  const wa = supportWhatsApp(env);
  const help = "Questions? Reply to this email or write to " + MAILBOX + (wa ? ", or WhatsApp " + wa : "") + ".";
  let subject, lead, body, showJoin;
  if (kind === "confirmation" || kind === "admitted") {
    subject = "You're registered: " + session.title;
    lead = kind === "admitted" ? first + ", your place is confirmed." : first + ", you're registered.";
    body = Number(registration.amount_paid_minor || 0) > 0
      ? "We have received your payment of " + money(registration.amount_paid_minor, true) + ". Keep this email: it has your joining details."
      : "Keep this email: it has your joining details.";
    showJoin = true;
  } else if (kind === "payment_review") {
    subject = "We have your payment for " + session.title;
    lead = first + ", we have received your payment.";
    body = "We received " + money(registration.amount_paid_minor, true) + " for " + session.title + ", but we could not confirm your place automatically. " +
      "We will contact you" + reviewDays + " to either confirm your place or arrange a refund. You do not need to pay again.";
    showJoin = false;
  } else if (kind === "duplicate_payment") {
    subject = "A second payment for " + session.title;
    lead = first + ", we received a second payment.";
    body = "Your registration for " + session.title + " is confirmed and is not affected. We received more than one payment for it, and we will contact you" +
      reviewDays + " about the extra payment.";
    showJoin = true;
  } else {
    return null;
  }

  const rows = facts.map(function (f) {
    return '<tr><td style="padding:6px 12px 6px 0;color:#52615b;width:104px;vertical-align:top">' + esc(f[0]) +
      '</td><td style="padding:6px 0;font-weight:700;color:#10251d">' + esc(f[1]) + "</td></tr>";
  }).join("");
  const html = '<!doctype html><html><body style="margin:0;background:#f3efe5;font-family:Arial,sans-serif;color:#10251d">' +
    '<div style="max-width:620px;margin:0 auto;padding:28px 18px">' +
    '<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;font-weight:700">Bulletproof Automations Training</div>' +
    '<div style="background:#fff;margin-top:18px;padding:28px;border:1px solid #d8d2c3;border-radius:16px">' +
    '<p style="margin:0 0 8px;font-size:18px">' + esc(lead) + "</p>" +
    '<h1 style="margin:0 0 18px;font-size:26px;line-height:1.2">' + esc(session.title) + "</h1>" +
    '<table style="border-collapse:collapse;font-size:15px;margin-bottom:18px">' + rows + "</table>" +
    '<p style="font-size:15px;line-height:1.55;margin:0 0 18px">' + esc(body) + "</p>" +
    (showJoin ? '<div style="padding:16px;background:#f3efe5;border-radius:10px;font-size:15px;line-height:1.55;margin-bottom:18px">' +
      '<strong>How to join</strong><br>' + joinHtml + "</div>" : "") +
    (showJoin && url ? '<p style="margin:0 0 14px"><a href="' + esc(url) + '" style="display:inline-block;background:#116149;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:700">' + esc(joinLabel) + "</a></p>" : "") +
    (showJoin ? '<p style="margin:0;font-size:14px;line-height:1.6">Add it to your calendar: ' +
      '<a href="' + esc(googleCalendarLink(session)) + '" style="color:#116149;font-weight:700">Google Calendar</a>' +
      (links.calendar ? ' or <a href="' + esc(links.calendar) + '" style="color:#116149;font-weight:700">other calendars (.ics)</a>' : "") + "</p>" : "") +
    '<p style="font-size:13px;line-height:1.5;color:#52615b;margin:22px 0 0">' + esc(help) + '</p>' +
    "</div>" +
    '<p style="font-size:12px;line-height:1.5;color:#65736d;margin:16px 4px 0">Bulletproof Automations is an independent training provider based in Jacksonville, Florida. ' +
    "Attending a webinar or workshop is not a certification. Bulletproof Automations is not affiliated with or endorsed by n8n GmbH.</p>" +
    "</div></body></html>";
  const text = lead + "\n\n" + session.title + "\n" + facts.map(function (f) { return f[0] + ": " + f[1]; }).join("\n") +
    "\n\n" + body + (showJoin ? "\n\nHow to join:\n" + join : "") +
    (showJoin ? "\n\nAdd to Google Calendar: " + googleCalendarLink(session) : "") +
    (showJoin && links.calendar ? "\nAdd to other calendars (.ics): " + links.calendar : "") +
    "\n\n" + help + "\n\nBulletproof Automations Training";
  return { subject: subject, html: html, text: text };
}

/* ---------------------------------------------------------------------------
   The outbox dispatcher. Called by pg_cron through /api/workshops/dispatch and
   opportunistically after a registration or confirmation. Safe to run
   concurrently: rows are claimed with SKIP LOCKED.
   --------------------------------------------------------------------------- */
export async function processOutbox(env, origin, limits) {
  const report = { emails: { sent: 0, failed: 0, skipped: 0 }, meta: { sent: 0, failed: 0 }, reconciled: 0 };
  const max = Object.assign({ emails: 10, meta: 20, reconcile: 10 }, limits || {});

  // 1. Reconcile started checkouts the webhook has not settled (missed or late
  //    webhook). Paystack is asked directly; the RPC applies at most once.
  if (max.reconcile > 0 && workshopMode(env) !== "off") {
    const since = new Date(Date.now() - 48 * 3600000).toISOString();
    const older = new Date(Date.now() - 10 * 60000).toISOString();
    const res = await rest(env, "workshop_payment_attempts?select=reference&status=eq.initialized" +
      "&created_at=gte." + encodeURIComponent(since) + "&created_at=lte." + encodeURIComponent(older) +
      "&order=created_at.asc&limit=" + max.reconcile);
    const rows = res.ok ? await res.json().catch(function () { return []; }) : [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const out = await verifyAndApply(env, row.reference);
      if (out) report.reconciled += 1;
    }
  }

  // 2. Email.
  if (max.emails > 0) {
    const claimed = await rpc(env, "workshop_claim_notifications", { p_limit: max.emails });
    for (const n of claimed.ok && Array.isArray(claimed.data) ? claimed.data : []) {
      const result = await deliverNotification(env, origin, n);
      if (result === "sent") report.emails.sent += 1;
      else if (result === "skipped") report.emails.skipped += 1;
      else report.emails.failed += 1;
    }
  }

  // 3. Meta Conversions API. Left queued (not claimed) until it is configured.
  if (max.meta > 0 && metaConfigured(env)) {
    const claimed = await rpc(env, "workshop_claim_meta_events", { p_limit: max.meta });
    const events = claimed.ok && Array.isArray(claimed.data) ? claimed.data : [];
    if (events.length) {
      const sent = await sendConversions(env, origin, events, function (ids) { return loadForMeta(env, ids); });
      for (const ev of events) {
        const ok = sent.ok && !sent.failedIds.includes(ev.id);
        await rpcVoid(env, "workshop_finish_meta_event", { p_id: ev.id, p_ok: ok, p_error: ok ? null : sent.reason || "send-failed" });
        if (ok) report.meta.sent += 1; else report.meta.failed += 1;
      }
    }
  }
  return report;
}

async function loadForMeta(env, registrationIds) {
  const res = await rest(env, "workshop_registrations?select=id,email_normalized,fbc,fbp,client_ip,client_user_agent,landing_path,session_id,ad_consent" +
    "&id=in.(" + registrationIds.map(encodeURIComponent).join(",") + ")");
  const rows = res.ok ? await res.json().catch(function () { return []; }) : [];
  const sessions = {};
  const ids = Array.from(new Set(rows.map(function (r) { return r.session_id; })));
  if (ids.length) {
    const s = await rest(env, "workshop_sessions?select=id,slug,title&id=in.(" + ids.map(encodeURIComponent).join(",") + ")");
    for (const row of s.ok ? await s.json().catch(function () { return []; }) : []) sessions[row.id] = row;
  }
  const map = {};
  for (const r of rows) map[r.id] = Object.assign({}, r, { session: sessions[r.session_id] || null });
  return map;
}

async function deliverNotification(env, origin, n) {
  const finish = async function (ok, error) {
    await rpcVoid(env, "workshop_finish_notification", { p_id: n.id, p_ok: ok, p_error: error || null });
  };
  const regRes = await rest(env, "workshop_registrations?select=*&id=eq." + encodeURIComponent(n.registration_id) + "&limit=1");
  const reg = regRes.ok ? (await regRes.json().catch(function () { return []; }))[0] : null;
  if (!reg) { await finish(false, "registration-unreadable"); return "failed"; }
  const sesRes = await rest(env, "workshop_sessions?select=*&id=eq." + encodeURIComponent(reg.session_id) + "&limit=1");
  const session = sesRes.ok ? (await sesRes.json().catch(function () { return []; }))[0] : null;
  if (!session) { await finish(false, "session-unreadable"); return "failed"; }

  // A message that is no longer true is not sent.
  const stillTrue = {
    confirmation: reg.status === "confirmed",
    admitted: reg.status === "confirmed",
    payment_review: reg.status === "payment_received_review",
    duplicate_payment: reg.status === "confirmed"
  }[n.kind];
  if (!stillTrue) {
    await rest(env, "workshop_notifications?id=eq." + encodeURIComponent(n.id), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "skipped", error: "state changed to " + reg.status })
    });
    return "skipped";
  }

  // The email carries its own token so its calendar link works on any device.
  const links = {};
  if (n.kind !== "payment_review") {
    const token = newToken();
    const saved = await rest(env, "workshop_status_tokens", {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ token_hash: await sha256Hex(token), registration_id: reg.id })
    });
    if (saved.ok) links.calendar = origin + "/api/workshops/calendar?t=" + encodeURIComponent(token);
  }

  const message = emailFor(n.kind, reg, session, links, env);
  if (!message) { await finish(false, "unknown-kind"); return "failed"; }
  const sent = await sendMail(env, { to: reg.email_normalized, subject: message.subject, text: message.text, html: message.html });
  if (!sent.ok) { await finish(false, sent.code); return "failed"; }

  // Money that needs a decision also reaches the business inbox.
  if (n.kind === "payment_review" || n.kind === "duplicate_payment") {
    await sendMail(env, {
      to: MAILBOX,
      subject: "Action needed: " + (n.kind === "payment_review" ? "workshop payment held for review" : "duplicate workshop payment"),
      text: session.title + "\nRegistration " + reg.id + "\nReason: " + (reg.review_reason || n.kind) +
        "\nAmount held: " + money(reg.amount_paid_minor, true) + "\n\nResolve it in /admin/workshops/.",
      html: "<p>" + esc(session.title) + "<br>Registration " + esc(reg.id) + "<br>Reason: " + esc(reg.review_reason || n.kind) +
        "<br>Amount held: " + esc(money(reg.amount_paid_minor, true)) + '</p><p>Resolve it in <a href="' + esc(origin) +
        '/admin/workshops/">/admin/workshops/</a>.</p>'
    });
  }
  await finish(true);
  return "sent";
}
