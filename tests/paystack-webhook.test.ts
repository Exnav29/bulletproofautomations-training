/**
 * Regression tests for supabase/functions/paystack-webhook.
 *
 *   deno test --node-modules-dir=none --allow-net --allow-env --allow-read tests/paystack-webhook.test.ts
 *
 * The real function is imported and served. Its database is PGlite (real PostgreSQL)
 * loaded with tests/fixtures/payment-ledger.sql: production's payment_events, enrollments
 * and payment_plan_installments tables, copied from the live catalog with their
 * constraints, indexes and triggers, including payment_events_mark_installment_paid.
 * A thin stand-in translates the PostgREST calls the function makes into SQL, so every
 * request runs the deployed code path end to end against production's schema.
 *
 * WEBHOOK_MODULE=<path> runs the same suite against another copy of the function, e.g.
 * the production snapshot in supabase/deployed/.
 *
 * The Paystack account is shared with Bulletproof Scheduling (book.bulletproofautomations.com).
 * Its references start BPS- and its checkouts carry metadata.app = "bulletproof-scheduling".
 * Those payments must never touch an enrollment, even when the payer's email matches one.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14'

const LIVE = 'sk_live_test_suite_only_000000000000000000000'
const TEST = 'sk_test_test_suite_only_000000000000000000000'
const DB_PORT = 54329

// --- production schema in PGlite --------------------------------------------------------

type Row = Record<string, any>
const pg = new PGlite()
await pg.exec(await Deno.readTextFile(new URL('./fixtures/payment-ledger.sql', import.meta.url)))

const TABLES = new Set(['payment_events', 'enrollments', 'payment_plan_installments'])
function ident(name: string) {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`stand-in: bad identifier ${name}`)
  return name
}
const param = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)

async function select(sql: string, values: unknown[] = []): Promise<Row[]> {
  return (await pg.query<{ j: Row }>(`select row_to_json(x) as j from (${sql}) x`, values)).rows.map((r) => r.j)
}

async function insert(table: string, row: Row, onConflict?: string[]): Promise<Row[]> {
  const cols = Object.keys(row).map(ident)
  const sql = `with ins as (insert into public.${ident(table)} (${cols.join(', ')}) ` +
    `values (${cols.map((_, i) => `$${i + 1}`).join(', ')})` +
    (onConflict ? ` on conflict (${onConflict.map(ident).join(', ')}) do nothing` : '') +
    ` returning *) select row_to_json(ins) as j from ins`
  return (await pg.query<{ j: Row }>(sql, cols.map((c) => param(row[c])))).rows.map((r) => r.j)
}

/** PostgREST's eq / neq filters from a query string, as SQL. */
function where(params: URLSearchParams, first: number): [string, unknown[]] {
  const parts: string[] = [], values: unknown[] = []
  for (const [key, value] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(key)) continue
    const dot = value.indexOf('.')
    const op = value.slice(0, dot), operand = value.slice(dot + 1)
    if (op !== 'eq' && op !== 'neq') throw new Error(`stand-in: unsupported operator ${op}`)
    parts.push(`${ident(key)}::text ${op === 'eq' ? '=' : '<>'} $${first + values.length}`)
    values.push(operand)
  }
  return [parts.length ? ` where ${parts.join(' and ')}` : '', values]
}

/** When set, every PATCH to payment_events fails with a 500, like a database outage. */
let failEventPatch = false

