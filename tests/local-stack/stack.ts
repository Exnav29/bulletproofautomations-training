/**
 * Local, non-production integration stack for the webinar journey.
 *
 *   deno run --node-modules-dir=none -A tests/local-stack/stack.ts
 *
 * Starts, on 127.0.0.1 only:
 *   :54350  PostgREST stand-in over PGlite (real PostgreSQL) loaded with production's
 *           ledger schema (tests/fixtures/payment-ledger.sql) and the workshop migration.
 *           Seeded with ONE test session and a cohort student who shares the test email
 *           and has an open installment, so cohort isolation can be checked.
 *   :54351  Paystack STAND-IN: initialize, verify, a checkout page, and signed
 *           charge.success webhooks (HMAC-SHA512 with a test key, domain "test").
 *           It is not Paystack and proves nothing about Paystack itself.
 *   :8000   The webinar business's webhook: supabase/functions/workshop-paystack-webhook/index.ts
 *   :54352  /state — read-only JSON of the database, for assertions.
 *
 * The Pages Functions run separately under wrangler (see tests/local-stack/README.md).
 * Nothing here talks to any real service.
 *
 * RELEASE2=1 adds release 2 (20261109120000) and seeds the workshop 01 rehearsal
 * session (docs/workshops-rehearsal/), is_test = true because wrangler holds a test key,
 * with made-up certificate records shaped like production's: two Foundations holders, two
 * Intermediate graduates with fees paid, and graduate KWAME's referral code, issued
 * 'prepared' as the admin would issue it. :54350 then fronts the database with a stand-in
 * for Supabase Auth's /auth/v1/user (local-admin-jwt is the admin), so /admin/workshops/
 * runs in the browser against the same data.
 */
import { loadDatabase, serveDatabase } from '../helpers/postgrest.ts'

type Row = Record<string, any>
const u = (p: string) => new URL(p, import.meta.url)
// The WEBINAR business's test key (the training business's key below is different).
const TEST_KEY = 'sk_test_webinar_local_stack_000000000000000000'
const EMAIL = 'preview.tester@example.com'

const RELEASE2 = Deno.env.get('RELEASE2') === '1'
const pg = await loadDatabase([u('../fixtures/payment-ledger.sql'), u('../fixtures/supabase-stubs.sql'),
  ...(RELEASE2 ? [u('../fixtures/graduate-records.sql')] : []),
  u('../../supabase/migrations/20261103120000_workshops.sql'),
  ...(RELEASE2 ? [u('../../supabase/migrations/20261109120000_workshop_admission_benefits.sql')] : [])])
await pg.exec(`
  insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs, capacity, status, join_instructions)
  values ('sample-webinar', 'webinar', 'Stop chasing unpaid invoices by hand', '2099-11-21T11:30:00Z', 90, 'live on Zoom', 150, 40,
          'published', 'LOCAL TEST: Zoom link would appear here'),
         ('sample-free', 'webinar', 'Your first n8n workflow, built live', '2099-11-28T11:30:00Z', 60, 'live on Zoom', 0, null,
          'published', 'LOCAL TEST: Zoom link would appear here');
  insert into public.workshop_dispatch_config (secret_hash) values (encode(sha256('local-dispatch-secret'::bytea), 'hex'));`)
await pg.exec('alter table public.enrollments disable trigger enrollments_seed_intermediate_payment_plan')
await pg.query(`insert into public.enrollments (id, full_name, email, whatsapp, city, experience_level, chosen_option, amount_ghs,
  amount_paid_ghs, payment_plan, first_instalment_ghs, payment_status, paystack_reference, created_at)
  values ('00000000-0000-4000-8000-0000000000c1', 'Preview Tester', $1, '+233000000000', 'Accra', 'beginner', 'cohort_only', 750,
  400, true, 400, 'partially_paid', 'BPA-CAB-2026-COHORT0001', now())`, [EMAIL])
await pg.exec('alter table public.enrollments enable trigger enrollments_seed_intermediate_payment_plan')
await pg.exec(`insert into public.payment_plan_installments (enrollment_id, installment_number, amount_ghs, status, paystack_reference)
  values ('00000000-0000-4000-8000-0000000000c1', 2, 350, 'sent', 'BPA-CAB-2026-INSTAL0002')`)

