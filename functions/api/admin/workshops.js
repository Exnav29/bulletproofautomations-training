/* POST /api/admin/workshops — administrative actions on one registration:
 * admit | request_refund | resolve_duplicate | cancel | attendance | note | retry_email, and
 * for invitation-only sessions mark_invited | mark_removed | set_attend_email,
 * which record what the admin did on the Google Calendar event (nothing here
 * talks to Google), and the referral actions create_referrer |
 * suspend_referrer | activate_referrer | record_payout. A payout is recorded
 * after the admin has paid it by hand; nothing here moves money.
 *
 * Signed-in admin only (the existing Supabase Auth session and email
 * allowlist). The RPC re-checks the actor. Refunds themselves are issued in
 * the Paystack dashboard; nothing here moves money. */

import { readJson, rpc } from "../_shared.js";
import { requireAdmin, result } from "../_installments.js";
import { processOutbox } from "../_workshops.js";

const ACTIONS = new Set(["admit", "request_refund", "resolve_duplicate", "cancel", "attendance", "note"]);
const ADMISSION = new Set(["mark_invited", "mark_removed", "set_attend_email"]);
// The exception queue's retry for automatic Google Calendar invitations.
const CALENDAR = new Set(["retry_calendar"]);
// Retry for confirmation, review and duplicate-payment emails the dispatcher gave
// up on after 5 attempts (Codex audit): before, nothing could bring them back.
// Waitlist exceptions only; normal progression is automatic.
const WAITLIST = { waitlist_remove: "remove", waitlist_retry_email: "retry_email" };
const REFERRAL = new Set(["create_referrer", "suspend_referrer", "activate_referrer", "record_payout", "void_commission",
  "grant_email", "revoke_grant"]);
const REFERRAL_ERRORS = {
  not_eligible_graduate: "That certificate is not an eligible Intermediate graduate: it must be valid and issued, with an active entitlement and training fees paid in full.",
  test_registration: "This is a test registration. A commission on it can never be paid.",
  not_qualifying: "No commission is payable: it needs a confirmed registration, paid once in full and not refunded, with a valid referral, not voided and not complimentary.",
  reference_required: "Enter the MoMo or bank reference for the payout.",
  reason_required: "Give a reason (at least five characters).",
  bad_code: "A code is 4 to 16 letters and digits, and must not contain the certificate number.",
  code_taken: "That code is already in use.",
  bad_email: "Enter a valid email address.",
  not_eligible: "That certificate is not currently eligible for any workshop benefit.",
  not_found: "Not found."
};
const ADMISSION_ERRORS = {
  not_invite_session: "This session is not set to join by invitation.",
  not_confirmed: "Only a confirmed, paid registration can be invited.",
  no_attend_email: "This registration has no Google account to invite yet.",
  remove_old_first: "Remove the previous Google account from the event first, then record it here.",
  account_on_other_registration: "That Google account is already on the event for another registration.",
  graduate_not_eligible: "This complimentary graduate place no longer matches an active graduate entitlement. Check the certificate before inviting.",
  bad_email: "Enter a valid Google account email.",
  not_found: "Registration not found."
};

/* ---------------------------------------------------------------------------
   Release 6: workshops themselves (create, edit, publish, close, complete,
   cancel, delete), the series, referral codes for anyone, and the one set of
   referral terms. The database function enforces every rule; this cleans the
   input and turns its answers into sentences.
   ------------------------------------------------------------------------- */
const SESSION = { session_save: "save", session_publish: "publish", session_close: "close", session_complete: "complete",
  session_cancel: "cancel", session_delete: "delete" };
