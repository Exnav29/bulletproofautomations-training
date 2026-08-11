/* POST /api/gate — the name-and-email gate in front of the search box.
 *
 * Writes verification_lookups with the service key, so that table needs no
 * anon policy at all. Returns a signed, expiring pass which the page keeps in
 * localStorage; /api/verify requires it for name lookups.
 *
 * Deliberately NOT recorded: what the person went on to search for. A row
 * joining one named person to another named person they enquired about is a
 * materially more sensitive record than a marketing lead, and nothing on this
 * page needs it. See supabase-verification-lookups.sql.
 */

import { json, refuse, readJson, str, verifyTurnstile, issuePass } from "./_shared.js";

const REASONS = ["hiring", "own_credential", "considering_training", "other"];

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }

  /* Configuration is checked first, before the body is even inspected.
     A deployment missing a variable is broken for everyone regardless of what
     they sent, and reporting that immediately is what makes it diagnosable
     from outside with a single request. */
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return refuse("supabase-not-configured", 503);
  if (!env.GATE_SECRET) return refuse("gate-secret-not-configured", 503);
  if (!env.TURNSTILE_SECRET_KEY) return refuse("turnstile-not-configured", 503);

  const body = await readJson(request);
  if (!body) return refuse("bad-body");

  /* Honeypot, matching the two existing public forms. A real person never sees
     this field. Answer as though it worked — a bot that gets an error learns to
     retry, and one that gets a success learns nothing. */
  if (str(body.company_website, 400)) {
    return json({ ok: true, pass: null, trapped: true });
  }

  const fullName = str(body.full_name, 120);
  const email = str(body.email, 200).toLowerCase();
  const reason = str(body.reason, 40);
  const marketingOptIn = body.marketing_opt_in === true;

  if (fullName.length < 2) return refuse("name-too-short");
  // Deliberately loose. The only thing worth rejecting is what obviously is not
  // an address; anything stricter starts refusing real ones.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return refuse("bad-email");
  if (REASONS.indexOf(reason) === -1) return refuse("bad-reason");

  /* The challenge runs last, after our own configuration and their input have
     both been checked. Challenging someone and then telling them the service is
     switched off wastes their time on a puzzle that could never have helped. */
  const turnstile = await verifyTurnstile(env, body.turnstileToken, request);
  if (!turnstile.ok) return refuse(turnstile.reason, 403);

  const res = await fetch(env.SUPABASE_URL + "/rest/v1/verification_lookups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      // email is UNIQUE. Someone whose 30 days lapsed is a returning verifier,
      // not an error, so a duplicate is ignored rather than reported.
      Prefer: "resolution=ignore-duplicates,return=minimal"
    },
    body: JSON.stringify({
      full_name: fullName,
      email: email,
      reason: reason,
      marketing_opt_in: marketingOptIn,
      source: "verify"
    })
  });

  if (!res.ok && res.status !== 409) {
    return refuse("insert-" + res.status + ": " + (await res.text()).slice(0, 300), 502);
  }

  return json({ ok: true, pass: await issuePass(env, 30) });
}
