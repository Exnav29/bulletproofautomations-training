/* POST /api/workshops/register — register for one webinar or workshop, and
 * start a Paystack checkout when the session is paid and checkout is open.
 *
 * Separate from /api/enroll on purpose: the cohort endpoint, its option set,
 * its acknowledgements and the enrollments table are unchanged.
 *
 * What the browser can and cannot decide:
 *   - It names a session by slug. The database decides whether it is open,
 *     what it costs, and whether there is a seat.
 *   - It may echo the price and start time it displayed; if those disagree
 *     with the database nobody is registered (stale page), so no one pays a
 *     number they did not see.
 *   - It never sends an amount that is used for anything.
 *
 * Response bodies carry no personal data beyond what the visitor just typed
 * (none is echoed), plus a status token for THIS browser. */

import { json, refuse, readJson, str, rpc } from "../_shared.js";
import { resolveTier, channelsFor } from "../_regions.js";
import {
  WORKSHOP_APP, TERMS_VERSION, mintWorkshopReference, newToken, sha256Hex,
  checkoutMode, cleanAttribution, eventIds, processOutbox, initializeWorkshopCheckout, rpcVoid, sessionAdmission
} from "../_workshops.js";

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function stateFor(status, paymentStatus) {
  if (status === "confirmed") return "confirmed";
  if (status === "payment_received_review" || status === "refund_pending") return "payment_review";
  if (paymentStatus === "needs_review") return "needs_attention";
  if (status === "pending_payment") return "pending_payment";
  return "unavailable";
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request, 4096);
  if (!body) return refuse("bad-body");

  // Honeypot: told it worked, learns nothing.
  if (str(body.company_website, 200)) return json({ ok: true, state: "pending_payment" });

  const slug = str(body.slug, 80);
  const fullName = str(body.full_name, 120);
  const email = str(body.email, 160).toLowerCase();
  const whatsapp = str(body.whatsapp, 40);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return refuse("slug-invalid");
  if (fullName.length < 2) return refuse("name-missing");
  if (!looksLikeEmail(email)) return refuse("email-invalid");
  if (whatsapp && whatsapp.replace(/\D/g, "").length < 7) return refuse("whatsapp-invalid");
  if (body.ack_terms !== true) return refuse("terms-not-accepted");
  // The Google account the participant will join with, which may differ from
  // the payment email. Required for an invitation-only session.
  const attendEmail = str(body.attend_email, 160).toLowerCase();
  if (attendEmail && !looksLikeEmail(attendEmail)) return refuse("attend-email-invalid");

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return refuse("supabase-not-configured", 503);
  if (!attendEmail && await sessionAdmission(env, slug) === "invite") {
    return json({ ok: false, code: "attend_email_required" }, 400);
  }

  const adConsent = body.ad_consent === true;
  const displayedPrice = typeof body.displayed_price === "number" && isFinite(body.displayed_price) ? body.displayed_price : null;
  const displayedStart = typeof body.displayed_starts_at === "string" && !isNaN(Date.parse(body.displayed_starts_at))
    ? new Date(body.displayed_starts_at).toISOString() : null;

  const token = newToken();
  const registered = await rpc(env, "workshop_register", {
    p_slug: slug,
    p_email: email,
    p_full_name: fullName,
    p_whatsapp: whatsapp || null,
    p_whatsapp_consent: whatsapp ? body.whatsapp_consent === true : false,
    p_terms_version: TERMS_VERSION,
    p_token_hash: await sha256Hex(token),
    p_attribution: cleanAttribution(body.attribution, request, adConsent),
    p_ad_consent: adConsent,
    p_displayed_price: displayedPrice,
    p_displayed_starts_at: displayedStart
  });
  if (!registered.ok) {
    console.log("workshop-register-failed:", registered.reason);
    return refuse("register-failed", 502);
  }

  const r = registered.data || {};
  if (r.outcome === "not_found") return json({ ok: false, code: "not_found" }, 404);
  if (r.outcome === "closed") return json({ ok: false, code: "closed" }, 409);
  if (r.outcome === "full") return json({ ok: false, code: "full" }, 409);
  if (r.outcome === "stale_page") return json({ ok: false, code: "stale_page" }, 409);
  if (r.outcome !== "created" && r.outcome !== "existing") return refuse("register-unexpected", 502);

  // First write wins (the RPC only fills an empty value), so re-submitting the
  // form with someone else's payment email cannot redirect their invitation.
  if (attendEmail) {
    const saved = await rpcVoid(env, "workshop_set_attend_email", { p_registration_id: r.registration_id, p_email: attendEmail });
    if (!saved.ok) console.log("workshop-attend-email-not-saved:", saved.reason);
  }

  const ids = eventIds(r.registration_id);
  const origin = new URL(request.url).origin;
  const base = { ok: true, token: token, registration: r.outcome, events: {} };

  if (r.status !== "pending_payment" || r.payment_status === "needs_review") {
    const state = stateFor(r.status, r.payment_status);
    if (state === "confirmed" && r.outcome === "created" && Number(r.price_ghs) === 0) {
      base.events.complete_registration = ids.complete_registration;
      // Send the confirmation now rather than waiting for the next sweep.
      if (context.waitUntil) context.waitUntil(processOutbox(env, origin, { emails: 3, meta: 3, reconcile: 0 }).catch(function () {}));
    }
    return json(Object.assign(base, { state: state }));
  }

  // Paid session, payment outstanding.
  const mode = checkoutMode(env, body.testOptIn === true);
  if (!mode) {
    return json(Object.assign(base, { state: "pending_payment", checkout: "unavailable" }));
  }

  const reference = mintWorkshopReference(mode);
  const started = await rpc(env, "workshop_start_attempt", {
    p_registration_id: r.registration_id, p_reference: reference, p_mode: mode
  });
  if (!started.ok) {
    console.log("workshop-start-failed:", started.reason);
    return json(Object.assign(base, { state: "pending_payment", checkout: "unavailable", retry: true }));
  }
  const s = started.data || {};
  if (s.outcome === "already_paid") return json(Object.assign(base, { state: stateFor(s.status, "paid") }));
  if (s.outcome === "full") return json({ ok: false, code: "full" }, 409);
  if (s.outcome === "closed") return json({ ok: false, code: "closed" }, 409);
  if (s.outcome !== "started") return json(Object.assign(base, { state: "needs_attention" }));

  const region = resolveTier(request, env, body.declared_country);
  const init = await initializeWorkshopCheckout(env, {
    email: email,
    amountMinor: Number(s.amount_minor),
    reference: reference,
    callbackUrl: origin + "/workshops/registered/?session=" + encodeURIComponent(slug),
    channels: channelsFor(region.tier),
    metadata: {
      app: WORKSHOP_APP,
      workshop_registration_id: r.registration_id,
      workshop_session: slug,
      custom_fields: [
        { display_name: "Registering for", variable_name: "workshop", value: slug },
        { display_name: "Full name", variable_name: "full_name", value: fullName }
      ]
    }
  });

  if (!init.ok) {
    // The attempt keeps its reference; it is marked, not deleted. A retry mints a new one.
    console.log("workshop-initialize-failed:", init.reason);
    await rpcVoid(env, "workshop_attempt_init_failed", { p_reference: reference, p_note: init.reason });
    return json(Object.assign(base, { state: "pending_payment", checkout: "unavailable", retry: true }));
  }

  base.events.initiate_checkout = ids.initiate_checkout;
  return json(Object.assign(base, {
    state: "checkout", url: init.url, reference: reference, test: mode === "test"
  }));
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
}