Deno.serve({ port: DB_PORT, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  const table = url.pathname.replace('/rest/v1/', '')
  // PostgREST's own answer for a table missing from the schema cache. This is what v10 sees
  // for workshop_payment_attempts if it is deployed before the workshop migration.
  if (!TABLES.has(table)) {
    return Response.json(
      { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` },
      { status: 404 },
    )
  }
  const params = url.searchParams
  try {
    if (req.method === 'POST') {
      const conflict = params.get('on_conflict')?.split(',')
      const rows = await insert(table, await req.json(), conflict)
      return Response.json(rows, { status: 201 })
    }
    if (req.method === 'PATCH') {
      if (failEventPatch && table === 'payment_events') return new Response('db down', { status: 500 })
      const patch = await req.json()
      const cols = Object.keys(patch).map(ident)
      const [w, wv] = where(params, cols.length + 1)
      await pg.query(
        `update public.${table} set ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}${w}`,
        [...cols.map((c) => param(patch[c])), ...wv],
      )
      return new Response(null, { status: 204 })
    }
    const cols = (params.get('select') ?? '*').split(',').map((c) => (c === '*' ? c : ident(c))).join(', ')
    const [w, wv] = where(params, 1)
    const order = params.get('order')
    const by = order ? ` order by ${ident(order.split('.')[0])} ${order.endsWith('.desc') ? 'desc' : 'asc'}` : ''
    const limit = params.get('limit') ? ` limit ${Number(params.get('limit'))}` : ''
    return Response.json(await select(`select ${cols} from public.${table}${w}${by}${limit}`, wv))
  } catch (err) {
    // PostgREST answers a failed statement with a 4xx and the database's message.
    return Response.json({ message: String((err as Error).message) }, { status: 400 })
  }
})

async function reset(seed: { enrollments?: Row[]; installments?: Row[] } = {}) {
  failEventPatch = false
  await pg.exec('truncate public.payment_events, public.payment_plan_installments, public.enrollments cascade')
  for (const e of seed.enrollments ?? []) await insert('enrollments', e)
  for (const i of seed.installments ?? []) await insert('payment_plan_installments', i)
}

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

const ENR = '00000000-0000-4000-8000-000000000001'
const ENROLLED = 'student@example.com'
const enrollment = (over: Row = {}) => ({
  id: ENR, full_name: 'Test Student', email: ENROLLED, whatsapp: '+233000000000', city: 'Accra',
  experience_level: 'beginner', chosen_option: 'cohort_only', amount_ghs: 750, amount_paid_ghs: 0,
  payment_status: 'payment_pending', paystack_reference: 'BPA-CAB-2026-ENROLL1',
  created_at: '2026-10-01T00:00:00Z', ...over,
})
const installment = (over: Row = {}) => ({
  id: '00000000-0000-4000-8000-0000000000a2', enrollment_id: ENR, installment_number: 2,
  amount_ghs: 350, status: 'sent', paystack_reference: 'BPA-CAB-2026-INSTAL2', ...over,
})
const enr = async () => (await select(`select * from public.enrollments where id = $1`, [ENR]))[0]
const inst = async (n = 2) =>
  (await select(`select * from public.payment_plan_installments where enrollment_id = $1 and installment_number = $2`, [ENR, n]))[0]
const lastEvent = async () => (await select(`select * from public.payment_events order by received_at desc limit 1`))[0]
const eventCount = async () => (await select(`select count(*)::int as n from public.payment_events`))[0].n
const opts = { sanitizeOps: false, sanitizeResources: false }

// --- Bulletproof Scheduling payments never touch an enrollment -------------------------

Deno.test('scheduling LIVE charge whose email matches an enrollment is not applied', opts, async () => {
  await reset({ enrollments: [enrollment()], installments: [installment()] })
  const r = await deliver(charge('BPS-LIVE-2026-APPT0001', ENROLLED, 225000,
    { metadata: { app: 'bulletproof-scheduling', booking_id: 'b-1' } }))
  assertEquals(r.status, 200)
  assertEquals(r.applied, false)
  assertEquals(r.scheduling, true)
  const e = await enr()
  assertEquals([e.amount_paid_ghs, e.payment_status, e.paystack_reference], [0, 'payment_pending', 'BPA-CAB-2026-ENROLL1'])
  assertEquals((await inst()).status, 'sent') // open installment untouched too
  const ev = await lastEvent()
  assertEquals([ev.matched, ev.match_note, ev.signature_valid], [false, 'Bulletproof Scheduling payment; not an enrollment', true])
})

Deno.test('scheduling charge recognised by metadata alone (no BPS- reference) is not applied', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('T836219907402', ENROLLED, 225000, { metadata: { app: 'bulletproof-scheduling' } }))
  assertEquals(r.applied, false)
  assertEquals((await enr()).amount_paid_ghs, 0)
})

Deno.test('scheduling metadata sent as a JSON string is recognised too', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('T836219907403', ENROLLED, 225000,
    { metadata: JSON.stringify({ app: 'bulletproof-scheduling' }) }))
  assertEquals(r.applied, false)
  assertEquals((await enr()).amount_paid_ghs, 0)
})

Deno.test('scheduling refund whose email matches a PAID enrollment reverses nothing', opts, async () => {
  await reset({ enrollments: [enrollment({ amount_paid_ghs: 750, payment_status: 'paid' })] })
  for (const shape of [
    refund('BPS-LIVE-2026-APPT0001', ENROLLED, 225000),
    refund('', ENROLLED, 225000, { transaction_reference: undefined, transaction: { reference: 'BPS-LIVE-2026-APPT0002' } }),
    refund('', ENROLLED, 225000, { id: 9002, transaction_reference: undefined, reference: 'BPS-LIVE-2026-APPT0003' }),
  ]) {
    assertEquals((await deliver(shape)).applied, false)
  }
  const e = await enr()
  assertEquals([e.amount_paid_ghs, e.payment_status], [750, 'paid'])
})

Deno.test('scheduling TEST charge is not applied (test/live protection unchanged)', opts, async () => {
  await reset({ enrollments: [enrollment({ paystack_reference: 'BPA-TEST-2026-ENROLL1' })] })
  const r = await deliver(charge('BPS-TEST-2026-APPT0001', ENROLLED, 100, { domain: 'test' }), TEST)
  assertEquals(r.applied, false)
  assertEquals((await enr()).amount_paid_ghs, 0)
  // The existing test-mode check still decides first; the scheduling guard comes after it.
  assertEquals((await lastEvent()).match_note, 'Test-mode charge with no test reference; not applied')
})

Deno.test('guard runs AFTER the mode checks: test-signed scheduling charge claiming live is refused by them', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPS-LIVE-2026-APPT0001', ENROLLED, 225000), TEST)
  assertEquals(r.applied, false)
  assertEquals((await lastEvent()).match_note, 'Refused: domain live but signed with the test key')
  assertEquals((await enr()).amount_paid_ghs, 0)
})

Deno.test('failed audit write answers 503 (Paystack retries); the retry records it, nothing applied', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const ev = charge('BPS-LIVE-2026-APPT0010', ENROLLED, 225000, { metadata: { app: 'bulletproof-scheduling' } })
  failEventPatch = true
  const first = await deliver(ev)
  assertEquals([first.status, first.ok], [503, false])
  assertEquals((await enr()).amount_paid_ghs, 0)
  const logged = await lastEvent()
  assertEquals([logged.matched, logged.match_note], [false, null]) // logged, not yet noted
  failEventPatch = false
  const retry = await deliver(ev)
  assertEquals([retry.status, retry.scheduling], [200, true])
  assertEquals(await eventCount(), 1)
  assertEquals((await lastEvent()).match_note, 'Bulletproof Scheduling payment; not an enrollment')
  const e = await enr()
  assertEquals([e.amount_paid_ghs, e.payment_status], [0, 'payment_pending'])
})

Deno.test('duplicate scheduling notification stays unapplied', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const ev = charge('BPS-LIVE-2026-APPT0009', ENROLLED, 225000)
  assertEquals((await deliver(ev)).applied, false)
  const again = await deliver(ev)
  assertEquals(again.status, 200)
  assertEquals(again.applied ?? false, false)
  assertEquals((await enr()).amount_paid_ghs, 0)
  assertEquals(await eventCount(), 1)
})

Deno.test('scheduling charge with an INVALID signature: logged as invalid, not applied', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPS-LIVE-2026-APPT0001', ENROLLED, 225000), null)
  assertEquals([r.applied, r.signature_valid, r.scheduling], [false, false, undefined]) // stopped before the guard
  const ev = await lastEvent()
  assertEquals([ev.signature_valid, ev.match_note], [false, null])
  assertEquals((await enr()).amount_paid_ghs, 0)
})

// --- training behaviour is preserved --------------------------------------------------

Deno.test('training: live charge on its own reference is applied', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPA-CAB-2026-ENROLL1', ENROLLED, 75000,
    { metadata: { enrollment_id: ENR, payment_plan: 'full' } }))
  assertEquals(r.applied, true)
  const e = await enr()
  assertEquals([e.amount_paid_ghs, e.payment_status], [750, 'paid'])
  const ev = await lastEvent()
  assertEquals([ev.matched, ev.enrollment_id], [true, ENR])
})

Deno.test('training: installment charge advances the enrollment and the installment', opts, async () => {
  await reset({
    enrollments: [enrollment({ amount_paid_ghs: 400, payment_status: 'partially_paid' })],
    installments: [installment()],
  })
  const r = await deliver(charge('BPA-CAB-2026-INSTAL2', ENROLLED, 35000,
    { metadata: { enrollment_id: ENR, payment_plan: 'instalments', installment_number: 2 } }))
  assertEquals(r.applied, true)
  const e = await enr()
  assertEquals([e.amount_paid_ghs, e.payment_status], [750, 'paid'])
  const i = await inst()
  assertEquals(i.status, 'paid')
  assertEquals(new Date(i.paid_at).toISOString(), '2026-11-02T10:00:00.000Z')
})

Deno.test('training: full installment plan, seeded by the database after the deposit, then paid off', opts, async () => {
  await reset({
    enrollments: [enrollment({ payment_plan: true, first_instalment_ghs: 400, paystack_reference: 'BPA-CAB-2026-DEPOSIT' })],
  })
  assertEquals((await deliver(charge('BPA-CAB-2026-DEPOSIT', ENROLLED, 40000))).applied, true)
  // enrollments_seed_intermediate_payment_plan: deposit recorded as paid, balance scheduled.
  assertEquals([(await inst(1)).status, (await inst(1)).paystack_reference], ['paid', 'BPA-CAB-2026-DEPOSIT'])
  assertEquals([(await inst(2)).status, (await inst(2)).amount_ghs], ['scheduled', 350])
  // functions/api/installment.js mints the second reference and sends the link.
  await pg.query(`update public.payment_plan_installments set status = 'sent', paystack_reference = $1
                  where enrollment_id = $2 and installment_number = 2`, ['BPA-CAB-2026-SECOND', ENR])
  const second = charge('BPA-CAB-2026-SECOND', ENROLLED, 35000)
  assertEquals((await deliver(second)).applied, true)
  const e = await enr()
  assertEquals([e.amount_paid_ghs, e.payment_status], [750, 'paid'])
  const paid = await inst(2)
  assertEquals(paid.status, 'paid')
  // A duplicate delivery adds nothing and does not move paid_at.
  assertEquals((await deliver(second)).duplicate, true)
  assertEquals((await enr()).amount_paid_ghs, 750)
  assertEquals((await inst(2)).paid_at, paid.paid_at)
})

Deno.test('training: live charge with a reference we did not mint still falls back to email', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('T836219907499', ENROLLED, 75000)) // dashboard / hosted page
  assertEquals(r.applied, true)
  assertEquals((await enr()).amount_paid_ghs, 750)
  assert((await lastEvent()).match_note.startsWith('Matched on email'))
})

Deno.test('training: duplicate notification is not applied twice', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const ev = charge('BPA-CAB-2026-ENROLL1', ENROLLED, 40000)
  assertEquals((await deliver(ev)).applied, true)
  assertEquals((await deliver(ev)).duplicate, true)
  assertEquals((await enr()).amount_paid_ghs, 400)
})

Deno.test('training: invalid signature is logged and not applied', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('BPA-CAB-2026-ENROLL1', ENROLLED, 75000), 'sk_live_wrong_key_0000000000000000000000000')
  assertEquals([r.applied, r.signature_valid], [false, false])
  assertEquals((await lastEvent()).signature_valid, false)
  assertEquals((await enr()).amount_paid_ghs, 0)
})

Deno.test('training: processed refund reverses the payment; pending refund does not', opts, async () => {
  await reset({ enrollments: [enrollment({ amount_paid_ghs: 750, payment_status: 'paid' })] })
  const pending = await deliver({ ...refund('BPA-CAB-2026-ENROLL1', ENROLLED, 75000), event: 'refund.pending' })
  assertEquals(pending.applied, false)
  assertEquals((await enr()).amount_paid_ghs, 750)
  assertEquals((await deliver(refund('BPA-CAB-2026-ENROLL1', ENROLLED, 75000))).applied, true)
  const e = await enr()
  assertEquals([e.amount_paid_ghs, e.payment_status], [0, 'cancelled'])
})

Deno.test('training: refund never falls back to email', opts, async () => {
  await reset({ enrollments: [enrollment({ amount_paid_ghs: 750, payment_status: 'paid' })] })
  assertEquals((await deliver(refund('T836219907499', ENROLLED, 75000))).applied, false)
  assertEquals((await enr()).amount_paid_ghs, 750)
})

Deno.test('training: test-mode charge settles a test enrollment only', opts, async () => {
  await reset({ enrollments: [enrollment({ paystack_reference: 'BPA-TEST-2026-ENROLL1' })] })
  const r = await deliver(charge('BPA-TEST-2026-ENROLL1', ENROLLED, 75000, { domain: 'test' }), TEST)
  assertEquals(r.applied, true)
  assertEquals((await enr()).amount_paid_ghs, 750)
})

Deno.test('training: test-signed charge claiming the live domain is refused', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  assertEquals((await deliver(charge('BPA-CAB-2026-ENROLL1', ENROLLED, 75000), TEST)).applied, false)
  assertEquals((await enr()).amount_paid_ghs, 0)
})

Deno.test('training: live reference on a test charge is refused', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  assertEquals((await deliver(charge('BPA-CAB-2026-ENROLL1', ENROLLED, 75000, { domain: 'test' }), TEST)).applied, false)
  assertEquals((await enr()).amount_paid_ghs, 0)
})

Deno.test('training: test charge without a test reference never reaches the email fallback', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  assertEquals((await deliver(charge('T836219907500', ENROLLED, 75000, { domain: 'test' }), TEST)).applied, false)
  assertEquals((await enr()).amount_paid_ghs, 0)
})

Deno.test('unrelated reference with no matching email is logged as unmatched', opts, async () => {
  await reset({ enrollments: [enrollment()] })
  const r = await deliver(charge('OTHER-APP-123', 'someone-else@example.com', 5000))
  assertEquals(r.applied, false)
  const ev = await lastEvent()
  assertEquals([ev.matched, ev.match_note], [false, 'No enrollment matched this reference or email'])
  assertEquals((await enr()).amount_paid_ghs, 0)
})

// --- payment_events_mark_installment_paid, exercised directly ---------------------------
//
// These drive the production trigger with plain SQL, one condition at a time, so its
// behaviour is pinned independently of the webhook.

const PAID_AT = '2026-11-02T09:30:00.000Z'
async function markMatched(over: Row = {}, matched = true) {
  const [ev] = await insert('payment_events', {
    provider: 'paystack', event: 'charge.success', reference: 'BPA-CAB-2026-INSTAL2',
    signature_valid: true, paid_at: PAID_AT, raw: {}, ...over,
  })
  await pg.query(`update public.payment_events set matched = $1 where id = $2`, [matched, ev.id])
  return ev.id as string
}
const installmentStatus = async () => (await inst()).status

Deno.test('trigger: a verified charge.success matched false -> true marks its installment paid at the event time', opts, async () => {
  await reset({ enrollments: [enrollment()], installments: [installment()] })
  await markMatched()
  const i = await inst()
  assertEquals(i.status, 'paid')
  assertEquals(new Date(i.paid_at).toISOString(), PAID_AT)
})

Deno.test('trigger: no paid_at on the event -> installment paid_at is now()', opts, async () => {
  await reset({ enrollments: [enrollment()], installments: [installment()] })
  const before = Date.now() - 1000
  await markMatched({ paid_at: null })
  const i = await inst()
  assertEquals(i.status, 'paid')
  assert(new Date(i.paid_at).getTime() >= before)
})

Deno.test('trigger: ignores unverified events, other event types, other providers and other references', opts, async () => {
  for (const over of [
    { signature_valid: false },
    { event: 'refund.processed' },
    { event: 'charge.failed' },
    { provider: 'stripe' },
    { reference: 'BPA-CAB-2026-SOMEOTHER' },
    { reference: 'BPS-LIVE-2026-APPT0001' },
  ]) {
    await reset({ enrollments: [enrollment()], installments: [installment()] })
    await markMatched(over)
    assertEquals(await installmentStatus(), 'sent', JSON.stringify(over))
  }
})

Deno.test('trigger: does not fire when matched is set to false', opts, async () => {
  await reset({ enrollments: [enrollment()], installments: [installment()] })
  await markMatched({}, false)
  assertEquals(await installmentStatus(), 'sent')
})

Deno.test('trigger: fires only on update — an event inserted already matched does nothing', opts, async () => {
  await reset({ enrollments: [enrollment()], installments: [installment()] })
  await insert('payment_events', {
    provider: 'paystack', event: 'charge.success', reference: 'BPA-CAB-2026-INSTAL2',
    signature_valid: true, matched: true, paid_at: PAID_AT, raw: {},
  })
  assertEquals(await installmentStatus(), 'sent')
})

Deno.test('trigger: duplicate protection — an already-paid installment keeps its original paid_at', opts, async () => {
  const original = '2026-10-20T08:00:00.000Z'
  await reset({ enrollments: [enrollment()], installments: [installment({ status: 'paid', paid_at: original })] })
  await markMatched()
  assertEquals(new Date((await inst()).paid_at).toISOString(), original)
})

Deno.test('trigger: duplicate protection — re-marking an already-matched event does not fire again', opts, async () => {
  await reset({ enrollments: [enrollment()], installments: [installment()] })
  const id = await markMatched()
  // An operator re-opens the installment by hand; a later matched = true on the same
  // event (old.matched already true) must not overrule that.
  await pg.query(`update public.payment_plan_installments set status = 'sent', paid_at = null where id = $1`, [installment().id])
  await pg.query(`update public.payment_events set matched = true, match_note = 'touched' where id = $1`, [id])
  assertEquals(await installmentStatus(), 'sent')
})

Deno.test('fixture: trigger functions are the ones documented in supabase-payment-plans.sql', opts, async () => {
  const code = (s: string) =>
    s.replace(/\$function\$/g, '$$$$').split('$$')[1].replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const fixture = await Deno.readTextFile(new URL('./fixtures/payment-ledger.sql', import.meta.url))
  const documented = await Deno.readTextFile(new URL('../supabase-payment-plans.sql', import.meta.url))
  for (const fn of ['mark_installment_paid_from_event', 'seed_intermediate_payment_plan_from_enrollment']) {
    const grab = (src: string) => {
      const start = src.toLowerCase().indexOf(`function public.${fn}()`)
      assert(start >= 0, `${fn} missing`)
      return code(src.slice(start))
    }
    assertEquals(grab(fixture), grab(documented), fn)
  }
})