if (RELEASE2) {
  const w = JSON.parse(await Deno.readTextFile(u('../../docs/workshops-rehearsal/rehearsal-what-to-charge.json')))
  await pg.query(`insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, time_zone, format, price_ghs,
      capacity, status, is_test, admission, calendar_event_id, reserved_graduate_seats, foundations_discount_pct, graduate_free,
      referral_discount_ghs, referral_commission_ghs)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'published', true, 'invite', 'rehearsalevent01', $10, $11, $12, $13, 50)`,
    [w.slug, w.kind, w.title, w.starts_at, w.duration_minutes, w.time_zone, w.format, w.price_ghs, w.capacity,
      w.reserved_graduate_seats, w.foundations_discount_pct, w.graduate_free, w.referral_discount_ghs])
  await pg.exec(`insert into public.credentials (credential_id, holder_name, holder_email, credential, status) values
    ('BPA-FND-2026-LOCAL1', 'Efua Local', 'efua.local@example.com', 'foundations', 'valid'),
    ('BPA-FND-2026-LOCAL2', 'Esi Local', 'esi.local@example.com', 'foundations', 'valid')`)
  await pg.exec('alter table public.enrollments disable trigger enrollments_seed_intermediate_payment_plan')
  for (const [cid, email] of [['BPA-TRN-2026-LOCALK', 'kwame.local@example.com'], ['BPA-TRN-2026-LOCALA', 'abena.local@example.com']]) {
    const e = (await pg.query<Row>(`insert into public.enrollments (full_name, email, whatsapp, city, experience_level, chosen_option,
        amount_ghs, payment_plan, payment_status, amount_paid_ghs)
      values ('Local Graduate', $1, '+233000000000', 'Accra', 'foundations_graduate', 'cohort_only', 750, true, 'paid', 750) returning id`, [email])).rows[0]
    await pg.query(`insert into public.payment_plan_installments (enrollment_id, installment_number, amount_ghs, status)
      values ($1, 1, 400, 'paid'), ($1, 2, 350, 'paid')`, [e.id])
    await pg.query(`insert into public.credentials (credential_id, holder_name, holder_email, credential, status, enrollment_id)
      values ($1, 'Local Graduate', $2, 'completion', 'valid', $3)`, [cid, email, e.id])
    const g = (await pg.query<Row>(`insert into private.studio_graduates (data, credential_id, state)
      values (jsonb_build_object('email', $1::text), $2, 'issued') returning id`, [email, cid])).rows[0]
    await pg.query(`insert into private.studio_graduate_webinar_entitlements (graduate_id) values ($1)`, [g.id])
  }
  await pg.exec('alter table public.enrollments enable trigger enrollments_seed_intermediate_payment_plan')
  await pg.exec(`insert into public.workshop_referrers (code, credential_id, status, created_by)
    values ('KWAME50', 'BPA-TRN-2026-LOCALK', 'prepared', 'johnathan@bulletproofautomations.com')`)

  serveDatabase(pg, 54360)
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' }
  Deno.serve({ port: 54350, hostname: '127.0.0.1', onListen() {} }, async (req) => {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (url.pathname === '/auth/v1/user') {
      return req.headers.get('authorization') === 'Bearer local-admin-jwt'
        ? Response.json({ email: 'johnathan@bulletproofautomations.com' }, { headers: cors })
        : new Response('{}', { status: 401, headers: cors })
    }
    const res = await fetch('http://127.0.0.1:54360' + url.pathname + url.search,
      { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : await req.text() })
    const h = new Headers(res.headers)
    for (const [k, v] of Object.entries(cors)) h.set(k, v)
    return new Response(await res.arrayBuffer(), { status: res.status, headers: h })
  })
} else {
  serveDatabase(pg, 54350)
}

// --- Paystack stand-in --------------------------------------------------------------------
const txns = new Map<string, Row>()
async function sign(raw: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(TEST_KEY), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
}
const page = (body: string) => new Response(`<!doctype html><meta charset="utf-8"><title>Paystack stand-in</title>
<body style="font:16px system-ui;max-width:28rem;margin:40px auto;padding:0 16px">
<p style="background:#fde68a;padding:8px">LOCAL PAYSTACK STAND-IN. Not Paystack. No money moves.</p>${body}</body>`,
  { headers: { 'content-type': 'text/html; charset=utf-8' } })

