/* POST /api/workshops/quote — the price this customer will pay, before
 * checkout: { slug, email, ref, verification }. Computed by the same database
 * function registration uses, so the figure shown is the figure charged.
 * Writes nothing. Says whether a referral code is valid (codes are meant to
 * be shared) but nothing about anyone's certificate. */

import { json, refuse, readJson, str, rpc } from "../_shared.js";
import { sha256Hex, looksLikeToken, workshopMode } from "../_workshops.js";

export async function onRequestPost({ request, env }) {
  const body = await readJson(request, 2048);
  if (!body) return refuse("bad-body");
  const slug = str(body.slug, 80);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return json({ ok: false, code: "not_found" }, 404);
  const email = str(body.email, 160).toLowerCase();
  const ref = str(body.ref, 16).toUpperCase();
  if (ref && !/^[A-Z0-9]{4,16}$/.test(ref)) return json({ ok: false, code: "referral_invalid" }, 200);
  const verification = typeof body.verification === "string" && looksLikeToken(body.verification) ? body.verification : "";
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return refuse("supabase-not-configured", 503);

  const out = await rpc(env, "workshop_quote", {
    p_slug: slug, p_email: email, p_referral_code: ref || null, p_token_hash: verification ? await sha256Hex(verification) : null,
    p_deployment_mode: workshopMode(env)
  });
  if (!out.ok) return json({ ok: false, code: "unavailable" }, 503);
  const q = out.data || {};
  // A self-referral reads as an invalid code: telling them apart would reveal whose code it is.
  const error = q.error === "referral_self" ? "referral_invalid" : q.error;
  if (q.ok !== true) return json({ ok: false, code: error || "unavailable" }, error === "not_found" ? 404 : 200);
  return json({
    ok: true,
    tier: q.tier,
    list_price_ghs: Number(q.list_price_ghs),
    discount_kind: q.discount_kind || null,
    discount_ghs: Number(q.discount_ghs),
    price_ghs: Number(q.price_ghs),
    referral: q.referral_code ? "applied" : null
  });
}
