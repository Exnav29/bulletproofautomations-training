import { json } from "./_shared.js";

export const ADMIN_EMAIL = "johnathan@bulletproofautomations.com";
export const FROM_NAME = "Johnathan Lightfoot · Bulletproof Automations";

export function db(env, path, init) {
  return fetch(env.SUPABASE_URL + "/rest/v1/" + path, Object.assign({}, init || {}, {
    headers: Object.assign({
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json"
    }, (init && init.headers) || {})
  }));
}

export async function requireAdmin(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth.indexOf("Bearer ") !== 0) return null;
  const res = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: auth }
  });
  if (!res.ok) return null;
  const user = await res.json().catch(function () { return null; });
  return user && String(user.email || "").toLowerCase() === ADMIN_EMAIL ? user : null;
}

export async function one(env, path) {
  const res = await db(env, path);
  if (!res.ok) return { ok: false, status: res.status, detail: (await res.text()).slice(0, 300) };
  const rows = await res.json().catch(function () { return []; });
  return { ok: true, data: Array.isArray(rows) ? rows[0] || null : null };
}
export async function loadInstallment(env, id, byToken) {
  const key = byToken ? "payment_token" : "id";
  const found = await one(env,
    "payment_plan_installments?select=*&" + key + "=eq." + encodeURIComponent(id) + "&limit=1");
  if (!found.ok || !found.data) return found;
  const enrollment = await one(env,
    "enrollments?select=*&id=eq." + encodeURIComponent(found.data.enrollment_id) + "&limit=1");
  if (!enrollment.ok || !enrollment.data) return { ok: false, status: enrollment.status || 404 };
  return { ok: true, installment: found.data, enrollment: enrollment.data };
}

export async function planFor(env, enrollmentId) {
  const res = await db(env,
    "payment_plan_installments?select=*&enrollment_id=eq." + encodeURIComponent(enrollmentId) +
    "&order=installment_number.asc");
  if (!res.ok) return [];
  const rows = await res.json().catch(function () { return []; });
  return Array.isArray(rows) ? rows : [];
}

export function optionLabel(option) {
  const labels = {
    cohort_only: "Intermediate cohort",
    cohort_and_assessment: "Intermediate + BCAB Assessment",
    path_b_readiness: "Path B readiness review"
  };
  return labels[option] || option || "Training programme";
}

