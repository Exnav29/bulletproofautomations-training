/* POST /api/workshops/dispatch — run the outbox: reconcile open checkouts with
 * Paystack, send queued emails, keep Google Calendar invitations in step, send
 * queued Conversions API events.
 *
 * Called every five minutes by pg_cron + pg_net with the x-workshop-dispatch
 * header; only the SHA-256 of that secret is stored
 * (workshop_dispatch_config), the same pattern as the installment scheduler. */

import { json } from "../_shared.js";
import { rest, sha256Hex, processOutbox } from "../_workshops.js";

async function authorized(env, request) {
  const supplied = request.headers.get("x-workshop-dispatch") || "";
  if (!supplied || supplied.length > 200) return false;
  const res = await rest(env, "workshop_dispatch_config?select=secret_hash&id=eq.true&limit=1");
  if (!res.ok) return false;
  const row = (await res.json().catch(function () { return []; }))[0];
  if (!row || !row.secret_hash) return false;
  const given = await sha256Hex(supplied);
  let diff = given.length ^ row.secret_hash.length;
  for (let i = 0; i < given.length && i < row.secret_hash.length; i++) diff |= given.charCodeAt(i) ^ row.secret_hash.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, error: "not_configured" }, 503);
  if (!(await authorized(env, request))) return json({ ok: false, error: "not_authorized" }, 403);
  const report = await processOutbox(env, new URL(request.url).origin);
  return json({ ok: report.emails.failed === 0 && report.meta.failed === 0 && !(report.calendar && report.calendar.failed), report: report });
}
