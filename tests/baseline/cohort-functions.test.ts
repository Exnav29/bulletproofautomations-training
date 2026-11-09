/**
 * BASELINE: existing cohort enrollment and installment payment endpoints.
 *
 * These assertions describe production behaviour as it is on `main` today. The same file
 * is run against two copies of the code:
 *
 *   FUNCTIONS_ROOT=<checkout of origin/main>/functions deno test ... tests/baseline/cohort-functions.test.ts
 *   deno test ... tests/baseline/cohort-functions.test.ts            (this branch)
 *
 * Both must pass. If the webinar work changed anything a cohort learner or the installment
 * flow can observe (rows written, statuses, the exact payload sent to Paystack, responses),
 * the branch run fails while the main run passes.
 *
 * Database: production's ledger schema (tests/fixtures/payment-ledger.sql) in PGlite.
 * Paystack is intercepted at the network layer and never contacted.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { loadDatabase, serveDatabase } from '../helpers/postgrest.ts'

type Row = Record<string, any>
const root = Deno.env.get('FUNCTIONS_ROOT') ?? new URL('../../functions', import.meta.url).pathname
const pg = await loadDatabase([new URL('../fixtures/payment-ledger.sql', import.meta.url)])
// The live table is unique on (cohort, email) and (cohort, whatsapp) — documented in
// supabase-enrollments.sql — but the catalog export in the fixture omits those indexes.
await pg.exec(`create unique index enrollments_cohort_email_key on public.enrollments (cohort, email);
               create unique index enrollments_cohort_whatsapp_key on public.enrollments (cohort, whatsapp);`)
const DB = serveDatabase(pg, 54361)

const enroll = (await import(`file://${root}/api/enroll.js`)).onRequest
const installmentMod = await import(`file://${root}/api/installment.js`)

const sent: Row[] = []
const mailCalls: Row[] = []
let mailboxes: Row[] = [{ address: 'johnathan@bulletproofautomations.com', resourceId: 'box-1' }]
let mailFails = false
const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.host === 'api.mail.hostinger.com') {
    // The Hostinger Mail API, as the installment email uses it. Never contacted.
    mailCalls.push({ method: init?.method ?? 'GET', path: url.pathname, auth: (init?.headers as Row)?.Authorization,
      body: init?.body ? JSON.parse(String(init.body)) : null })
    if (url.pathname === '/api/v1/me') return Response.json({ data: { mailboxes: mailboxes } })
    return mailFails ? new Response('rejected by provider', { status: 500 }) : Response.json({ ok: true })
  }
  if (url.host === 'api.paystack.co' || url.host === 'paystack.mock') {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    sent.push({ host: url.host, path: url.pathname, auth: (init?.headers as Row)?.Authorization, body })
    return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/baseline', reference: body?.reference } })
  }
  return realFetch(input, init)
}

const base = { SUPABASE_URL: DB.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role-for-tests' }
const opts = { sanitizeOps: false, sanitizeResources: false }
async function call(fn: Function, method: string, path: string, body: Row | null, env: Row) {
  const request = new Request('https://training.example' + path, {
    method, headers: { 'content-type': 'application/json', 'CF-IPCountry': 'GH' }, body: body ? JSON.stringify(body) : undefined,
  })
  const res: Response = await fn({ request, env })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
async function reset() {
  sent.length = 0
  await pg.exec('truncate public.payment_events, public.payment_plan_installments, public.enrollments cascade')
}
const rows = async (sql: string, v: unknown[] = []) => (await pg.query<Row>(sql, v)).rows
const form = (over: Row = {}) => ({
  full_name: 'Baseline Learner', email: 'baseline@example.com', whatsapp: '+233200000001', city: 'Accra',
  experience_level: 'foundations_graduate', chosen_option: 'cohort_and_assessment', payment_plan: false,
  consent_given: true, ack_refund: true, ack_certification: true, ...over,
})
/** The Paystack payload with per-run values (reference, ids) replaced by their shape. */
function shape(body: Row) {
  return JSON.parse(JSON.stringify(body)
    .replace(/BPA-(CAB|TEST)-\d{4}-[0-9A-Z]{10}/g, 'BPA-$1-YYYY-XXXXXXXXXX')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'))
}

Deno.test('baseline enroll: GET is the mode probe', opts, async () => {
  for (const [key, mode] of [[undefined, 'off'], ['sk_test_x', 'test'], ['sk_live_x', 'live']]) {
    const r = await call(enroll, 'GET', '/api/enroll', null, { ...base, ...(key ? { PAYSTACK_SECRET_KEY: key } : {}) })
    assertEquals(r.json, { ok: true, paystack: mode })
  }
})

Deno.test('baseline enroll: no Paystack key reserves the place, charges nothing', opts, async () => {
  await reset()
  const r = await call(enroll, 'POST', '/api/enroll', form(), base)
  assertEquals(r.json, { ok: true, mode: 'reserve', paystack: 'off' })
  const e = (await rows('select * from public.enrollments'))[0]
  assertEquals([e.chosen_option, Number(e.amount_ghs), e.payment_status, e.paystack_reference, e.cohort, e.source, e.acks_policy_version],
    ['cohort_and_assessment', 1050, 'reserved', null, 'intermediate_2026_09', 'website', '2026-08-10'])
  assertEquals(sent.length, 0)
})

Deno.test('baseline enroll: test key without opt-in still only reserves', opts, async () => {
  await reset()
  const r = await call(enroll, 'POST', '/api/enroll', form(), { ...base, PAYSTACK_SECRET_KEY: 'sk_test_x' })
  assertEquals(r.json.mode, 'reserve')
  assertEquals(sent.length, 0)
})

Deno.test('baseline enroll: checkout payload sent to Paystack is unchanged', opts, async () => {
  await reset()
  const r = await call(enroll, 'POST', '/api/enroll', form({ testOptIn: true }),
    { ...base, PAYSTACK_SECRET_KEY: 'sk_test_x', PAYSTACK_API_BASE: 'http://paystack.mock' })
  assertEquals([r.json.mode, r.json.test], ['checkout', true])
  assertEquals(sent.length, 1)
  assertEquals(sent[0].path, '/transaction/initialize')
  assertEquals(shape(sent[0].body), {
    email: 'baseline@example.com', amount: 105000, currency: 'GHS', reference: 'BPA-TEST-YYYY-XXXXXXXXXX',
    callback_url: 'https://training.example/thank-you', channels: ['mobile_money', 'card'],
    metadata: {
      enrollment_id: '<uuid>', chosen_option: 'cohort_and_assessment', cohort: 'intermediate_2026_09', payment_plan: 'full',
      custom_fields: [
        { display_name: 'Full name', variable_name: 'full_name', value: 'Baseline Learner' },
        { display_name: 'WhatsApp', variable_name: 'whatsapp', value: '+233200000001' },
        { display_name: 'Enrolling in', variable_name: 'enrolling_in', value: 'Intermediate cohort + BCAB assessment' },
        { display_name: 'Cohort', variable_name: 'cohort', value: 'intermediate_2026_09' },
      ],
    },
  })
  const e = (await rows('select payment_status, paystack_reference, notes from public.enrollments'))[0]
  assertEquals(e.payment_status, 'payment_pending')
  assert(/^BPA-TEST-\d{4}-/.test(e.paystack_reference))
  assert(String(e.notes).startsWith('[TEST]'))
})

Deno.test('baseline enroll: instalment plan charges the first instalment against the full total', opts, async () => {
  await reset()
  await call(enroll, 'POST', '/api/enroll', form({ payment_plan: true, chosen_option: 'cohort_only', testOptIn: true }),
    { ...base, PAYSTACK_SECRET_KEY: 'sk_test_x', PAYSTACK_API_BASE: 'http://paystack.mock' })
  assertEquals([sent[0].body.amount, sent[0].body.metadata.payment_plan], [40000, 'instalments'])
  const e = (await rows('select amount_ghs, first_instalment_ghs, payment_plan from public.enrollments'))[0]
  assertEquals([Number(e.amount_ghs), Number(e.first_instalment_ghs), e.payment_plan], [750, 400, true])
})

Deno.test('baseline enroll: a returning learner resumes; a paid learner is told so', opts, async () => {
  await reset()
  const env = { ...base, PAYSTACK_SECRET_KEY: 'sk_test_x', PAYSTACK_API_BASE: 'http://paystack.mock' }
  await call(enroll, 'POST', '/api/enroll', form({ testOptIn: true }), env)
  const again = await call(enroll, 'POST', '/api/enroll', form({ testOptIn: true }), env)
  assertEquals(again.json.mode, 'checkout')
  assertEquals((await rows('select count(*)::int n from public.enrollments'))[0].n, 1)
  await pg.exec(`update public.enrollments set payment_status = 'paid'`)
  const paid = await call(enroll, 'POST', '/api/enroll', form({ testOptIn: true }), env)
  assertEquals([paid.status, paid.json.code], [409, 'already_paid'])
})

Deno.test('baseline enroll: honeypot and missing acknowledgements', opts, async () => {
  await reset()
  assertEquals((await call(enroll, 'POST', '/api/enroll', form({ company_website: 'x' }), base)).json, { ok: true, mode: 'reserve' })
  assertEquals((await call(enroll, 'POST', '/api/enroll', form({ ack_certification: false }), base)).status, 400)
  assertEquals((await rows('select count(*)::int n from public.enrollments'))[0].n, 0)
})

async function seedInstallment(over: Row = {}) {
  await reset()
  await pg.exec('alter table public.enrollments disable trigger enrollments_seed_intermediate_payment_plan')
  await pg.query(`insert into public.enrollments (id, full_name, email, whatsapp, city, experience_level, chosen_option, amount_ghs,
      amount_paid_ghs, payment_plan, first_instalment_ghs, payment_status, cohort)
    values ('00000000-0000-4000-8000-0000000000e1', 'Instalment Learner', 'inst@example.com', '+233200000002', 'Accra',
      'beginner', 'cohort_only', 750, 400, true, 400, 'partially_paid', 'intermediate_2026_09')`)
  await pg.exec('alter table public.enrollments enable trigger enrollments_seed_intermediate_payment_plan')
  const cols = { enrollment_id: '00000000-0000-4000-8000-0000000000e1', installment_number: 2, amount_ghs: 350, status: 'sent',
    payment_token: '11111111-2222-4333-8444-555555555555', due_rule: 'Before Week 3', ...over }
  const k = Object.keys(cols)
  await pg.query(`insert into public.payment_plan_installments (${k.join(',')}) values (${k.map((_, i) => '$' + (i + 1)).join(',')})`,
    k.map((x) => (cols as Row)[x]))
}

Deno.test('baseline installment: invoice view', opts, async () => {
  await seedInstallment()
  const r = await call(installmentMod.onRequestGet, 'GET', '/api/installment?token=11111111-2222-4333-8444-555555555555', null, base)
  assertEquals(r.json.ok, true)
  const v = r.json.invoice
  assertEquals([v.first_name, v.programme, v.installment_number, v.amount_ghs, v.total_ghs, v.paid_ghs, v.remaining_after_ghs, v.payable],
    ['Instalment', 'Intermediate cohort', 2, 350, 750, 400, 0, true])
})

Deno.test('baseline installment: live checkout payload is unchanged; non-live refuses', opts, async () => {
  await seedInstallment()
  const off = await call(installmentMod.onRequestPost, 'POST', '/api/installment', { token: '11111111-2222-4333-8444-555555555555' },
    { ...base, PAYSTACK_SECRET_KEY: 'sk_test_x' })
  assertEquals(off.status, 503)
  const r = await call(installmentMod.onRequestPost, 'POST', '/api/installment', { token: '11111111-2222-4333-8444-555555555555' },
    { ...base, PAYSTACK_SECRET_KEY: 'sk_live_x' })
  assertEquals(r.json.ok, true)
  assertEquals(sent.length, 1)
  assertEquals(sent[0].host, 'api.paystack.co') // a live key never uses an API override
  assertEquals(shape(sent[0].body), {
    email: 'inst@example.com', amount: 35000, currency: 'GHS', reference: 'BPA-CAB-YYYY-XXXXXXXXXX',
    callback_url: 'https://training.example/pay/?invoice=<uuid>&complete=1',
    channels: ['mobile_money', 'card'],
    metadata: {
      enrollment_id: '<uuid>', chosen_option: 'cohort_only', cohort: 'intermediate_2026_09', payment_plan: 'instalments',
      installment_id: '<uuid>', installment_number: 2,
      custom_fields: [
        { display_name: 'Full name', variable_name: 'full_name', value: 'Instalment Learner' },
        { display_name: 'WhatsApp', variable_name: 'whatsapp', value: '+233200000002' },
        { display_name: 'Enrolling in', variable_name: 'enrolling_in', value: 'Intermediate cohort' },
        { display_name: 'Cohort', variable_name: 'cohort', value: 'intermediate_2026_09' },
      ],
    },
  })
})

Deno.test('baseline installment: a paid installment is not charged again', opts, async () => {
  await seedInstallment({ status: 'paid' })
  const r = await call(installmentMod.onRequestPost, 'POST', '/api/installment', { token: '11111111-2222-4333-8444-555555555555' },
    { ...base, PAYSTACK_SECRET_KEY: 'sk_live_x' })
  assertEquals(r.json, { ok: true, paid: true })
  assertEquals(sent.length, 0)
})

// --- installment payment-link email (the cohort's only transactional email) -------------------
const installments = await import(`file://${root}/api/_installments.js`)
const sendInstallment = async (env: Row) => {
  const id = (await rows('select id from public.payment_plan_installments limit 1'))[0].id
  return installments.sendInstallment(env, new Request('https://training.example/api/admin/installment-notify'), id)
}
const MAIL = { ...base, HOSTINGER_MAIL_API_TOKEN: 'mail-token-for-tests' }

Deno.test('baseline installment email: the exact Hostinger requests, and the row marked sent', opts, async () => {
  await seedInstallment(); mailCalls.length = 0; mailFails = false
  const r = await sendInstallment(MAIL)
  assertEquals([r.ok, r.sent_to, r.payment_url], [true, 'inst@example.com', 'https://training.example/pay/?invoice=11111111-2222-4333-8444-555555555555'])
  assertEquals(mailCalls.map((c) => [c.method, c.path, c.auth]), [
    ['GET', '/api/v1/me', 'Bearer mail-token-for-tests'],
    ['POST', '/api/v1/mailboxes/box-1/send', 'Bearer mail-token-for-tests'],
  ])
  const b = mailCalls[1].body
  assertEquals(Object.keys(b).sort(), ['displayName', 'html', 'subject', 'text', 'to'])
  assertEquals([b.to, b.displayName], [['inst@example.com'], 'Johnathan Lightfoot · Bulletproof Automations'])
  assert(b.text.includes('https://training.example/pay/?invoice=11111111-2222-4333-8444-555555555555'))
  assert(b.subject.length > 0 && b.html.includes('</html>'))
  const row = (await rows('select status, sent_at, last_notified_at from public.payment_plan_installments'))[0]
  assert(row.status === 'sent' && row.sent_at && row.last_notified_at)
})

Deno.test('baseline installment email: no token, no mailbox and a provider rejection report the same codes', opts, async () => {
  await seedInstallment(); mailCalls.length = 0; mailFails = false
  assertEquals(await sendInstallment(base), { ok: false, code: 'mail_not_configured', status: 503 })
  assertEquals(mailCalls.length, 0)
  mailboxes = []
  assertEquals(await sendInstallment(MAIL), { ok: false, code: 'mailbox_not_found', status: 503 })
  mailboxes = [{ address: 'johnathan@bulletproofautomations.com', resourceId: 'box-1' }]
  mailFails = true
  assertEquals(await sendInstallment(MAIL), { ok: false, code: 'mail_send_failed', status: 502, detail: 'rejected by provider' })
  mailFails = false
  const row = (await rows('select last_notified_at from public.payment_plan_installments'))[0]
  assertEquals(row.last_notified_at, null, 'a failed send never marks the installment notified')
})
