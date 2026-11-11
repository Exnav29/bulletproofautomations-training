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
  if (res.ok && body && body.access_token) return { token: body.access_token };
  // Google's own reason (e.g. invalid_grant, invalid_client), never a credential, so
  // the stored error says whether to reauthorise or simply retry.
  const why = body && typeof body.error === "string"
    ? body.error + (typeof body.error_description === "string" ? ": " + body.error_description : "") : "no reason given";
  return { token: null, error: "Google refused the stored authorisation (token " + res.status + ", " + why.slice(0, 160) + ")" };
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

  let token = null, signInError = "Could not sign in to Google Calendar: Google was unreachable";
  try {
    const got = await accessToken(env);
    token = got.token;
    if (!token) signInError = "Could not sign in to Google Calendar: " + got.error;
  } catch (err) { token = null; }

  for (const item of items) {
    let out;
    if (item.blocked) {
      out = { ok: false, permanent: true, error: "Not invited: this complimentary graduate place no longer matches an active entitlement" };
      report.blocked += 1;
    } else if (!token) {
      out = { ok: false, permanent: false, error: signInError };
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

/* ---------------------------------------------------------------------------
   Release 7: the workshop's own event, created and kept in step automatically.

   ensureEvent() creates the event, with its own Google Meet link, the first
   time an invitation-only workshop is scheduled. updateEvent() moves it when the
   date or length changes and emails the people already invited.

   Never a duplicate: the event's ID is derived from the workshop's ID, so a
   retried save, a double click or a lost response asks Google for the same
   event again. Google answers 409 for an ID it already has; the existing event
   is then read back and used (and restored, if it had been deleted).

   Guests cannot change the event, invite others or see the guest list. Meet's
   own "Restricted" access is not something Calendar can set; see the runbook.
   ------------------------------------------------------------------------- */
const TZ = "Africa/Accra";
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/** Google event IDs use base32hex (0-9, a-v); a UUID's hex digits are all in it. */
export function eventIdFor(sessionId) {
  return "bpa" + String(sessionId || "").toLowerCase().replace(/[^0-9a-f]/g, "");
}

function eventsUrl(env) {
  return base(env, "GOOGLE_API_BASE", "https://www.googleapis.com") + "/calendar/v3/calendars/" +
    encodeURIComponent(env.GOOGLE_CALENDAR_ID || "primary") + "/events";
}

function times(s) {
  const start = new Date(s.starts_at);
  const end = new Date(start.getTime() + Number(s.duration_minutes || 0) * 60000);
  return { start: { dateTime: start.toISOString(), timeZone: TZ }, end: { dateTime: end.toISOString(), timeZone: TZ } };
}

function details(s, origin) {
  const summary = s.content && typeof s.content.summary === "string" ? s.content.summary : "";
  return {
    summary: (s.is_test ? "TEST: " : "") + s.title,
    description: (summary ? summary + "\n\n" : "") +
      "Join with the Google account this invitation was sent to. The invitation is personal: please don't forward it.\n\n" +
      "Workshop page: " + origin + "/workshops/" + s.slug + "\n" +
      "Questions: info@bulletproofautomations.com",
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    guestsCanModify: false
  };
}

/** What Google was last told, so the database knows when the event is out of step. */
export function syncedFrom(s) {
  return { starts_at: new Date(s.starts_at).toISOString(), duration_minutes: Number(s.duration_minutes), title: s.title };
}

async function signIn(env) {
  if (!calendarConfigured(env)) return { error: "Google Calendar isn't connected, so the event can't be created. The connection is set on the Cloudflare Pages project (see the runbook)." };
  try {
    const got = await accessToken(env);
    return got.token ? { token: got.token } : { error: "Could not sign in to Google Calendar: " + got.error };
  } catch (err) { return { error: "Could not sign in to Google Calendar: Google was unreachable" }; }
}

function meetLink(event) {
  const link = event && typeof event.hangoutLink === "string" ? event.hangoutLink : "";
  return /^https:\/\/meet\.google\.com\/[a-z0-9-]{3,60}$/.test(link) ? link : "";
}

/** { ok: true, event_id, meet_link, managed: true, synced } or { ok: false, error }. Never throws. */
export async function ensureEvent(env, s, origin) {
  if (!s || !s.id || !s.starts_at) return { ok: false, error: "Set a date first." };
  const auth = await signIn(env);
  if (!auth.token) return { ok: false, error: auth.error };
  const headers = { Authorization: "Bearer " + auth.token, "Content-Type": "application/json" };
  const id = eventIdFor(s.id);
  const body = Object.assign({ id: id }, details(s, origin), times(s), {
    conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } }
  });
  try {
    let event = null;
    const made = await fetch(eventsUrl(env) + "?conferenceDataVersion=1&sendUpdates=none", { method: "POST", headers: headers, body: JSON.stringify(body) });
    if (made.ok) event = await made.json();
    else if (made.status === 409) {
      // Already created by an earlier attempt: use it, and restore it if it was deleted.
      await made.text();
      const got = await fetch(eventsUrl(env) + "/" + id, { headers: headers });
      if (!got.ok) return Object.assign({ ok: false }, failure(got.status, "read"));
      event = await got.json();
      if (event.status === "cancelled" || !meetLink(event)) {
        const fix = Object.assign({ status: "confirmed" }, details(s, origin), times(s),
          meetLink(event) ? {} : { conferenceData: body.conferenceData });
        const res = await fetch(eventsUrl(env) + "/" + id + "?conferenceDataVersion=1&sendUpdates=none", { method: "PATCH", headers: headers, body: JSON.stringify(fix) });
        if (!res.ok) return Object.assign({ ok: false }, failure(res.status, "restore"));
        event = await res.json();
      }
    } else {
      await made.text();
      return Object.assign({ ok: false }, failure(made.status, "create"));
    }
    // Google may take a moment to attach the Meet link.
    for (let i = 0; i < 3 && !meetLink(event); i++) {
      await sleep(1200);
      const again = await fetch(eventsUrl(env) + "/" + id, { headers: headers });
      if (again.ok) event = await again.json(); else await again.text();
    }
    if (!meetLink(event)) return { ok: false, error: "The event was created but Google hasn't attached a Meet link yet. Press Retry in a minute." };
    return { ok: true, event_id: id, meet_link: meetLink(event), managed: true, synced: syncedFrom(s) };
  } catch (err) {
    return { ok: false, error: "Google Calendar was unreachable" };
  }
}

/** Moves the event to the workshop's date and length and emails everyone invited.
    The title and description are rewritten only on an event this system created;
    an event the owner made by hand keeps their wording. */
export async function updateEvent(env, s, origin) {
  if (!s || !s.calendar_event_id || !s.starts_at) return { ok: false, error: "There is no Calendar event to update." };
  const auth = await signIn(env);
  if (!auth.token) return { ok: false, error: auth.error };
  const body = Object.assign({}, times(s), s.calendar_managed ? details(s, origin) : {});
  try {
    const res = await fetch(eventsUrl(env) + "/" + encodeURIComponent(s.calendar_event_id) + "?sendUpdates=all", {
      method: "PATCH", headers: { Authorization: "Bearer " + auth.token, "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    if (!res.ok) { await res.text(); return Object.assign({ ok: false }, failure(res.status, "update")); }
    const event = await res.json();
    return { ok: true, event_id: s.calendar_event_id, synced: syncedFrom(s), meet_link: meetLink(event) || undefined };
  } catch (err) {
    return { ok: false, error: "Google Calendar was unreachable" };
  }
}