const SESSION_ERRORS = {
  not_found: "That workshop no longer exists. Refresh the page.",
  slug_taken: "Another workshop already uses that page address. Choose a different one.",
  slug_locked: "The page address can't change once registration has opened, so links already shared keep working.",
  capacity_below_taken: "Open places can't go below the number of people who already hold one.",
  graduate_below_taken: "Graduate places can't go below the number of graduates who already hold one.",
  date_required: "A workshop that has been open for registration needs a date.",
  calendar_event_taken: "That Google Calendar event is already attached to another workshop.",
  series_number_taken: "Another workshop already has that number in the series.",
  bad_state: "That can't be done to a workshop in its current state. Refresh the page.",
  not_started: "A workshop can be marked completed only after it has started.",
  reason_required: "Give a reason (at least five characters). It is kept with the workshop's record.",
  has_registrations: "People have registered or are waiting for this workshop, so it can't be deleted. Cancel it instead.",
  invalid: "Some of the details aren't valid. Check the dates, numbers and page address."
};
const PROBLEMS = {
  no_date: "set a date", date_past: "choose a date in the future", no_summary: "write the short description",
  no_calendar_event: "attach the Google Calendar event (or choose to send the joining link by email)",
  graduate_free_needs_places: "keep at least one place for graduates, or turn off free places for graduates"
};
// Meeting links are private: they go only to confirmed participants, by email or invitation.
const MEETING_LINK = /https?:\/\/([a-z0-9-]+\.)*(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com|webex\.com)\b/i;

const s = function (v, n) { return typeof v === "string" ? v.trim().slice(0, n) : ""; };
const list = function (v, n, each) { return (Array.isArray(v) ? v : []).slice(0, n).map(each).filter(Boolean); };
function cleanContent(c) {
  c = c && typeof c === "object" ? c : {};
  return {
    summary: s(c.summary, 600), directory_line: s(c.directory_line, 300), description: s(c.description, 300),
    audience: s(c.audience, 300), why: list(c.why, 8, function (x) { return s(x, 1200); }),
    outcomes: list(c.outcomes, 15, function (x) { return s(x, 300); }), leave_with: list(c.leave_with, 12, function (x) { return s(x, 600); }),
    run_of_show: list(c.run_of_show, 20, function (r) {
      return r && s(r.at, 12) && s(r.title, 160) ? { at: s(r.at, 12), title: s(r.title, 160), detail: s(r.detail, 300) } : null;
    }),
    good_fit: s(c.good_fit, 1500), not_fit: s(c.not_fit, 1500), bring: s(c.bring, 600),
    faq: list(c.faq, 20, function (f) { return f && s(f.q, 300) && s(f.a, 2000) ? { q: s(f.q, 300), a: s(f.a, 2000) } : null; }),
    problem: s(c.problem, 1500), series_fit: s(c.series_fit, 1000), instructor: "johnathan"
  };
}
function cleanSession(v) {
  v = v && typeof v === "object" ? v : {};
  const out = {};
  const num = function (k, min, max) { if (v[k] === undefined) return; const n = Number(v[k]); if (Number.isFinite(n)) out[k] = Math.min(max, Math.max(min, n)); };
  if (v.title !== undefined) out.title = s(v.title, 160);
  if (v.slug !== undefined) out.slug = s(v.slug, 80).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (v.kind !== undefined) out.kind = v.kind === "webinar" ? "webinar" : "workshop";
  if (v.starts_at !== undefined) { const t = Date.parse(v.starts_at); out.starts_at = v.starts_at && Number.isFinite(t) ? new Date(t).toISOString() : ""; }
  num("duration_minutes", 15, 600); num("price_ghs", 0, 100000); num("capacity", 0, 10000);
  num("reserved_graduate_seats", 0, 1000); num("foundations_discount_pct", 0, 100); num("series_number", 0, 99);
  if (out.price_ghs !== undefined) out.price_ghs = Math.round(out.price_ghs * 100) / 100;
  ["duration_minutes", "capacity", "reserved_graduate_seats", "foundations_discount_pct", "series_number"].forEach(function (k) { if (out[k] !== undefined) out[k] = Math.round(out[k]); });
  if (v.graduate_free !== undefined) out.graduate_free = v.graduate_free === true;
  if (v.announce !== undefined) out.announce = v.announce === true;
  if (v.is_test !== undefined) out.is_test = v.is_test === true;
  if (v.admission !== undefined) out.admission = v.admission === "invite" ? "invite" : "link";
  if (v.format !== undefined) out.format = s(v.format, 120);
  if (v.calendar_event_id !== undefined) out.calendar_event_id = s(v.calendar_event_id, 1024);
  if (v.join_instructions !== undefined) out.join_instructions = s(v.join_instructions, 3000);
  if (v.series_slug !== undefined) out.series_slug = s(v.series_slug, 80);
  if (v.content !== undefined) out.content = cleanContent(v.content);
  return out;
}
function cleanSeries(v) {
  v = v && typeof v === "object" ? v : {};
  return { slug: s(v.slug, 80), name: s(v.name, 120), presenter: s(v.presenter, 120) || "Bulletproof Automations",
    positioning: s(v.positioning, 400), intro: list(v.intro, 6, function (x) { return s(x, 1200); }),
    standalone: s(v.standalone, 600), disclaimer: s(v.disclaimer, 1200) };
}

