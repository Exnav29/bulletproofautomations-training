/* Automatic Google Calendar invitations for invitation-only sessions.
 *
 * Run by the existing dispatcher (processOutbox, every minute). The database
 * says what must change (workshop_calendar_plan: confirmed and paid, or a
 * still-eligible complimentary place, to add; refunded, cancelled or replaced
 * to remove); this module makes that change on the session's Google Calendar
 * event and records what Google confirmed (workshop_calendar_record).
 *
 *   - One GET and, only if needed, one PATCH per registration, with the
 *     event's etag (If-Match), so two runs can never overwrite each other.
 *   - sendUpdates=all: Google emails the invitation (or its cancellation) from
 *     the event's owner. Nothing here sends that email itself.
 *   - Only the account this registration added is ever removed. Anyone else on
 *     the event (the host, a co-host) is left alone.
 *   - Already there, or already gone: nothing is sent, the record is updated.
 *     Running twice, or after a duplicate payment webhook, changes nothing.
 *
 * Not routed (leading underscore). Inert until all three of
 * GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET and
 * GOOGLE_CALENDAR_REFRESH_TOKEN are set on the Pages project; until then the
 * manual panel in /admin/workshops/ works exactly as before. */

import { rpc } from "./_shared.js";
import { db } from "./_installments.js";

/* Local, non-production testing only: honoured solely for 127.0.0.1 or
   localhost, like MAIL_API_BASE, so no setting can send calendar calls elsewhere. */
function base(env, name, fallback) {
  const b = String((env && env[name]) || "");
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(b) ? b : fallback;
}

export function calendarConfigured(env) {
  return !!(env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET && env.GOOGLE_CALENDAR_REFRESH_TOKEN);
}

async function accessToken(env) {
  const res = await fetch(base(env, "GOOGLE_OAUTH_BASE", "https://oauth2.googleapis.com") + "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.GOOGLE_CALENDAR_REFRESH_TOKEN,
      client_id: env.GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET
    }).toString()
  });
  const body = await res.json().catch(function () { return null; });
  return res.ok && body && body.access_token ? body.access_token : null;
}

/* Errors that will not fix themselves: the event is gone, or Google refuses
   the address. Everything else (rate limits, 5xx, an etag race) is retried. */
function failure(status, where) {
  const permanent = status === 400 || status === 404 || status === 410;
  const text = status === 404 || status === 410 ? "The session's Google Calendar event was not found (" + where + " " + status + ")"
    : status === 400 ? "Google refused the change, usually an invalid Google account address (" + where + " 400)"
    : status === 401 || status === 403 ? "Google refused access to the calendar (" + where + " " + status + "): check the connection"
    : status === 412 ? "The event changed during the update; retrying"
    : "Google Calendar did not respond as expected (" + where + " " + status + ")";
  return { permanent: permanent, error: text };
}

const same = function (a, b) { return String(a || "").toLowerCase() === String(b || "").toLowerCase(); };

async function syncOne(env, token, item) {
  const url = base(env, "GOOGLE_API_BASE", "https://www.googleapis.com") + "/calendar/v3/calendars/" +
    encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary") + "/events/" + encodeURIComponent(item.calendar_event_id);
  const auth = { Authorization: "Bearer " + token };
  const got = await fetch(url + "?fields=etag,attendees", { headers: auth });
  if (!got.ok) return Object.assign({ ok: false }, failure(got.status, "read"));
  const event = await got.json();
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];

  let next = attendees;
  if (item.remove_email) next = next.filter(function (a) { return !same(a.email, item.remove_email); });
  if (item.add_email && !next.some(function (a) { return same(a.email, item.add_email); })) next = next.concat([{ email: item.add_email }]);

  if (next.length !== attendees.length || next.some(function (a, i) { return a !== attendees[i]; })) {
    const res = await fetch(url + "?sendUpdates=all", {
      method: "PATCH",
      headers: Object.assign({ "Content-Type": "application/json", "If-Match": event.etag }, auth),
      body: JSON.stringify({ attendees: next })
    });
    if (!res.ok) return Object.assign({ ok: false }, failure(res.status, "update"));
    await res.text();
  }
  return { ok: true };
}

/** { added, removed, failed, blocked } or { skipped: reason }. Never throws. */
export async function syncInvitations(env, test, limit) {
  const report = { added: 0, removed: 0, failed: 0, blocked: 0 };
  if (!calendarConfigured(env)) return { skipped: "not_configured" };
  const plan = await rpc(env, "workshop_calendar_plan", { p_test: test, p_limit: limit || 10 });
  const items = plan.ok && Array.isArray(plan.data) ? plan.data : [];
  if (!items.length) return report;

  let token = null;
  try { token = await accessToken(env); } catch (err) { token = null; }

  for (const item of items) {
    let out;
    if (item.blocked) {
      out = { ok: false, permanent: true, error: "Not invited: this complimentary graduate place no longer matches an active entitlement" };
      report.blocked += 1;
    } else if (!token) {
      out = { ok: false, permanent: false, error: "Could not sign in to Google Calendar: the stored authorisation was refused or Google was unreachable" };
    } else {
      try { out = await syncOne(env, token, item); }
      catch (err) { out = { ok: false, permanent: false, error: "Google Calendar was unreachable" }; }
    }
    // A void function: PostgREST answers 204, which the shared rpc() would try to parse.
    // If this write fails, the account was already recorded as managed when the run
    // claimed the registration, so a later run reconciles it (Codex audit 2, D).
    const recorded = await db(env, "rpc/workshop_calendar_record", { method: "POST", body: JSON.stringify({
      p_registration_id: item.registration_id, p_ok: out.ok,
      p_added: out.ok ? item.add_email : null, p_removed: out.ok ? item.remove_email : null,
      p_error: out.ok ? null : out.error, p_permanent: !!out.permanent
    }) }).then(function (r) { return r.text().then(function () { return r.ok; }); }).catch(function () { return false; });
    if (!recorded) report.unrecorded = (report.unrecorded || 0) + 1;
    if (out.ok) {
      if (item.add_email) report.added += 1;
      if (item.remove_email) report.removed += 1;
    } else if (!item.blocked) report.failed += 1;
  }
  return report;
}
