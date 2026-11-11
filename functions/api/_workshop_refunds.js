/* Sends a workshop refund to Paystack from the admin ("Request refund" and
   "Send refund to Paystack").

   Money only ever leaves through the WEBINAR business's key (workshopKey), on
   the transaction this site recorded for the registration. The registration
   itself is not changed here: its place is released, as before, only when
   Paystack's refund.processed webhook arrives (workshop-paystack-webhook ->
   workshop_apply_refund). So a refund that Paystack accepts but later fails
   leaves the person's place and money exactly as recorded.

   Never twice. Before sending, Paystack's own list of refunds is read and every
   refund on the same transaction that has not failed is counted, so a retry
   after a timeout, a second click, or a refund already made in the dashboard
   sends only what is left (usually nothing). If that list cannot be read, no
   refund is sent. Shape from Paystack's published OpenAPI spec
   (PaystackOSS/openapi: POST /refund, GET /refund). */

import { rest, workshopKey, workshopMode, paystackBase } from "./_workshops.js";

const HELD = "succeeded,duplicate_payment,mismatch";
const DEAD = new Set(["failed", "reversed"]);

async function paystack(env, path, init) {
  const res = await fetch(paystackBase(env) + path, {
    ...(init || {}),
    headers: { Authorization: "Bearer " + workshopKey(env), "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20000)
  });
  const body = await res.json().catch(function () { return null; });
  return { http: res.status, body };
}

/* Minor units already refunded or on their way in Paystack for one transaction;
   null when Paystack could not be asked. */
async function alreadyInPaystack(env, att) {
  const since = new Date(new Date(att.created_at).getTime() - 86400000).toISOString();
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    let out;
    try { out = await paystack(env, "/refund?perPage=100&page=" + page + "&from=" + encodeURIComponent(since)); } catch (_) { return null; }
    if (out.http !== 200 || !out.body || out.body.status !== true || !Array.isArray(out.body.data)) return null;
    for (const r of out.body.data) {
      const ref = r.transaction_reference || (r.transaction && r.transaction.reference);
      if (ref === att.reference && !DEAD.has(String(r.status || "").toLowerCase())) total += Math.max(0, Number(r.amount) || 0);
    }
    if (out.body.data.length < 100) return total;
  }
  return null; // more than 1,000 refunds since the payment: do not guess
}

const ghs = function (minor) { return "GHS " + (minor / 100).toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 }); };

/* Returns { sent: [{reference, amount_minor, id, status}], skipped: [...], problems: [text] }. */
export async function sendRefunds(env, registrationId, actorEmail) {
  const out = { sent: [], skipped: [], problems: [] };
  const mode = workshopMode(env);
  if (mode === "off") { out.problems.push("Paystack is not configured on the site, so nothing was sent. Refund it in the Paystack dashboard."); return out; }

  const res = await rest(env, "workshop_payment_attempts?select=id,reference,status,mode,received_minor,refunded_minor,created_at" +
    "&registration_id=eq." + encodeURIComponent(registrationId) + "&status=in.(" + HELD + ")&order=created_at.asc");
  const atts = res.ok ? await res.json().catch(function () { return null; }) : null;
  if (!Array.isArray(atts)) { out.problems.push("The payment record could not be read, so nothing was sent. Try again."); return out; }

  for (const att of atts) {
    const received = Number(att.received_minor || 0);
    if (received <= 0 || received - Number(att.refunded_minor || 0) <= 0) continue;
    if (att.mode !== mode) {
      out.problems.push(att.reference + " was a " + att.mode + " payment and the site is using " + mode + " keys, so it was not refunded from here.");
      continue;
    }
    const inPaystack = await alreadyInPaystack(env, att);
    if (inPaystack === null) {
      out.problems.push("Paystack's refund list could not be checked for " + att.reference + ", so nothing was sent for it. Try again in a minute.");
      continue;
    }
    const amount = received - inPaystack;
    if (amount <= 0) { out.skipped.push({ reference: att.reference, reason: "already_refunded_in_paystack" }); continue; }

    let made;
    try {
      made = await paystack(env, "/refund", { method: "POST", body: JSON.stringify({
        transaction: att.reference, amount, currency: "GHS",
        merchant_note: "Workshop refund requested in the admin by " + actorEmail
      }) });
    } catch (_) {
      out.problems.push("No answer from Paystack for " + att.reference + ". It may or may not have been sent: use Send refund to Paystack again, which checks first and never sends twice.");
      continue;
    }
    const d = made.body && made.body.data;
    if (made.http >= 200 && made.http < 300 && made.body && made.body.status === true && d) {
      out.sent.push({ reference: att.reference, amount_minor: amount, id: d.id == null ? null : String(d.id), status: String(d.status || "pending") });
    } else {
      const msg = made.body && typeof made.body.message === "string" ? made.body.message.slice(0, 200) : "HTTP " + made.http;
      out.problems.push("Paystack refused the refund of " + ghs(amount) + " on " + att.reference + ": " + msg);
    }
  }
  return out;
}

/* One line for the registration's notes, and one sentence for the admin. */
export function refundNote(r) {
  const parts = r.sent.map(function (s) { return "Paystack refund " + (s.id || "?") + " " + s.status + ", " + ghs(s.amount_minor) + " on " + s.reference; });
  r.skipped.forEach(function (s) { parts.push(s.reference + " already refunded in Paystack; nothing sent"); });
  return parts.concat(r.problems).join("; ").slice(0, 300);
}
export function refundSentence(r) {
  const total = r.sent.reduce(function (n, s) { return n + s.amount_minor; }, 0);
  const attention = r.sent.some(function (s) { return /attention/i.test(s.status); });
  let text = r.sent.length
    ? "Paystack is refunding " + ghs(total) + ". The place frees itself and the Calendar invitation is removed when Paystack confirms the refund."
    : r.skipped.length && !r.problems.length ? "Paystack already has this refund. The place frees itself when Paystack confirms it." : "";
  if (attention) text += " Paystack needs the customer's account details for this refund: finish it in the Paystack dashboard under Refunds.";
  if (r.problems.length) text += (text ? " " : "") + r.problems.join(" ");
  return text.trim();
}
