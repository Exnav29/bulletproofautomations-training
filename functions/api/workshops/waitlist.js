/* /api/workshops/waitlist
 *   POST { action: "join", slug, full_name, email, attend_email, whatsapp, whatsapp_consent, ref, verification }
 *        No payment is involved. Answers joined/already with the queue position only.
 *   POST { action: "decline", offer }   gives a held place back at once
 *   GET  ?offer=<token>                 the offer's own details, to fill in the form
 * Everything is decided by the database (migration 20261111120000). */

import { json, refuse, readJson, str, rpc } from "../_shared.js";
import { sha256Hex, looksLikeToken, workshopMode, processOutbox } from "../_workshops.js";

function looksLikeEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value); }

export async function onRequestGet({ request, env }) {
  const offer = new URL(request.url).searchParams.get("offer") || "";
  if (!looksLikeToken(offer)) return json({ ok: false, code: "offer_not_valid" }, 404);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return refuse("supabase-not-configured", 503);
  const out = await rpc(env, "workshop_waitlist_offer", { p_token_hash: await sha256Hex(offer) });
  if (!out.ok) return json({ ok: false, code: "unavailable" }, 503);
  if (!out.data) return json({ ok: false, code: "offer_not_valid" }, 404);
  return json({ ok: true, offer: out.data });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await readJson(request, 4096);
  if (!body) return refuse("bad-body");
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return refuse("supabase-not-configured", 503);

  if (body.action === "decline") {
    const offer = typeof body.offer === "string" && looksLikeToken(body.offer) ? body.offer : "";
    if (!offer) return json({ ok: false, code: "offer_not_valid" }, 404);
    const out = await rpc(env, "workshop_waitlist_decline", { p_token_hash: await sha256Hex(offer) });
    if (!out.ok) return json({ ok: false, code: "unavailable" }, 503);
    if (!out.data || out.data.ok !== true) return json({ ok: false, code: "offer_not_valid" }, 404);
    // Offer the place to the next person now rather than at the next run.
    if (context.waitUntil) context.waitUntil(processOutbox(env, new URL(request.url).origin, { emails: 0, meta: 0, reconcile: 0, calendar: 0 }).catch(function () {}));
    return json({ ok: true, declined: true });
  }

  if (body.action !== "join") return refuse("bad-action");
  if (str(body.company_website, 200)) return json({ ok: true, outcome: "joined" }); // honeypot
  const slug = str(body.slug, 80);
  const email = str(body.email, 160).toLowerCase();
  const fullName = str(body.full_name, 120);
  const attend = str(body.attend_email, 160).toLowerCase();
  const whatsapp = str(body.whatsapp, 40);
  const ref = str(body.ref, 16).toUpperCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return refuse("slug-invalid");
  if (fullName.length < 2) return refuse("name-missing");
  if (!looksLikeEmail(email)) return refuse("email-invalid");
  if (attend && !looksLikeEmail(attend)) return refuse("attend-email-invalid");
  if (ref && !/^[A-Z0-9]{4,16}$/.test(ref)) return json({ ok: false, code: "referral_invalid" }, 409);
  if (body.ack_terms !== true) return refuse("terms-not-accepted");
  const verification = typeof body.verification === "string" && looksLikeToken(body.verification) ? body.verification : "";

  const out = await rpc(env, "workshop_waitlist_join", {
    p_slug: slug, p_email: email, p_full_name: fullName, p_whatsapp: whatsapp || null,
    p_whatsapp_consent: whatsapp ? body.whatsapp_consent === true : false, p_attend_email: attend || null,
    p_referral_code: ref || null, p_benefit_token_hash: verification ? await sha256Hex(verification) : null,
    p_deployment_mode: workshopMode(env)
  });
  if (!out.ok) return refuse("waitlist-failed", 502);
  const r = out.data || {};
  if (r.outcome === "joined" || r.outcome === "already") {
    // The confirmation email goes now rather than at the next run.
    if (r.outcome === "joined" && context.waitUntil) {
      context.waitUntil(processOutbox(env, new URL(request.url).origin, { emails: 0, meta: 0, reconcile: 0, calendar: 0 }).catch(function () {}));
    }
    return json({ ok: true, outcome: r.outcome, position: Number(r.position) });
  }
  const status = { not_found: 404, closed: 409, not_full: 409, registered: 409, invalid: 400 }[r.outcome] || 502;
  return json({ ok: false, code: r.outcome || "unexpected" }, status);
}
