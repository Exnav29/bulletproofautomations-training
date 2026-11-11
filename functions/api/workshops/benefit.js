/* POST /api/workshops/benefit — prove you hold a certificate before its price
 * applies (Foundations) or its reserved place is given (Intermediate graduate).
 *
 *   { step: "request", slug, email, certificate_id }
 *       If the certificate is eligible for this session and not yet redeemed
 *       for it:
 *         - the email is the one on the certificate (or one the admin
 *           authorised): verified at once, and the answer carries the token;
 *         - any other email: a 6-digit code goes to the address ON THE
 *           CERTIFICATE, never to the one typed, so a copied ID is useless.
 *       Otherwise the answer is the generic one, the same as when a code is sent.
 *   { step: "confirm", slug, email, certificate_id, code }
 *       A correct code within 10 minutes and 5 tries returns a 30-minute,
 *       single-use verification token, which registration spends.
 *
 * The code and the token are stored only as SHA-256 hashes. Throttled in the
 * database to 3 codes an hour per certificate and per address. */

import { json, refuse, readJson, str, rpc } from "../_shared.js";
import { sha256Hex, newToken } from "../_workshops.js";
import { sendMail, esc } from "../_mail.js";

const GENERIC = { ok: true, sent: "if_eligible" };

function looksLikeEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value); }

function sixDigits() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1000000).padStart(6, "0");
}

export async function onRequestPost({ request, env }) {
  const body = await readJson(request, 2048);
  if (!body) return refuse("bad-body");
  const slug = str(body.slug, 80);
  const email = str(body.email, 160).toLowerCase();
  const cred = str(body.certificate_id, 40).toUpperCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || !looksLikeEmail(email) || !/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(cred)) {
    return json({ ok: false, code: "invalid" }, 400);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return refuse("supabase-not-configured", 503);
  const bind = function (code) { return sha256Hex([slug, cred, email, code].join("|")); };

  if (body.step === "request") {
    const code = sixDigits();
    const token = newToken();
    const out = await rpc(env, "workshop_benefit_request", { p_slug: slug, p_email: email, p_credential_id: cred,
      p_code_hash: await bind(code), p_token_hash: await sha256Hex(token) });
    if (!out.ok) return json({ ok: false, code: "unavailable" }, 503);
    if (out.data && out.data.verified === true) return json({ ok: true, verified: true, verification: token, tier: out.data.tier });
    if (out.data && out.data.send === true) {
      const text = "Your Bulletproof Automations verification code is " + code + ".\n\n" +
        "Someone is registering for a workshop with your certificate, using the email " + email + ". " +
        "If that is you, enter this code on the registration form. It expires in 10 minutes and works once.\n\n" +
        "If you did not ask for it, ignore this email. Nobody can use your certificate without this code.\n\nBulletproof Automations Training";
      const sent = await sendMail(env, {
        to: out.data.to,
        subject: "Your verification code: " + code,
        text: text,
        html: '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#10251d;background:#f3efe5;padding:24px">' +
          '<p>Your Bulletproof Automations verification code is</p><p style="font-size:28px;font-weight:700;letter-spacing:.2em">' + esc(code) + "</p>" +
          "<p>Someone is registering for a workshop with your certificate, using the email " + esc(email) + ". " +
          "If that is you, enter this code on the registration form. It expires in 10 minutes and works once.</p>" +
          "<p>If you did not ask for it, ignore this email. Nobody can use your certificate without this code.</p></body></html>"
      });
      if (!sent.ok) console.log("workshop-benefit-mail-failed:", sent.code);
    } else if (out.data) {
      console.log("workshop-benefit-not-sent:", out.data.why);
    }
    return json(GENERIC);
  }

  if (body.step === "confirm") {
    const code = str(body.code, 6);
    if (!/^[0-9]{6}$/.test(code)) return json({ ok: false, code: "code_invalid" }, 400);
    const token = newToken();
    const out = await rpc(env, "workshop_benefit_confirm", {
      p_slug: slug, p_email: email, p_credential_id: cred, p_code_hash: await bind(code), p_token_hash: await sha256Hex(token)
    });
    if (!out.ok) return json({ ok: false, code: "unavailable" }, 503);
    if (!out.data || out.data.ok !== true) return json({ ok: false, code: "code_invalid", remaining: Number((out.data && out.data.remaining) || 0) }, 400);
    return json({ ok: true, verification: token, tier: out.data.tier });
  }
  return json({ ok: false, code: "invalid" }, 400);
}
