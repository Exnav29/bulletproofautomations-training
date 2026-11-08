/* POST /api/admin/workshops — administrative actions on one registration:
 * admit | request_refund | resolve_duplicate | cancel | attendance | note, and
 * for invitation-only sessions mark_invited | mark_removed | set_attend_email,
 * which record what the admin did on the Google Calendar event (nothing here
 * talks to Google).
 *
 * Signed-in admin only (the existing Supabase Auth session and email
 * allowlist). The RPC re-checks the actor. Refunds themselves are issued in
 * the Paystack dashboard; nothing here moves money. */

import { readJson, rpc } from "../_shared.js";
import { requireAdmin, result } from "../_installments.js";
import { processOutbox } from "../_workshops.js";

const ACTIONS = new Set(["admit", "request_refund", "resolve_duplicate", "cancel", "attendance", "note"]);
const ADMISSION = new Set(["mark_invited", "mark_removed", "set_attend_email"]);
const ADMISSION_ERRORS = {
  not_invite_session: "This session is not set to join by invitation.",
  not_confirmed: "Only a confirmed, paid registration can be invited.",
  no_attend_email: "This registration has no Google account to invite yet.",
  remove_old_first: "Remove the previous Google account from the event first, then record it here.",
  account_on_other_registration: "That Google account is already on the event for another registration.",
  bad_email: "Enter a valid Google account email.",
  not_found: "Registration not found."
};

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return result({ ok: false, error: "Service is not configured." }, 503);
  const admin = await requireAdmin(request, env);
  if (!admin) return result({ ok: false, error: "Not authorized." }, 403);

  const body = await readJson(request, 2048);
  const id = body && typeof body.registration_id === "string" && /^[0-9a-f-]{36}$/.test(body.registration_id) ? body.registration_id : "";
  const action = body && typeof body.action === "string" ? body.action : "";
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
