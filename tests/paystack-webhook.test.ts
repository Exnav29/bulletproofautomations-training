/**
 * Regression tests for supabase/functions/paystack-webhook.
 *
 *   deno test --allow-net --allow-env --allow-read tests/paystack-webhook.test.ts
 *
 * The real function is imported and served; its database is an in-memory stand-in for
 * the PostgREST calls it makes (payment_events, enrollments, payment_plan_installments),
 * so every request below runs the deployed code path end to end without Supabase.
 * WEBHOOK_MODULE=<path> runs the same suite against another copy of the function — used
 * to record which cases the code before the scheduling guard got wrong.
 *
 * The Paystack account is shared with Bulletproof Scheduling (book.bulletproofautomations.com).
 * Its references start BPS- and its checkouts carry metadata.app = "bulletproof-scheduling".
 * Those payments must never touch an enrollment, even when the payer's email matches one.
 */
import { assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'

const LIVE = 'sk_live_test_suite_only_000000000000000000000'
const TEST = 'sk_test_test_suite_only_000000000000000000000'
const DB_PORT = 54329

// --- in-memory PostgREST stand-in ----------------------------------------------------

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let nextId = 1
/** When set, every PATCH to payment_events fails with a 500, like a database outage. */
let failEventPatch = false

function reset(seed: Partial<Record<string, Row[]>> = {}) {
  failEventPatch = false
  tables = {
    payment_events: [],
    enrollments: (seed.enrollments ?? []).map((r) => ({ ...r })),
    payment_plan_installments: (seed.payment_plan_installments ?? []).map((r) => ({ ...r })),
  }
}

function filtersOf(params: URLSearchParams) {
  const out: Array<[string, string, string]> = []
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue
    const dot = v.indexOf('.')
    out.push([k, v.slice(0, dot), v.slice(dot + 1)])
  }
  return out
}

function matches(row: Row, filters: Array<[string, string, string]>) {
  return filters.every(([col, op, val]) => {
    const cell = row[col] == null ? null : String(row[col])
    if (op === 'eq') return cell === val
    if (op === 'neq') return cell !== val
    throw new Error(`stand-in DB: unsupported operator ${op}`)
  })
}

Deno.serve({ port: DB_PORT, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  const table = url.pathname.replace('/rest/v1/', '')
  const rows = tables[table]
  if (!rows) return new Response('no such table', { status: 404 })
  const params = url.searchParams
  const filters = filtersOf(params)

  if (req.method === 'POST') {
    const body = await req.json()
    const keys = (params.get('on_conflict') ?? '').split(',').filter(Boolean)
    // Postgres unique constraints treat NULLs as distinct, so a NULL key never conflicts.
    const clash = keys.length > 0 &&
      rows.some((r) => keys.every((k) => body[k] != null && r[k] === body[k]))
    if (clash) return Response.json([])
    const row = { id: nextId++, matched: null, match_note: null, enrollment_id: null, ...body }
    rows.push(row)
    return Response.json([row], { status: 201 })
  }
  if (req.method === 'PATCH') {
    if (failEventPatch && table === 'payment_events') return new Response('db down', { status: 500 })
    const patch = await req.json()
    for (const r of rows) if (matches(r, filters)) Object.assign(r, patch)
    return new Response(null, { status: 204 })
  }
  let found = rows.filter((r) => matches(r, filters))
  if (params.get('order') === 'created_at.desc') {
    found = [...found].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }
  const limit = Number(params.get('limit') ?? found.length)
  return Response.json(found.slice(0, limit))
})

// --- the function under test ---------------------------------------------------------

Deno.env.set('PAYSTACK_SECRET_KEY', LIVE)
Deno.env.set('PAYSTACK_TEST_SECRET_KEY', TEST)
Deno.env.set('PROJECT_URL', `http://127.0.0.1:${DB_PORT}`)
Deno.env.set('SERVICE_ROLE_KEY', 'service-role-for-tests')
const modulePath = Deno.env.get('WEBHOOK_MODULE') ??
  new URL('../supabase/functions/paystack-webhook/index.ts', import.meta.url).href
