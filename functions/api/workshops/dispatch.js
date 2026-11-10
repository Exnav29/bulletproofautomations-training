/* POST /api/workshops/dispatch — run the outbox: reconcile open checkouts with
 * Paystack, send queued emails, keep Google Calendar invitations in step, send
 * queued Conversions API events.
 *
 * Called every minute by pg_cron + pg_net (cron job `workshop-dispatch`) with the
 * x-workshop-dispatch header, the secret read from Supabase Vault; only its
 * SHA-256 is stored (workshop_dispatch_config). Setup: docs/workshops-runbook.md,
 * "Dispatcher". The commented schedule at the end of release 1 is superseded. */

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
  // Codex audit 2, F: health covers every part of the run, and the problems that
  // persist between runs, not only what failed in this one.
  report.health = await health(env, report);
  return json({ ok: report.emails.failed === 0 && report.meta.failed === 0 && report.health.length === 0, report: report });
}

/* What still needs a person, as short codes. Empty means healthy. */
async function health(env, report) {
  const problems = [];
  const w = report.waitlist, c = report.calendar;
  if (w === null) problems.push("waitlist_not_run");
  else if (w && (w.failed || w.unrecorded)) problems.push("waitlist_email");
  if (c && (c.failed || c.unrecorded)) problems.push("calendar_sync");
  // Emails the dispatcher has given up on, failed or stranded "sending": the admin's "Retry email".
  const stuck = await rest(env, "workshop_notifications?select=id&status=in.(failed,sending)&attempts=gte.5&limit=1");
  const stuckRows = stuck.ok ? await stuck.json().catch(function () { return null; }) : null;
  if (!Array.isArray(stuckRows)) problems.push("health_check_failed");
  else if (stuckRows.length) problems.push("emails_need_retry");
  // Invitations the dispatcher has given up on (5 failures, or a permanent error): they
  // leave the plan, so this run's counts cannot show them. The admin's "Retry now".
  const cal = await rest(env, "workshop_registrations?select=id&calendar_sync_failures=gte.5&limit=1");
  const calRows = cal.ok ? await cal.json().catch(function () { return null; }) : null;
  if (!Array.isArray(calRows)) problems.push("health_check_failed");
  else if (calRows.length) problems.push("calendar_needs_retry");
  // An invitation-only session is coming up but Google Calendar is not connected.
  if (c && c.skipped === "not_configured") {
    const s = await rest(env, "workshop_sessions?select=id&admission=eq.invite&status=eq.published&starts_at=gt." +
      encodeURIComponent(new Date().toISOString()) + "&limit=1");
    const rows = s.ok ? await s.json().catch(function () { return null; }) : null;
    if (Array.isArray(rows) && rows.length) problems.push("calendar_not_configured");
  }
  return problems;
}
