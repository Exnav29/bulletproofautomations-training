/* Shared helpers for the /api/* Cloudflare Pages Functions.
 *
 * Files and directories under functions/ whose name begins with an underscore
 * are not routed, so this never becomes an endpoint of its own.
 *
 * These functions exist so the browser never talks to Supabase on /verify. The
 * anon key is public by design, which means an attacker can skip the site and
 * call Supabase directly — and Cloudflare protects our domain, not theirs. So
 * the lookup moves behind our own origin, where Turnstile, Bot Fight Mode and
 * the rate-limiting rule actually apply.
 */

export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  // These answers are per-request and per-person. Nothing about them should
  // sit in a shared cache.
  "Cache-Control": "no-store"
};

export function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: JSON_HEADERS
  });
}

/* A deliberately vague failure. Telling a prober which part of the request they
   got wrong is telling them how to get it right. The specific reason is still
   logged for us.

   The exception is 503 — a missing environment variable is OUR failure, not a
   probe, and hiding it produced a real incident: the page told a visitor "we
   could not save that", implying their details were rejected, when in fact the
   service was never switched on. Nobody can exploit "this site is not
   configured", and pretending otherwise wastes the operator's afternoon. */
export function refuse(reason, status) {
  console.log("refused:", reason);
  const code = status || 400;
  if (code === 503) {
    return json({ ok: false, code: "not_configured", detail: reason, error: "Verification is not switched on yet." }, 503);
  }
  return json({ ok: false, error: "That request could not be completed." }, code);
}

/* Bodies here are tiny. Anything large is not a mistake, it is an attempt. */
export async function readJson(request, limit) {
  const type = request.headers.get("content-type") || "";
  if (type.indexOf("application/json") === -1) return null;

  const text = await request.text();
  if (text.length > (limit || 2048)) return null;

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

export function str(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > (max || 200) ? "" : trimmed;
}

/* The same three operations the database trigger applies, in the same order:
   lowercase, trim, collapse internal whitespace. No accent folding — see
   supabase-credentials.sql. If these ever diverge, name lookup silently stops
   matching and nothing errors. */
export function normaliseName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/* Turnstile. Verified server-side, because a token the client claims to have
   is not a token. Absent configuration is a hard failure rather than a quiet
   bypass: a bot check that silently stops checking is worse than none, because
   it is believed. */
export async function verifyTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: false, reason: "turnstile-not-configured" };
  if (!token || typeof token !== "string" || token.length > 4096) {
    return { ok: false, reason: "turnstile-token-missing" };
  }

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);

  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form
    });
    const data = await res.json();
    return data.success
      ? { ok: true }
      : { ok: false, reason: "turnstile-rejected: " + JSON.stringify(data["error-codes"] || []) };
  } catch (err) {
    return { ok: false, reason: "turnstile-unreachable" };
  }
}

/* Call a Postgres function through PostgREST with the service key.
   Only ever an RPC — there is no table read anywhere in this codepath, because
   the functions are the only thing EXECUTE is granted on. */
export async function rpc(env, name, args) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, reason: "supabase-not-configured" };
  }

  const res = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
    },
    body: JSON.stringify(args)
  });

  if (!res.ok) {
    return { ok: false, reason: "rpc-" + name + "-" + res.status + ": " + (await res.text()).slice(0, 300) };
  }
  return { ok: true, data: await res.json() };
}

/* ---------------------------------------------------------------------------
   The gate pass.

   A signed, expiring note that says "this browser gave us a name and an email".
   /api/verify requires one for NAME lookups only; lookups by credential ID stay
   open, because that is the URL holders put on LinkedIn and gating it would
   break the Show credential button for every recruiter who clicks it.

   HMAC rather than a random token in a table: it needs no storage, no cleanup,
   and cannot be enumerated. It is a marketing gate, not an authorisation
   boundary, and is sized accordingly.
   --------------------------------------------------------------------------- */

const encoder = new TextEncoder();

function base64url(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function issuePass(env, days) {
  if (!env.GATE_SECRET) return null;
  const expires = Date.now() + (days || 30) * 86400000;
  const payload = String(expires);
  return payload + "." + (await sign(env.GATE_SECRET, payload));
}

export async function passIsValid(env, pass) {
  if (!env.GATE_SECRET) return false;
  if (typeof pass !== "string" || pass.length > 200) return false;

  const dot = pass.lastIndexOf(".");
  if (dot < 1) return false;

  const payload = pass.slice(0, dot);
  const expires = Number(payload);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;

  const expected = await sign(env.GATE_SECRET, payload);
  const given = pass.slice(dot + 1);
  if (expected.length !== given.length) return false;

  // Constant-time-ish compare. The stakes are low, but variable-time string
  // comparison on a signature is the kind of habit worth not forming.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