await import(modulePath.startsWith('file:') || modulePath.startsWith('http') ? modulePath : `file://${modulePath}`)
const FN = 'http://127.0.0.1:8000/' // std@0.168 serve() default

async function hmac(raw: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function deliver(event: Row, key: string | null = LIVE): Promise<Row> {
  const raw = JSON.stringify(event)
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'x-paystack-signature': key ? await hmac(raw, key) : 'f'.repeat(128) },
    body: raw,
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

const charge = (reference: string, email: string, amount: number, extra: Row = {}) => ({
  event: 'charge.success',
  data: {
    reference, amount, currency: 'GHS', status: 'success', domain: 'live',
    paid_at: '2026-11-02T10:00:00.000Z', customer: { email }, ...extra,
  },
})
const refund = (transactionReference: string, email: string, amount: number, extra: Row = {}) => ({
  event: 'refund.processed',
  data: {
    id: 9001, transaction_reference: transactionReference, amount, currency: 'GHS',
    status: 'processed', domain: 'live', customer: { email }, ...extra,
  },
})

const ENROLLED = 'student@example.com'
const enrollment = (over: Row = {}) => ({
  id: 'enr-1', email: ENROLLED, amount_ghs: 750, amount_paid_ghs: 0, payment_status: 'pending',
  paystack_reference: 'BPA-CAB-2026-ENROLL1', created_at: '2026-10-01T00:00:00Z', ...over,
})
const enr = () => tables.enrollments[0]
const lastEvent = () => tables.payment_events[tables.payment_events.length - 1]
const opts = { sanitizeOps: false, sanitizeResources: false }

// --- Bulletproof Scheduling payments never touch an enrollment -------------------------

Deno.test('scheduling LIVE charge whose email matches an enrollment is not applied', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPS-LIVE-2026-APPT0001', ENROLLED, 225000,
    { metadata: { app: 'bulletproof-scheduling', booking_id: 'b-1' } }))
  assertEquals(r.status, 200)
  assertEquals(r.applied, false)
  assertEquals(enr().amount_paid_ghs, 0)
  assertEquals(enr().payment_status, 'pending')
  assertEquals(enr().paystack_reference, 'BPA-CAB-2026-ENROLL1')
  assertEquals(r.scheduling, true)
  assertEquals(lastEvent().matched, false)
  assertEquals(lastEvent().match_note, 'Bulletproof Scheduling payment; not an enrollment')
  assertEquals(lastEvent().signature_valid, true) // still logged
})

Deno.test('scheduling charge recognised by metadata alone (no BPS- reference) is not applied', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('T836219907402', ENROLLED, 225000,
    { metadata: { app: 'bulletproof-scheduling' } }))
  assertEquals(r.applied, false)
  assertEquals(enr().amount_paid_ghs, 0)
})

Deno.test('scheduling metadata sent as a JSON string is recognised too', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('T836219907403', ENROLLED, 225000,
    { metadata: JSON.stringify({ app: 'bulletproof-scheduling' }) }))
  assertEquals(r.applied, false)
  assertEquals(enr().amount_paid_ghs, 0)
})

Deno.test('scheduling refund whose email matches a PAID enrollment reverses nothing', opts, async () => {
  reset({ enrollments: [enrollment({ amount_paid_ghs: 750, payment_status: 'paid' })] })
  for (const shape of [
    refund('BPS-LIVE-2026-APPT0001', ENROLLED, 225000),
    refund('', ENROLLED, 225000, { transaction_reference: undefined, transaction: { reference: 'BPS-LIVE-2026-APPT0002' } }),
    refund('', ENROLLED, 225000, { id: 9002, transaction_reference: undefined, reference: 'BPS-LIVE-2026-APPT0003' }),
  ]) {
    const r = await deliver(shape)
    assertEquals(r.applied, false)
  }
  assertEquals(enr().amount_paid_ghs, 750)
  assertEquals(enr().payment_status, 'paid')
})