Deno.serve({ port: 54351, hostname: '127.0.0.1', onListen() {} }, async (req) => {
  const url = new URL(req.url)
  if (req.headers.get('authorization') && req.headers.get('authorization') !== `Bearer ${TEST_KEY}` && url.pathname.startsWith('/transaction')) {
    return Response.json({ status: false, message: 'Invalid key' }, { status: 401 })
  }
  if (url.pathname === '/transaction/initialize' && req.method === 'POST') {
    const b = await req.json()
    txns.set(b.reference, { ...b, status: 'ongoing' })
    return Response.json({ status: true, data: { reference: b.reference, authorization_url: `http://127.0.0.1:54351/checkout/${b.reference}` } })
  }
  if (url.pathname.startsWith('/transaction/verify/')) {
    const ref = decodeURIComponent(url.pathname.split('/').pop()!)
    const t = txns.get(ref)
    if (!t) return Response.json({ status: false, message: 'Transaction reference not found' }, { status: 404 })
    return Response.json({ status: true, data: { reference: ref, status: t.status, amount: t.amount, currency: t.currency, domain: 'test', paid_at: t.paid_at ?? null } })
  }
  const m = url.pathname.match(/^\/checkout\/([^/]+)(\/pay|\/cancel)?$/)
  if (m) {
    const ref = decodeURIComponent(m[1]); const t = txns.get(ref)
    if (!t) return page('<p>Unknown checkout.</p>')
    const back = t.callback_url + (t.callback_url.includes('?') ? '&' : '?') + `trxref=${ref}&reference=${ref}`
    if (m[2] === '/pay' && req.method === 'POST') {
      t.status = 'success'; t.paid_at = new Date().toISOString()
      const raw = JSON.stringify({ event: 'charge.success', data: { reference: ref, amount: t.amount, currency: t.currency, status: 'success',
        domain: 'test', paid_at: t.paid_at, customer: { email: t.email }, metadata: t.metadata } })
      const hook = await fetch('http://127.0.0.1:8000/', { method: 'POST', headers: { 'x-paystack-signature': await sign(raw) }, body: raw })
      t.webhook = { status: hook.status, body: await hook.json().catch(() => null) }
      return Response.redirect(back, 303)
    }
    if (m[2] === '/cancel' && req.method === 'POST') { t.status = 'abandoned'; return Response.redirect(back, 303) }
    return page(`<h1 style="font-size:20px">Pay GHS ${(t.amount / 100).toFixed(2)}</h1><p>${t.email}</p>
      <p>Channels offered: ${(t.channels || []).join(', ')}</p>
      <form method="post" action="/checkout/${ref}/pay"><button id="pay" style="font-size:18px;padding:10px 16px">Pay (test)</button></form>
      <form method="post" action="/checkout/${ref}/cancel"><button id="cancel">Cancel payment</button></form>`)
  }
  return new Response('not found', { status: 404 })
})

// --- the webinar business's webhook -----------------------------------------------------
Deno.env.set('WORKSHOP_PAYSTACK_TEST_SECRET_KEY', TEST_KEY)
Deno.env.set('PAYSTACK_SECRET_KEY', 'sk_live_training_business_local_never_used_00')
Deno.env.set('PAYSTACK_TEST_SECRET_KEY', 'sk_test_training_business_local_never_used_00')
Deno.env.set('PROJECT_URL', 'http://127.0.0.1:54350')
Deno.env.set('SERVICE_ROLE_KEY', 'local-service-role')
const { handle } = await import('../../supabase/functions/workshop-paystack-webhook/index.ts')
Deno.serve({ port: 8000, hostname: '127.0.0.1', onListen() {} }, handle)

// --- mail stand-in (Hostinger API shape), captures what would be sent -----------------------
const mail: Row[] = []
Deno.serve({ port: 54353, hostname: '127.0.0.1', onListen() {} }, async (req) => {
  const url = new URL(req.url)
  if (url.pathname === '/api/v1/me') return Response.json({ data: { mailboxes: [{ address: 'johnathan@bulletproofautomations.com', resourceId: 'local-box' }] } })
  if (url.pathname.endsWith('/send')) { mail.push(await req.json()); return Response.json({ ok: true }) }
  return new Response('not found', { status: 404 })
})

// --- state, for assertions -----------------------------------------------------------------
Deno.serve({ port: 54352, hostname: '127.0.0.1', onListen() {} }, async () => {
  const q = async (sql: string) => (await pg.query<Row>(sql)).rows
  return Response.json({
    registrations: await q(`select * from public.workshop_registrations order by created_at`),
    referrers: RELEASE2 ? await q(`select code, credential_id, status from public.workshop_referrers`) : [],
    payouts: RELEASE2 ? await q(`select * from public.workshop_referral_payouts`) : [],
    sessions: await q(`select * from public.workshop_sessions`),
    attempts: await q(`select registration_id, reference, status, amount_minor, received_minor, mode, verified_via, payment_event_id from public.workshop_payment_attempts order by created_at`),
    training_ledger: await q(`select * from public.payment_events`),
    payment_events: await q(`select event, reference, signature_valid, matched, match_note, id from public.workshop_payment_events order by received_at`),
    notifications: await q(`select registration_id, kind, status, attempts, error from public.workshop_notifications order by created_at`),
    meta_events: await q(`select registration_id, event_name, event_id, value_ghs, status from public.workshop_meta_events order by created_at`),
    cohort: await q(`select id, email, amount_paid_ghs, payment_status, paystack_reference from public.enrollments`),
    installments: await q(`select installment_number, amount_ghs, status, paystack_reference from public.payment_plan_installments`),
    paystack: Object.fromEntries(txns),
    mail,
  })
})
console.log('local stack ready: db :54350, paystack stand-in :54351, webinar webhook :8000, state :54352')
