/**
 * Admin refunds move the money (November 2026), end to end on production's schema (PGlite)
 * with a stand-in for Paystack's refund API (POST /refund, GET /refund):
 *   - Refund now marks the place and asks Paystack to refund the full amount, on the
 *     registration's own transaction, with the webinar business's key; the place is still
 *     held until Paystack's webhook confirms;
 *   - never twice: a second click is refused, and Send refund to Paystack checks Paystack's
 *     list first, so a refund already pending, made in the dashboard, or sent before a lost
 *     answer is not sent again; a failed one is;
 *   - only what is left is sent after a partial refund;
 *   - nothing is sent when Paystack's list can't be read, when the payment was made under the
 *     other mode's keys, or when Paystack is not configured; Paystack's refusal is shown.
 *
 *   deno test --node-modules-dir=none --allow-net --allow-read --allow-env tests/workshops-refunds.test.ts
 */
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { loadDatabase, serveDatabase } from './helpers/postgrest.ts'

type Row = Record<string, any>
const u = (p: string) => new URL(p, import.meta.url)
const MIGRATIONS = ['20261103120000_workshops', '20261109120000_workshop_admission_benefits', '20261110120000_workshop_calendar_sync',
  '20261111120000_workshop_waitlist', '20261112120000_workshop_audit_corrections', '20261113120000_workshop_admin_studio',
  '20261113120100_workshop_content_seed', '20261114120000_workshop_admin_streamline']
const pg = await loadDatabase([u('./fixtures/payment-ledger.sql'), u('./fixtures/supabase-stubs.sql'), u('./fixtures/graduate-records.sql'),
  ...MIGRATIONS.map((m) => u(`../supabase/migrations/${m}.sql`))])
const DB = serveDatabase(pg, 54363)
const adminAction = (await import('../functions/api/admin/workshops.js')).onRequestPost

/* ---------- Paystack stand-in ---------- */
type Refund = { id: number; transaction_reference: string; amount: number; status: string; createdAt: string }
let refunds: Refund[] = []
const posts: Row[] = []
let listDown = false
let loseAnswer = false
let refuseWith: string | null = null
let nextId = 9000
function paystack(url: URL, method: string, body: Row | null, auth: string): Response {
  if (auth !== 'Bearer sk_test_webinar12345') return Response.json({ status: false, message: 'Invalid key' }, { status: 401 })
  if (url.pathname !== '/refund') return new Response('no', { status: 404 })
  if (method === 'GET') {
    if (listDown) return new Response('upstream', { status: 502 })
    const per = Number(url.searchParams.get('perPage')), page = Number(url.searchParams.get('page'))
    return Response.json({ status: true, message: 'Refunds retrieved', data: refunds.slice((page - 1) * per, page * per) })
  }
  posts.push(body!)
  if (refuseWith) return Response.json({ status: false, message: refuseWith }, { status: 400 })
  const r = { id: nextId++, transaction_reference: body!.transaction, amount: body!.amount ?? 0, status: 'pending', createdAt: new Date().toISOString() }
  refunds.push(r)
  if (loseAnswer) throw new TypeError('network connection lost')
  return Response.json({ status: true, message: 'Refund has been queued for processing', data: { id: r.id, status: 'pending', amount: r.amount, currency: 'GHS' } })
}

const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  let body: any = null
  try { body = init?.body ? JSON.parse(String(init.body)) : null } catch (_) { body = null }
  if (url.host === 'paystack.stand-in') return paystack(url, init?.method || 'GET', body, String((init?.headers as Row)?.Authorization))
  if (url.host === 'api.paystack.co') throw new Error('a test must never reach the real Paystack')
  if (url.pathname === '/auth/v1/user') {
    const auth = (init?.headers as Row)?.Authorization
    return auth === 'Bearer admin-jwt' ? Response.json({ email: 'johnathan@bulletproofautomations.com' }) : new Response('no', { status: 401 })
  }
  return realFetch(input, init)
}