Deno.test('scheduling TEST charge is not applied (test/live protection unchanged)', opts, async () => {
  reset({ enrollments: [enrollment({ paystack_reference: 'BPA-TEST-2026-ENROLL1' })] })
  const r = await deliver(charge('BPS-TEST-2026-APPT0001', ENROLLED, 100, { domain: 'test' }), TEST)
  assertEquals(r.applied, false)
  assertEquals(enr().amount_paid_ghs, 0)
  // The existing test-mode check still decides first; the scheduling guard comes after it.
  assertEquals(lastEvent().match_note, 'Test-mode charge with no test reference; not applied')
})

Deno.test('guard runs AFTER the mode checks: test-signed scheduling charge claiming live is refused by them', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPS-LIVE-2026-APPT0001', ENROLLED, 225000), TEST)
  assertEquals(r.applied, false)
  assertEquals(lastEvent().match_note, 'Refused: domain live but signed with the test key')
  assertEquals(enr().amount_paid_ghs, 0)
})

Deno.test('failed audit write answers 503 (Paystack retries); the retry records it, nothing applied', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const ev = charge('BPS-LIVE-2026-APPT0010', ENROLLED, 225000, { metadata: { app: 'bulletproof-scheduling' } })
  failEventPatch = true
  const first = await deliver(ev)
  assertEquals(first.status, 503)
  assertEquals(first.ok, false)
  assertEquals(enr().amount_paid_ghs, 0)
  assertEquals(lastEvent().matched, null) // logged, not yet noted
  failEventPatch = false
  const retry = await deliver(ev)
  assertEquals(retry.status, 200)
  assertEquals(retry.scheduling, true)
  assertEquals(tables.payment_events.length, 1)
  assertEquals(lastEvent().match_note, 'Bulletproof Scheduling payment; not an enrollment')
  assertEquals(enr().amount_paid_ghs, 0)
  assertEquals(enr().payment_status, 'pending')
})

Deno.test('duplicate scheduling notification stays unapplied', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const ev = charge('BPS-LIVE-2026-APPT0009', ENROLLED, 225000)
  assertEquals((await deliver(ev)).applied, false)
  const again = await deliver(ev)
  assertEquals(again.status, 200)
  assertEquals(again.applied ?? false, false)
  assertEquals(enr().amount_paid_ghs, 0)
  assertEquals(tables.payment_events.length, 1)
})

Deno.test('scheduling charge with an INVALID signature: logged as invalid, not applied', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPS-LIVE-2026-APPT0001', ENROLLED, 225000), null)
  assertEquals(r.applied, false)
  assertEquals(r.signature_valid, false)
  assertEquals(r.scheduling, undefined) // stopped by the signature check, before the guard
  assertEquals(lastEvent().signature_valid, false)
  assertEquals(lastEvent().match_note, null)
  assertEquals(enr().amount_paid_ghs, 0)
})

// --- training behaviour is preserved --------------------------------------------------

Deno.test('training: live charge on its own reference is applied', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPA-CAB-2026-ENROLL1', ENROLLED, 75000,
    { metadata: { enrollment_id: 'enr-1', payment_plan: 'full' } }))
  assertEquals(r.applied, true)
  assertEquals(enr().amount_paid_ghs, 750)
  assertEquals(enr().payment_status, 'paid')
  assertEquals(lastEvent().matched, true)
  assertEquals(lastEvent().enrollment_id, 'enr-1')
})

Deno.test('training: installment charge advances the enrollment and the installment', opts, async () => {
  reset({
    enrollments: [enrollment({ paystack_reference: null })],
    payment_plan_installments: [{
      id: 'inst-1', enrollment_id: 'enr-1', amount_ghs: 400, status: 'pending',
      paystack_reference: 'BPA-CAB-2026-INSTAL1',
    }],
  })
  const r = await deliver(charge('BPA-CAB-2026-INSTAL1', ENROLLED, 40000,
    { metadata: { enrollment_id: 'enr-1', payment_plan: 'instalments', installment_id: 'inst-1' } }))
  assertEquals(r.applied, true)
  assertEquals(enr().amount_paid_ghs, 400)
  assertEquals(enr().payment_status, 'partially_paid')
  assertEquals(tables.payment_plan_installments[0].status, 'paid')
})