async function sessionAction(env, admin, action, body) {
  const sid = typeof body.session_id === "string" && /^[0-9a-f-]{36}$/.test(body.session_id) ? body.session_id : null;
  if (action !== "session_save" && !sid) return result({ ok: false, error: "A workshop is required." }, 400);
  const data = action === "session_save" ? cleanSession(body.session) : {};
  if (action === "session_save" && data.content && MEETING_LINK.test(JSON.stringify(data.content))) {
    return result({ ok: false, error: "A meeting link can't go on the public page. Put it in the joining instructions, which only confirmed people receive." }, 409);
  }
  if (action === "session_save" && !sid && (!data.title || data.title.length < 3)) return result({ ok: false, error: "Give the workshop a title." }, 409);
  if (action === "session_save" && !sid && !data.slug) data.slug = (data.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const done = await rpc(env, "workshop_admin_session", {
    p_actor_email: String(admin.email).toLowerCase(), p_action: SESSION[action], p_session_id: sid, p_data: data,
    p_reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : null
  });
  if (!done.ok) return result({ ok: false, error: "The change could not be saved." }, 502);
  const d = done.data || {};
  if (d.ok !== true) {
    if (d.error === "not_publishable") {
      const what = (d.problems || []).map(function (p) { return PROBLEMS[p] || p; });
      return result({ ok: false, error: "Before registration can open: " + what.join("; ") + ".", problems: d.problems || [] }, 409);
    }
    const taken = d.taken !== undefined ? " (" + d.taken + " taken)" : "";
    return result({ ok: false, error: (SESSION_ERRORS[d.error] || "The change was refused.") + taken }, 409);
  }
  return result({ ok: true, id: d.id || sid, slug: d.slug || null, status: d.status || null, deleted: d.deleted === true });
}

const REFERRER = { referrer_create: "create", referrer_update: "update", referrer_suspend: "suspend", referrer_activate: "activate",
  referrer_payouts: "record_payouts", referral_terms: "set_terms" };
const REFERRER_ERRORS = {
  name_required: "Enter their name.", bad_email: "Enter a valid email address.",
  payout_required: "Say how you will pay their commission (for example a MoMo number).",
  bad_code: "A code is 4 to 16 letters and numbers.", code_taken: "That code is already in use. Choose another.",
  reference_required: "Enter the MoMo or bank reference for the payment.",
  nothing_due: "Nothing is owed on this code right now.", not_found: "That code no longer exists. Refresh the page.",
  invalid: "Enter amounts of zero or more."
};
async function referrerAction(env, admin, action, body) {
  const rid = typeof body.referrer_id === "string" && /^[0-9a-f-]{36}$/.test(body.referrer_id) ? body.referrer_id : null;
  if (action !== "referrer_create" && action !== "referral_terms" && !rid) return result({ ok: false, error: "A referral code is required." }, 400);
  const v = body.referrer && typeof body.referrer === "object" ? body.referrer : {};
  const data = action === "referral_terms"
    ? { discount_ghs: Math.max(0, Math.round(Number(v.discount_ghs) * 100) / 100), commission_ghs: Math.max(0, Math.round(Number(v.commission_ghs) * 100) / 100) }
    : { name: s(v.name, 120), email: s(v.email, 160).toLowerCase(), payout_method: s(v.payout_method, 200),
        code: s(v.code, 16).toUpperCase(), reference: s(v.reference, 120) };
  if (action === "referral_terms" && (!Number.isFinite(data.discount_ghs) || !Number.isFinite(data.commission_ghs))) {
    return result({ ok: false, error: REFERRER_ERRORS.invalid }, 409);
  }
  const done = await rpc(env, "workshop_admin_referrer", {
    p_actor_email: String(admin.email).toLowerCase(), p_action: REFERRER[action], p_referrer_id: rid, p_data: data
  });
  if (!done.ok) return result({ ok: false, error: "The change could not be saved." }, 502);
  const d = done.data || {};
  if (d.ok !== true) return result({ ok: false, error: REFERRER_ERRORS[d.error] || "The change was refused." }, 409);
  return result({ ok: true, id: d.id || rid, code: d.code || null, status: d.status || null, count: d.count || 0, amount_ghs: d.amount_ghs || 0 });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return result({ ok: false, error: "Service is not configured." }, 503);
  const admin = await requireAdmin(request, env);
  if (!admin) return result({ ok: false, error: "Not authorized." }, 403);

  // Session saves carry a page's content, so the limit is larger than a click needs.
  const body = await readJson(request, 65536);
  const id = body && typeof body.registration_id === "string" && /^[0-9a-f-]{36}$/.test(body.registration_id) ? body.registration_id : "";
  const action = body && typeof body.action === "string" ? body.action : "";
  if (SESSION[action]) return sessionAction(env, admin, action, body);
  if (REFERRER[action]) return referrerAction(env, admin, action, body);
  if (action === "series_save") {
    const done = await rpc(env, "workshop_admin_series", { p_actor_email: String(admin.email).toLowerCase(), p_data: cleanSeries(body.series) });
    if (!done.ok) return result({ ok: false, error: "The series could not be saved." }, 502);
    if (!done.data || done.data.ok !== true) return result({ ok: false, error: "Check the series: it needs a name." }, 409);
    return result({ ok: true });
  }
  if (REFERRAL.has(action)) {
    const text = function (k, n) { return body && typeof body[k] === "string" ? body[k].slice(0, n) : null; };
    const credential = text("credential_id", 40);
    const grant = body && typeof body.grant_id === "string" && /^[0-9a-f-]{36}$/.test(body.grant_id) ? body.grant_id : null;
    const needsRegistration = action === "record_payout" || action === "void_commission";
    if (needsRegistration && !id) return result({ ok: false, error: "A registration is required." }, 400);
    if (action === "revoke_grant" && !grant) return result({ ok: false, error: "A grant is required." }, 400);
    if (!needsRegistration && action !== "revoke_grant" && !credential) return result({ ok: false, error: "A certificate ID is required." }, 400);
    const done = await rpc(env, "workshop_admin_referral", {
      p_actor_email: String(admin.email).toLowerCase(), p_action: action, p_credential_id: credential,
      p_registration_id: id || null, p_value: text("value", 300), p_email: text("email", 160),
      p_session_slug: text("session", 80), p_grant_id: grant
    });
    if (!done.ok) return result({ ok: false, error: "The action could not be recorded." }, 502);
    if (!done.data || done.data.ok !== true) {
      return result({ ok: false, error: REFERRAL_ERRORS[done.data && done.data.error] || "The action was refused." }, 409);
    }
    return result({ ok: true, already: done.data.already === true, code: done.data.code || null, status: done.data.status || null });
  }
  if (WAITLIST[action]) {
    const wid = body && typeof body.waitlist_id === "string" && /^[0-9a-f-]{36}$/.test(body.waitlist_id) ? body.waitlist_id : "";
    if (!wid) return result({ ok: false, error: "A waitlist entry is required." }, 400);
    const done = await rpc(env, "workshop_admin_waitlist", {
      p_actor_email: String(admin.email).toLowerCase(), p_id: wid, p_action: WAITLIST[action],
      p_reason: typeof body.value === "string" ? body.value.slice(0, 300) : null
    });
    if (!done.ok) return result({ ok: false, error: "The action could not be recorded." }, 502);
    if (!done.data || done.data.ok !== true) {
      const why = { reason_required: "Give a reason (at least five characters).", not_found: "That entry can no longer be changed." };
      return result({ ok: false, error: why[done.data && done.data.error] || "The action was refused." }, 409);
    }
    return result({ ok: true });
  }
  if (id && CALENDAR.has(action)) {
    const done = await rpc(env, "workshop_calendar_retry", { p_actor_email: String(admin.email).toLowerCase(), p_registration_id: id });
    if (!done.ok) return result({ ok: false, error: "The action could not be recorded." }, 502);
    if (!done.data || done.data.ok !== true) return result({ ok: false, error: "Registration not found." }, 409);
    // Try again now rather than at the next scheduled run.
    if (context.waitUntil) {
      context.waitUntil(processOutbox(env, new URL(request.url).origin, { emails: 0, meta: 0, reconcile: 0 }).catch(function () {}));
    }
    return result({ ok: true });
  }
  if (id && action === "retry_email") {
    const done = await rpc(env, "workshop_admin_notification_retry", { p_actor_email: String(admin.email).toLowerCase(), p_registration_id: id });
    if (!done.ok) return result({ ok: false, error: "The action could not be recorded." }, 502);
    if (!done.data || done.data.ok !== true) return result({ ok: false, error: "No undelivered email on this registration." }, 409);
    // Send now rather than at the next scheduled run.
    if (context.waitUntil) {
      context.waitUntil(processOutbox(env, new URL(request.url).origin, { emails: 3, meta: 0, reconcile: 0, calendar: 0, waitlist: 0 }).catch(function () {}));
    }
    return result({ ok: true });
  }
  if (id && ADMISSION.has(action)) {
    const email = body && typeof body.email === "string" ? body.email.slice(0, 160) : null;
    const done = await rpc(env, "workshop_admin_admission", {
      p_actor_email: String(admin.email).toLowerCase(), p_registration_id: id, p_action: action, p_email: email
    });
    if (!done.ok) return result({ ok: false, error: "The action could not be recorded." }, 502);
    if (!done.data || done.data.ok !== true) {
      return result({ ok: false, error: ADMISSION_ERRORS[done.data && done.data.error] || "The action was refused." }, 409);
    }
    return result({ ok: true, already: done.data.already === true });
  }
  if (!id || !ACTIONS.has(action)) return result({ ok: false, error: "A registration and a valid action are required." }, 400);
  const value = typeof body.value === "string" ? body.value.slice(0, 40) : null;
  const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;

  const out = await rpc(env, "workshop_admin_action", {
    p_actor_email: String(admin.email).toLowerCase(), p_registration_id: id, p_action: action, p_value: value, p_note: note
  });
  if (!out.ok) return result({ ok: false, error: "The action could not be recorded." }, 502);
  if (!out.data || out.data.ok !== true) {
    const messages = {
      not_in_review: "Only a payment held for review can be admitted.",
      nothing_to_refund: "There is no payment on this registration to refund.",
      no_duplicate: "This registration has no duplicate payment.",
      money_held_use_refund: "Money is held on this registration. Request a refund instead of cancelling.",
      bad_value: "Attendance must be unknown, attended or no-show.",
      not_found: "Registration not found."
    };
    return result({ ok: false, error: messages[out.data && out.data.error] || "The action was refused." }, 409);
  }
  if (action === "admit" && context.waitUntil) {
    context.waitUntil(processOutbox(env, new URL(request.url).origin, { emails: 3, meta: 0, reconcile: 0 }).catch(function () {}));
  }
  return result({ ok: true });
}
