/* Branded business email through the Hostinger Mail API, from the Bulletproof
 * Automations mailbox. The same transport and mailbox the installment emails
 * use (functions/api/_installments.js), which is left untouched so its live
 * payment path does not change.
 *
 * Not routed (leading underscore). Needs HOSTINGER_MAIL_API_TOKEN on the
 * Pages project; without it every send reports mail_not_configured and the
 * outbox row stays queued, so nothing is lost while mail is switched off. */

export const MAILBOX = "johnathan@bulletproofautomations.com";
export const FROM_NAME = "Bulletproof Automations Training";

async function mailboxId(token) {
  const res = await fetch("https://api.mail.hostinger.com/api/v1/me", {
    headers: { Authorization: "Bearer " + token }
  });
  if (!res.ok) return null;
  const body = await res.json().catch(function () { return null; });
  const boxes = body && body.data && Array.isArray(body.data.mailboxes) ? body.data.mailboxes : [];
  const box = boxes.filter(function (m) { return String(m.address || "").toLowerCase() === MAILBOX; })[0];
  return (box && (box.resourceId || box.resource_id)) || null;
}

/** { ok } or { ok:false, code }. Never throws. */
export async function sendMail(env, message) {
  const token = env.HOSTINGER_MAIL_API_TOKEN;
  if (!token) return { ok: false, code: "mail_not_configured" };
  try {
    const box = await mailboxId(token);
    if (!box) return { ok: false, code: "mailbox_not_found" };
    const res = await fetch("https://api.mail.hostinger.com/api/v1/mailboxes/" + encodeURIComponent(box) + "/send", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: [message.to],
        displayName: FROM_NAME,
        subject: message.subject,
        text: message.text,
        html: message.html
      })
    });
    if (!res.ok) return { ok: false, code: "mail_send_failed", detail: (await res.text()).slice(0, 200) };
    return { ok: true };
  } catch (err) {
    return { ok: false, code: "mail_unreachable" };
  }
}

export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
