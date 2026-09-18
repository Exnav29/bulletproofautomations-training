import { readJson } from "../_shared.js";
import { requireAdmin, sendInstallment, result } from "../_installments.js";

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return result({ ok: false, error: "Billing service is not configured." }, 503);
  }
  const admin = await requireAdmin(request, env);
  if (!admin) return result({ ok: false, error: "Not authorized." }, 403);

  const body = await readJson(request, 1024);
  const id = body && typeof body.installment_id === "string" ? body.installment_id : "";
  if (!id) return result({ ok: false, error: "Installment is required." }, 400);

  const sent = await sendInstallment(env, request, id);
  if (!sent.ok) {
    const messages = {
      mail_not_configured: "Automatic email is not connected yet.",
      mailbox_not_found: "The Bulletproof Automations mailbox is not available to the mail token.",
      not_found: "That installment was not found.",
      not_payable: "That installment is already paid or cancelled.",
      mail_send_failed: "The payment email could not be sent.",
      status_update_failed: "Email sent, but the installment status could not be updated."
    };
    return result({ ok: false, code: sent.code,
      error: messages[sent.code] || "The email could not be sent." }, sent.status || 500);
  }
  return result({ ok: true, payment_url: sent.payment_url, sent_to: sent.sent_to });
}