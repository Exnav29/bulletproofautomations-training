/* POST /api/verify — the credential lookup.
 *
 * The browser never talks to Supabase here. It posts to our own origin, which
 * is the only place Turnstile, Bot Fight Mode and the rate-limiting rule can
 * apply — Cloudflare protects this domain, not supabase.co.
 *
 * Two lookups, deliberately gated differently:
 *
 *   by ID    ungated. This is the URL a holder puts in LinkedIn's Credential
 *            URL field, and LinkedIn renders it as a "Show credential" button.
 *            Putting a name-and-email form in front of that would break every
 *            holder's credential for exactly the audience it exists to
 *            convince.
 *
 *   by name  requires a gate pass from /api/gate. Name search is our own
 *            addition — neither Cisco nor Microsoft offers one — so it carries
 *            the privacy cost, and it is the surface worth asking something
 *            for.
 *
 * Both still require a Turnstile token.
 */

import { json, refuse, readJson, str, normaliseName, verifyTurnstile, rpc, passIsValid } from "./_shared.js";

/* One handler, switching on the method itself. Exporting both onRequest and
   onRequestPost leaves which one wins up to the runtime, and a verification
   endpoint is not the place to find out. A GET here would also get crawled and
   cached, which is why it is refused outright. */
export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const body = await readJson(request);
  if (!body) return refuse("bad-body");

  const id = str(body.id, 64);
  const name = str(body.name, 120);

  // Exactly one, or the request is malformed. Accepting both would make the
  // gate on name lookups trivially bypassable by sending an ID alongside.
  if ((id && name) || (!id && !name)) return refuse("need-exactly-one-of-id-or-name");

  // Mirrors the minimums inside the SQL function. Checked here too so the
  // obvious probing never reaches the database at all.
  if (id && id.replace(/[^A-Za-z0-9]/g, "").length < 12) return refuse("id-too-short");
  if (name && name.length < 4) return refuse("name-too-short");

  /* Turnstile and the gate pass are required for NAME lookups only.
   *
   * This was not the original design — both paths were meant to carry a
   * challenge — and it changed on evidence. In testing, a browser that could
   * not obtain a Turnstile token got a 403 here, and the page rendered "no
   * credential matches": a real holder's credential reading as non-existent
   * because a third-party script did not load. On the URL printed on the
   * certificate and pasted into LinkedIn, that is the worst failure this
   * feature has.
   *
   * An ID lookup does not need the challenge to be safe. The credential ID IS
   * the access control — 19 characters with six of Crockford base32, given out
   * by the holder — which is exactly the model Cisco and Credly use: you can
   * verify anything you have been handed the identifier for. Brute force is
   * bounded by the rate-limiting rule on /api/*.
   *
   * Name lookup is the enumeration-sensitive surface, so it keeps both. */
  if (name) {
    // Same ordering as /api/gate: our own missing configuration is reported
    // before the visitor is challenged, so a broken deployment names itself
    // instead of hiding behind a 403 for the token it never received.
    if (!env.TURNSTILE_SECRET_KEY) return refuse("turnstile-not-configured", 503);
    if (!env.GATE_SECRET) return refuse("gate-secret-not-configured", 503);

    const turnstile = await verifyTurnstile(env, body.turnstileToken, request);
    if (!turnstile.ok) return refuse(turnstile.reason, 403);
    if (!(await passIsValid(env, body.pass))) return refuse("no-gate-pass", 403);
  }

  const found = await rpc(env, "verify_credential", id ? { p_id: id } : { p_name: name });
  if (!found.ok) return refuse(found.reason, 502);

  let rows = Array.isArray(found.data) ? found.data : [];

  /* Cisco's verification tool returns every certification the person holds,
     not only the one searched, and that is the right behaviour: someone who
     did Foundations and then passed BCAB should not look like they hold one
     thing. A name lookup already returns the set. An ID lookup returns one
     row, so widen it — using the holder name from the row we just matched,
     normalised the same way the trigger does.

     Safe because the widening runs server-side from an already-successful ID
     match. allow_name_lookup governs whether someone can be FOUND by name; it
     does not hide the rest of a holder's credentials from someone who already
     holds one of their IDs. */
  if (id && rows.length === 1) {
    const all = await rpc(env, "verify_credentials_for", {
      p_normalised: normaliseName(rows[0].holder_name)
    });
    if (all.ok && Array.isArray(all.data) && all.data.length > rows.length) {
      rows = all.data;
    }
  }

  const base = env.SUPABASE_URL + "/storage/v1/object/public/credentials/";

  return json({
    ok: true,
    // Which of the returned rows the visitor actually asked about, so the page
    // can lead with it and list the rest as "also holds".
    matched: id ? id.replace(/[^A-Za-z0-9]/g, "").toUpperCase() : null,
    results: rows.map(function (row) {
      return {
        credentialId: row.credential_id,
        holderName: row.holder_name,
        credential: row.credential,
        issuedOn: row.issued_on,
        expiresOn: row.expires_on,
        platformVersion: row.platform_version,
        status: row.result_status,
        pdfUrl: row.pdf_path ? base + row.pdf_path : null,
        previewUrl: row.preview_path ? base + row.preview_path : null
      };
    })
  });
}
