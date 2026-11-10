/* POST /api/workshops/status  { token, reference? }
 *
 * What one browser may know about the registration it made. Requires the
 * status token issued to that browser (only its hash is stored). A payment
 * reference alone reveals nothing: a wrong token, a missing reference and a
 * reference belonging to someone else all answer the same { state: "unknown" }.
 *
 * With a valid token and a still-open attempt, this may ask Paystack directly
 * whether THAT reference was paid and apply the answer through the same
 * idempotent RPC the webhook uses. It can only move the record to Paystack's
 * own truth; it can never change a name, email, session or amount. Throttled
 * to one Paystack call per reference per 10 seconds in the database.
 *
 * No name, email or WhatsApp is ever returned. */

import { json, readJson, rpc } from "../_shared.js";
import { sha256Hex, looksLikeToken, looksLikeReference, verifyAndApply, eventIds, processOutbox, sessionAdmission } from "../_workshops.js";

const UNKNOWN = { ok: true, state: "unknown" };

function publicState(s) {
  if (s.status === "confirmed") return "confirmed";
  if (s.status === "payment_received_review" || s.status === "refund_pending") return "payment_review";
  if (s.status === "refunded") return "refunded";
  if (s.status === "cancelled") return "cancelled";
  if (s.payment_status === "needs_review") return "needs_attention";
  if (s.attempt_status === "init_failed") return "checkout_failed";
  return "pending_payment";
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, code: "not_configured" }, 503);
  const body = await readJson(request, 512);
  if (!body || !looksLikeToken(body.token)) return json(UNKNOWN);
  const reference = body.reference == null ? null : body.reference;
  if (reference !== null && !looksLikeReference(reference)) return json(UNKNOWN);

  const hash = await sha256Hex(body.token);
  let found = await rpc(env, "workshop_status_for_token", { p_token_hash: hash, p_reference: reference });
  if (!found.ok) return json({ ok: false, code: "unavailable" }, 503);
  let s = found.data || {};
  if (s.state !== "known") return json(UNKNOWN);

  // Returned from Paystack before the webhook: confirm server-side.
  if (reference && s.status === "pending_payment" && (s.attempt_status === "initialized" || s.attempt_status === "init_failed")) {
    const applied = await verifyAndApply(env, reference);
    if (applied) {
      found = await rpc(env, "workshop_status_for_token", { p_token_hash: hash, p_reference: reference });
      if (found.ok && found.data && found.data.state === "known") s = found.data;
      const origin = new URL(request.url).origin;
      if (context.waitUntil) context.waitUntil(processOutbox(env, origin, { emails: 3, meta: 3, reconcile: 0 }).catch(function () {}));
    }
  }

  const state = publicState(s);
  const ids = eventIds(s.registration_id);
  const paid = s.payment_status === "paid" || s.payment_status === "needs_review" || s.payment_status === "partially_refunded";
  const events = {};
  /* Purchase = a CONFIRMED PAID ENROLLMENT: confirmed, with money Paystack
     verified. A return from Paystack on its own never produces one, and nor
     does money held for review: that may still be refunded, and is reported
     only if an admin admits it. Same definition as the Conversions API outbox
     (workshop_apply_charge / workshop_admin_action) and the admin campaign
     report, with the same event id, so Meta counts each enrollment once. */
  if (paid && state === "confirmed" && Number(s.amount_ghs) > 0) {
    events.purchase = { id: ids.purchase, value: Number(s.amount_ghs), currency: "GHS" };
  }
  if (state === "confirmed" && Number(s.amount_ghs) === 0) events.complete_registration = { id: ids.complete_registration };

  return json({
    ok: true,
    state: state,
    test: s.attempt_mode === "test",
    review_reason: s.review_reason || null,
    email_sent: s.email_sent === true,
    amount_ghs: Number(s.amount_ghs),
    // How this session is joined: an invitation-only session explains the
    // Google Calendar invitation instead of a joining link.
    session: s.session ? Object.assign({}, s.session, { admission: await sessionAdmission(env, s.session.slug) }) : s.session,
    events: events
  });
}
