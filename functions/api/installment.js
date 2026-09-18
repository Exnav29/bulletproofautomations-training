import { json, readJson } from "./_shared.js";
import { paystackMode, mintReference, initializeTransaction } from "./_paystack.js";
import { db, loadInstallment, planFor, optionLabel, origin } from "./_installments.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeDate(value) { return value || null; }

async function invoiceView(env, token) {
  const loaded = await loadInstallment(env, token, true);
  if (!loaded.ok || !loaded.installment) return null;
  const installment = loaded.installment;
  const enrollment = loaded.enrollment;
  const plan = await planFor(env, enrollment.id);
  const paid = Number(enrollment.amount_paid_ghs || 0);
  const amount = Number(installment.amount_ghs || 0);
  const total = Number(enrollment.amount_ghs || 0);
  return {
    id: installment.id,
    first_name: String(enrollment.full_name || "").trim().split(/\s+/)[0] || "Learner",
    full_name: enrollment.full_name,
    programme: optionLabel(enrollment.chosen_option),
    installment_number: installment.installment_number,
    installment_count: plan.length,
    amount_ghs: amount,
    due_rule: installment.due_rule || null,
    due_date: safeDate(installment.due_date),
    status: installment.status,
    total_ghs: total,
    paid_ghs: paid,
    remaining_after_ghs: Math.max(0, total - paid - (installment.status === "paid" ? 0 : amount)),
    payable: installment.status === "scheduled" || installment.status === "sent"
  };
}
export async function onRequestGet({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "Payment service is not configured." }, 503);
  }
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!UUID.test(token)) return json({ ok: false, error: "Payment link is not valid." }, 400);
  const view = await invoiceView(env, token);
  if (!view) return json({ ok: false, error: "Payment link was not found." }, 404);
  return json({ ok: true, invoice: view });
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "Payment service is not configured." }, 503);
  }
  const body = await readJson(request, 1024);
  const token = body && body.token || "";
  if (!UUID.test(token)) return json({ ok: false, error: "Payment link is not valid." }, 400);

  const loaded = await loadInstallment(env, token, true);
  if (!loaded.ok || !loaded.installment) return json({ ok: false, error: "Payment link was not found." }, 404);
  const installment = loaded.installment;
  const enrollment = loaded.enrollment;

  if (installment.status === "paid") return json({ ok: true, paid: true });
  if (installment.status === "cancelled") {
    return json({ ok: false, error: "This payment is no longer due." }, 409);
  }
  if (installment.authorization_url && installment.paystack_reference) {
    return json({ ok: true, url: installment.authorization_url, reference: installment.paystack_reference });
  }

  const mode = paystackMode(env);
  if (mode !== "live") {
    return json({ ok: false, error: "Secure checkout is temporarily unavailable." }, 503);
  }
  const reference = mintReference(mode);
  const started = await initializeTransaction(env, {
    email: enrollment.email,
    amountGhs: Number(installment.amount_ghs),
    reference: reference,
    callbackUrl: origin(request) + "/pay/?invoice=" + encodeURIComponent(token) + "&complete=1",
    enrollmentId: enrollment.id,
    installmentId: installment.id,
    installmentNumber: installment.installment_number,
    option: enrollment.chosen_option,
    instalments: true,
    fullName: enrollment.full_name,
    whatsapp: enrollment.whatsapp,
    tier: enrollment.region_tier || "ghana"
  });
  if (!started.ok) {
    console.log("installment-initialize-failed:", started.reason);
    return json({ ok: false, error: "Secure checkout could not be started." }, 502);
  }

  const now = new Date().toISOString();
  const saved = await db(env,
    "payment_plan_installments?id=eq." + encodeURIComponent(installment.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        paystack_reference: reference,
        authorization_url: started.url,
        updated_at: now
      })
    });
  if (!saved.ok) {
    return json({ ok: false, error: "Checkout started, but the payment record could not be saved." }, 502);
  }

  await db(env, "enrollments?id=eq." + encodeURIComponent(enrollment.id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ paystack_reference: reference, updated_at: now })
  });

  return json({ ok: true, url: started.url, reference: reference });
}