const ENV: Row = { SUPABASE_URL: DB.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role-for-tests',
  WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_test_webinar12345', WORKSHOP_PAYSTACK_API_BASE: 'https://paystack.stand-in', PAYSTACK_SECRET_KEY: 'sk_test_training999' }

async function admin(body: Row, env: Row = ENV) {
  const request = new Request('https://training.example/api/admin/workshops', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer admin-jwt' }, body: JSON.stringify(body)
  })
  const res: Response = await adminAction({ request, env, waitUntil: () => {} })
  return { status: res.status, json: await res.json() as Row }
}
const rows = async (sql: string, v: unknown[] = []) => (await pg.query<Row>(sql, v)).rows
const reg = async (id: string) => (await rows(`select * from public.workshop_registrations where id = $1`, [id]))[0]
const opts = { sanitizeOps: false, sanitizeResources: false }

await pg.exec(`insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs, capacity, status, is_test)
  values ('refund-test', 'workshop', 'Refund test', now() + interval '30 days', 180, 'live online', 350, 25, 'published', true)`)
let n = 0
/** A confirmed, paid registration with one verified payment. */
async function paid(minor = 35000, mode = 'test', refunded = 0): Promise<{ id: string; ref: string }> {
  n++
  const ref = (mode === 'live' ? 'BPA-WEB-2026-' : 'BPA-WTEST-2026-') + String(n).padStart(10, '0')
  const r = (await rows(`insert into public.workshop_registrations (session_id, email_normalized, full_name, terms_ack, terms_version, status, payment_status,
      amount_ghs, amount_paid_minor, paid_at)
    select id, $1, 'Pat Refund', true, 'v1', 'confirmed', $3, 350, $2, now() from public.workshop_sessions where slug = 'refund-test' returning id`,
    [`p${n}@example.com`, minor - refunded, refunded ? 'partially_refunded' : 'paid']))[0]
  await pg.query(`insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, mode, status, received_minor, refunded_minor, paid_at, verified_at, verified_via)
    values ($1, $2, $3, $4, 'succeeded', $3, $5, now(), now(), 'webhook')`, [r.id, ref, minor, mode, refunded])
  return { id: r.id, ref }
}
function reset() { refunds = []; posts.length = 0; listDown = false; loseAnswer = false; refuseWith = null }

Deno.test('Refund now marks the place and asks Paystack for the full amount, on its own transaction', opts, async () => {
  reset()
  const p = await paid()
  const res = await admin({ action: 'request_refund', registration_id: p.id })
  assertEquals(res.status, 200, JSON.stringify(res.json))
  assertEquals(posts, [{ transaction: p.ref, amount: 35000, currency: 'GHS', merchant_note: 'Workshop refund requested in the admin by johnathan@bulletproofautomations.com' }])
  assertEquals([res.json.refund.sent, res.json.refund.problem], [1, false])
  assert(res.json.refund.message.startsWith('Paystack is refunding GHS 350.'), res.json.refund.message)
  const r = await reg(p.id)
  assertEquals([r.status, r.payment_status, Number(r.amount_paid_minor)], ['refund_pending', 'paid', 35000], 'the place is held until Paystack confirms')
  assert(/Paystack refund 9000 pending, GHS 350 on BPA-WTEST-2026-0000000001/.test(r.admin_notes), r.admin_notes)
})

Deno.test('never twice: a second click is refused, and Send refund finds the pending refund and sends nothing', opts, async () => {
  reset()
  const p = await paid()
  await admin({ action: 'request_refund', registration_id: p.id })
  const again = await admin({ action: 'request_refund', registration_id: p.id })
  assertEquals([again.status, again.json.error], [409, 'There is no payment on this registration to refund.'])
  const send = await admin({ action: 'send_refund', registration_id: p.id })
  assertEquals(send.status, 200)
  assertEquals(posts.length, 1, 'one refund in Paystack, not two')
  assertEquals([send.json.refund.sent, send.json.refund.problem], [0, false])
  assert(send.json.refund.message.startsWith('Paystack already has this refund.'), send.json.refund.message)
})

Deno.test('a refund already made in the Paystack dashboard is not sent again; a failed one is', opts, async () => {
  reset()
  const p = await paid()
  refunds.push({ id: 1, transaction_reference: p.ref, amount: 35000, status: 'processed', createdAt: new Date().toISOString() })
  const res = await admin({ action: 'request_refund', registration_id: p.id })
  assertEquals([posts.length, res.json.refund.sent], [0, 0])
  reset()
  refunds.push({ id: 2, transaction_reference: p.ref, amount: 35000, status: 'failed', createdAt: new Date().toISOString() })
  // Other transactions' refunds never count against this one.
  refunds.push({ id: 3, transaction_reference: 'BPA-WTEST-2026-ZZZZZZZZZZ', amount: 35000, status: 'pending', createdAt: new Date().toISOString() })
  const send = await admin({ action: 'send_refund', registration_id: p.id })
  assertEquals([posts.length, posts[0].amount, send.json.refund.sent], [1, 35000, 1])
})