Deno.test('training: live charge with a reference we did not mint still falls back to email', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('T836219907499', ENROLLED, 75000)) // dashboard / hosted page
  assertEquals(r.applied, true)
  assertEquals(enr().amount_paid_ghs, 750)
  assertEquals(lastEvent().match_note.startsWith('Matched on email'), true)
})

Deno.test('training: duplicate notification is not applied twice', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const ev = charge('BPA-CAB-2026-ENROLL1', ENROLLED, 40000)
  assertEquals((await deliver(ev)).applied, true)
  const again = await deliver(ev)
  assertEquals(again.duplicate, true)
  assertEquals(enr().amount_paid_ghs, 400)
})

Deno.test('training: invalid signature is logged and not applied', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPA-CAB-2026-ENROLL1', ENROLLED, 75000), 'sk_live_wrong_key_0000000000000000000000000')
  assertEquals(r.applied, false)
  assertEquals(r.signature_valid, false)
  assertEquals(lastEvent().signature_valid, false)
  assertEquals(enr().amount_paid_ghs, 0)
})

Deno.test('training: processed refund reverses the payment; pending refund does not', opts, async () => {
  reset({ enrollments: [enrollment({ amount_paid_ghs: 750, payment_status: 'paid' })] })
  const pending = await deliver({ ...refund('BPA-CAB-2026-ENROLL1', ENROLLED, 75000), event: 'refund.pending' })
  assertEquals(pending.applied, false)
  assertEquals(enr().amount_paid_ghs, 750)
  const r = await deliver(refund('BPA-CAB-2026-ENROLL1', ENROLLED, 75000))
  assertEquals(r.applied, true)
  assertEquals(enr().amount_paid_ghs, 0)
  assertEquals(enr().payment_status, 'cancelled')
})

Deno.test('training: refund never falls back to email', opts, async () => {
  reset({ enrollments: [enrollment({ amount_paid_ghs: 750, payment_status: 'paid' })] })
  const r = await deliver(refund('T836219907499', ENROLLED, 75000))
  assertEquals(r.applied, false)
  assertEquals(enr().amount_paid_ghs, 750)
})

Deno.test('training: test-mode charge settles a test enrollment only', opts, async () => {
  reset({ enrollments: [enrollment({ paystack_reference: 'BPA-TEST-2026-ENROLL1' })] })
  const r = await deliver(charge('BPA-TEST-2026-ENROLL1', ENROLLED, 75000, { domain: 'test' }), TEST)
  assertEquals(r.applied, true)
  assertEquals(enr().amount_paid_ghs, 750)
})

Deno.test('training: test-signed charge claiming the live domain is refused', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPA-CAB-2026-ENROLL1', ENROLLED, 75000), TEST)
  assertEquals(r.applied, false)
  assertEquals(enr().amount_paid_ghs, 0)
})

Deno.test('training: live reference on a test charge is refused', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPA-CAB-2026-ENROLL1', ENROLLED, 75000, { domain: 'test' }), TEST)
  assertEquals(r.applied, false)
  assertEquals(enr().amount_paid_ghs, 0)
})

Deno.test('training: test charge without a test reference never reaches the email fallback', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('T836219907500', ENROLLED, 75000, { domain: 'test' }), TEST)
  assertEquals(r.applied, false)
  assertEquals(enr().amount_paid_ghs, 0)
})

Deno.test('unrelated reference with no matching email is logged as unmatched', opts, async () => {
  reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('OTHER-APP-123', 'someone-else@example.com', 5000))
  assertEquals(r.applied, false)
  assertEquals(lastEvent().matched, false)
  assertEquals(lastEvent().match_note, 'No enrollment matched this reference or email')
  assertEquals(enr().amount_paid_ghs, 0)
})