export function origin(request) { return new URL(request.url).origin; }
export function payUrl(request, token) {
  return origin(request) + "/pay/?invoice=" + encodeURIComponent(token);
}
function money(value) {
  return "GHS " + Number(value || 0).toLocaleString("en-GB", {
    minimumFractionDigits: 0, maximumFractionDigits: 2
  });
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function emailContent(enrollment, installment, plan, url) {
  const first = String(enrollment.full_name || "there").trim().split(/\s+/)[0] || "there";
  const count = plan.length || installment.installment_number;
  const paid = Number(enrollment.amount_paid_ghs || 0);
  const after = Math.max(0,
    Number(enrollment.amount_ghs || 0) - paid - Number(installment.amount_ghs || 0));
  const timing = installment.due_rule ||
    (installment.due_date ? "Due " + installment.due_date : "Your next scheduled payment");
  const subject = "Payment " + installment.installment_number + " of " + count +
    " — " + optionLabel(enrollment.chosen_option);
  const text = first + ", your next payment is ready.\n\n" + optionLabel(enrollment.chosen_option) +
    "\nPayment " + installment.installment_number + " of " + count + "\n" + money(installment.amount_ghs) +
    "\n" + timing + "\n\nPay securely: " + url + "\n\nAfter this payment: " + money(after) +
    " remaining. Your enrollment is already in place; you do not need to register again." +
    "\n\nJohnathan Lightfoot\nBulletproof Automations";
  const html = '<!doctype html><html><body style="margin:0;background:#f3efe5;font-family:Arial,sans-serif;color:#10251d">' +
    '<div style="max-width:620px;margin:0 auto;padding:28px 18px">' +
    '<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;font-weight:700">Bulletproof Automations</div>' +
    '<div style="background:#fff;margin-top:18px;padding:30px;border:1px solid #d8d2c3;border-radius:16px">' +
    '<p style="margin:0 0 8px;font-size:18px">' + esc(first) + ', your next payment is ready.</p>' +
    '<h1 style="margin:0;font-size:28px;line-height:1.15">' + esc(optionLabel(enrollment.chosen_option)) + '</h1>' +
    '<p style="margin:26px 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#65736d">Payment ' +
      esc(installment.installment_number) + ' of ' + esc(count) + '</p>' +
    '<p style="margin:0;font-size:42px;font-weight:800">' + esc(money(installment.amount_ghs)) + '</p>' +
    '<p style="margin:8px 0 24px;color:#65736d">' + esc(timing) + '</p>' +
    '<a href="' + esc(url) + '" style="display:block;text-align:center;background:#116149;color:#fff;text-decoration:none;padding:15px 18px;border-radius:10px;font-weight:700">Pay ' +
      esc(money(installment.amount_ghs)) + ' securely</a>' +
    '<div style="margin-top:24px;padding-top:20px;border-top:1px solid #e5e0d5;font-size:14px;line-height:1.55;color:#52615b">' +
      '<strong style="color:#10251d">After this payment</strong><br>' + esc(money(after)) + ' remaining.<br><br>' +
      'Your enrollment is already in place. You do not need to register again.</div>' +
    '</div><p style="font-size:12px;line-height:1.5;color:#65736d;margin:16px 4px 0">' +
      'Secure payment is processed by Paystack. Mobile money and card options appear at checkout.</p>' +
    '</div></body></html>';
  return { subject: subject, text: text, html: html };
}

async function mailboxId(token) {
  const res = await fetch("https://api.mail.hostinger.com/api/v1/me", {
    headers: { Authorization: "Bearer " + token }
  });
  if (!res.ok) return null;
  const body = await res.json().catch(function () { return null; });
  const boxes = body && body.data && Array.isArray(body.data.mailboxes) ? body.data.mailboxes : [];
  const box = boxes.filter(function (m) {
    return String(m.address || "").toLowerCase() === ADMIN_EMAIL;
  })[0];
  return box && (box.resourceId || box.resource_id) || null;
}

export async function sendInstallment(env, request, installmentId) {
  if (!env.HOSTINGER_MAIL_API_TOKEN) {
    return { ok: false, code: "mail_not_configured", status: 503 };
  }
  const loaded = await loadInstallment(env, installmentId, false);
  if (!loaded.ok || !loaded.installment) return { ok: false, code: "not_found", status: 404 };
  const installment = loaded.installment;
  const enrollment = loaded.enrollment;
  if (installment.status === "paid" || installment.status === "cancelled") {
    return { ok: false, code: "not_payable", status: 409 };
  }
  const plan = await planFor(env, enrollment.id);
  const url = payUrl(request, installment.payment_token);
  const content = emailContent(enrollment, installment, plan, url);
  const box = await mailboxId(env.HOSTINGER_MAIL_API_TOKEN);
  if (!box) return { ok: false, code: "mailbox_not_found", status: 503 };

  const res = await fetch("https://api.mail.hostinger.com/api/v1/mailboxes/" +
    encodeURIComponent(box) + "/send", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env.HOSTINGER_MAIL_API_TOKEN,
      "Content-Type": "application/json"
    },    body: JSON.stringify({
      to: [enrollment.email],
      displayName: FROM_NAME,
      subject: content.subject,
      text: content.text,
      html: content.html
    })
  });
  if (!res.ok) {
    return {
      ok: false, code: "mail_send_failed", status: 502,
      detail: (await res.text()).slice(0, 200)
    };
  }

  const now = new Date().toISOString();
  const patch = await db(env,
    "payment_plan_installments?id=eq." + encodeURIComponent(installment.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "sent",
        sent_at: installment.sent_at || now,
        last_notified_at: now,
        updated_at: now
      })
    });
  if (!patch.ok) return { ok: false, code: "status_update_failed", status: 502 };
  return { ok: true, payment_url: url, sent_to: enrollment.email };
}

export function result(value, status) { return json(value, status); }