Deno.test('a lost answer is safe: the retry finds the refund Paystack did create and sends nothing', opts, async () => {
  reset()
  const p = await paid()
  loseAnswer = true
  const res = await admin({ action: 'request_refund', registration_id: p.id })
  assertEquals([res.status, res.json.refund.problem], [200, true])
  assert(/No answer from Paystack/.test(res.json.refund.message), res.json.refund.message)
  assertEquals((await reg(p.id)).status, 'refund_pending')
  loseAnswer = false
  const retry = await admin({ action: 'send_refund', registration_id: p.id })
  assertEquals([posts.length, retry.json.refund.sent, retry.json.refund.problem], [1, 0, false])
})

Deno.test('after a partial refund only what is left is sent', opts, async () => {
  reset()
  const p = await paid(35000, 'test', 10000)
  refunds.push({ id: 4, transaction_reference: p.ref, amount: 10000, status: 'processed', createdAt: new Date().toISOString() })
  const res = await admin({ action: 'request_refund', registration_id: p.id })
  assertEquals([posts.length, posts[0].amount], [1, 25000])
  assert(res.json.refund.message.startsWith('Paystack is refunding GHS 250.'), res.json.refund.message)
})

Deno.test('nothing is sent when Paystack\'s list cannot be read; Paystack\'s refusal is shown', opts, async () => {
  reset()
  const p = await paid()
  listDown = true
  const res = await admin({ action: 'request_refund', registration_id: p.id })
  assertEquals([posts.length, res.json.refund.problem], [0, true])
  assert(/refund list could not be checked/.test(res.json.refund.message))
  listDown = false
  refuseWith = 'Transaction has been fully reversed'
  const send = await admin({ action: 'send_refund', registration_id: p.id })
  assertEquals([posts.length, send.json.refund.problem], [1, true])
  assert(/Paystack refused the refund of GHS 350 on .*: Transaction has been fully reversed/.test(send.json.refund.message), send.json.refund.message)
  assert(/Paystack refused/.test((await reg(p.id)).admin_notes))
})

Deno.test('a payment taken under the other mode\'s keys, or no Paystack key, sends nothing', opts, async () => {
  reset()
  const live = await paid(35000, 'live')
  const res = await admin({ action: 'request_refund', registration_id: live.id })
  assertEquals([posts.length, res.json.refund.problem], [0, true])
  assert(/was a live payment and the site is using test keys/.test(res.json.refund.message))
  const p = await paid()
  const off = await admin({ action: 'request_refund', registration_id: p.id }, { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: '' })
  assertEquals([posts.length, off.json.refund.problem, (await reg(p.id)).status], [0, true, 'refund_pending'])
  assert(/Refund it in the Paystack dashboard/.test(off.json.refund.message))
  // The training business's key is never used for a webinar refund.
  const same = await admin({ action: 'send_refund', registration_id: p.id }, { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_test_training999' })
  assertEquals([posts.length, same.json.refund.problem], [0, true])
})

Deno.test('Send refund is only for a place already marked for refund', opts, async () => {
  reset()
  const p = await paid()
  const res = await admin({ action: 'send_refund', registration_id: p.id })
  assertEquals([res.status, res.json.error], [409, 'Only a place marked for refund can be refunded from here.'])
  assertEquals(posts.length, 0)
  const unsigned = await adminAction({ request: new Request('https://training.example/api/admin/workshops', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'send_refund', registration_id: p.id }) }), env: ENV, waitUntil: () => {} })
  assertEquals(unsigned.status, 403)
})

Deno.test('when Paystack confirms, the existing webhook path frees the place', opts, async () => {
  reset()
  const p = await paid()
  await admin({ action: 'request_refund', registration_id: p.id })
  const out = (await rows(`select public.workshop_apply_refund($1, 35000, 'test') as j`, [p.ref]))[0].j
  assertEquals(out.outcome, 'applied')
  const r = await reg(p.id)
  assertEquals([r.status, r.payment_status], ['refunded', 'refunded'])
})
