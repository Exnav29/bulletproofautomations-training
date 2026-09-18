import { db, one, sendInstallment, result } from "./_installments.js";

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
}

async function authorized(env, request) {
  const supplied = request.headers.get("x-installment-cron") || "";
  if (!supplied || supplied.length > 200) return false;
  const configured = await one(env,
    "installment_scheduler_config?select=secret_hash&id=eq.true&limit=1");
  if (!configured.ok || !configured.data || !configured.data.secret_hash) return false;
  return (await sha256(supplied)) === configured.data.secret_hash;
}

export async function onRequestPost({ request, env }) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return result({ ok: false, error: "Billing service is not configured." }, 503);
  }
  if (!(await authorized(env, request))) {
    return result({ ok: false, error: "Not authorized." }, 403);
  }

  const today = new Date().toISOString().slice(0, 10);
  const due = await db(env,
    "payment_plan_installments?select=id&status=eq.scheduled&send_on=not.is.null" +
    "&send_on=lte." + encodeURIComponent(today) + "&order=send_on.asc&limit=25");
  if (!due.ok) {
    return result({ ok: false, error: "Could not read scheduled installments." }, 502);
  }
  const rows = await due.json().catch(function () { return []; });
  const report = { due: rows.length, sent: 0, failed: 0, failures: [] };

  for (const row of rows) {
    const sent = await sendInstallment(env, request, row.id);
    if (sent.ok) report.sent += 1;
    else {
      report.failed += 1;
      report.failures.push({ id: row.id, code: sent.code || "unknown" });
    }
  }

  return result({ ok: report.failed === 0, report: report }, report.failed ? 207 : 200);
}