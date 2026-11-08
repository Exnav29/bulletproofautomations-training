/**
 * The webinar Paystack business's webhook (supabase/functions/workshop-paystack-webhook).
 *
 *   deno test --node-modules-dir=none --allow-net --allow-env --allow-read tests/workshop-webhook.test.ts
 *
 * Database: PGlite with production's ledger (tests/fixtures/payment-ledger.sql), Supabase role
 * stubs and the workshop migration, so cohort tables, the training ledger (payment_events) and
 * the installment trigger are all real. Every case seeds a part-paid cohort enrollment and an
 * open installment under the SAME email, and asserts afterwards that the cohort rows are
 * byte-for-byte unchanged and that nothing at all was written to payment_events.
 *
 * The training webhook (paystack-webhook, production v9) is not involved and not changed:
 * its own suite, tests/paystack-webhook.test.ts, is main's file and runs unchanged.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14'

// The WEBINAR business's keys, and (different) training business keys for the guard.
const LIVE = 'sk_live_webinar_business_suite_000000000000000'
const TEST = 'sk_test_webinar_business_suite_000000000000000'
const TRAINING_LIVE = 'sk_live_training_business_suite_00000000000000'
const TRAINING_TEST = 'sk_test_training_business_suite_00000000000000'
const DB_PORT = 54331

type Row = Record<string, any>
const pg = new PGlite()
// Release 2 (admission, prices, benefits) is loaded too: the webhook must behave the same on top of it.
for (const f of ['./fixtures/payment-ledger.sql', './fixtures/supabase-stubs.sql', './fixtures/graduate-records.sql',
  '../supabase/migrations/20261103120000_workshops.sql', '../supabase/migrations/20261109120000_workshop_admission_benefits.sql']) {
  await pg.exec(await Deno.readTextFile(new URL(f, import.meta.url)))
}

const TABLES = new Set(['workshop_payment_events'])
const RPCS = new Set(['workshop_apply_charge', 'workshop_apply_refund'])
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

let failRpc = false
let failAttemptLookup = false

Deno.serve({ port: DB_PORT, onListen() {} }, async (req) => {
  const url = new URL(req.url)
  const path = url.pathname.replace('/rest/v1/', '')
  const params = url.searchParams
  try {
    if (path.startsWith('rpc/')) {
      const name = ident(path.slice(4))
      if (!RPCS.has(name)) return Response.json({ code: 'PGRST202', message: 'no such function' }, { status: 404 })
      if (failRpc) return new Response('db down', { status: 500 })
      const args = await req.json()
      const keys = Object.keys(args).map(ident)
      const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as j`
      const res = await pg.query<{ j: Row }>(sql, keys.map((k) => param(args[k])))
      return Response.json(res.rows[0].j)
    }
    const table = path
    if (!TABLES.has(table)) {
      return Response.json({ code: 'PGRST205', message: `Could not find the table 'public.${table}'` }, { status: 404 })
    }
    if (table === 'workshop_payment_attempts' && failAttemptLookup) return new Response('db down', { status: 503 })
    if (req.method === 'POST') {
      const conflict = params.get('on_conflict')?.split(',')
      return Response.json(await insert(table, await req.json(), conflict), { status: 201 })
    }
    if (req.method === 'PATCH') {
      const patch = await req.json()
      const cols = Object.keys(patch).map(ident)
      const [w, wv] = where(params, cols.length + 1)
      await pg.query(`update public.${table} set ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}${w}`,
        [...cols.map((c) => param(patch[c])), ...wv])
      return new Response(null, { status: 204 })
    }
    const cols = (params.get('select') ?? '*').split(',').map((c) => (c === '*' ? c : ident(c))).join(', ')
    const [w, wv] = where(params, 1)
    const order = params.get('order')
    const by = order ? ` order by ${ident(order.split('.')[0])} ${order.endsWith('.desc') ? 'desc' : 'asc'}` : ''
    const limit = params.get('limit') ? ` limit ${Number(params.get('limit'))}` : ''
    return Response.json(await select(`select ${cols} from public.${table}${w}${by}${limit}`, wv))
  } catch (err) {
    return Response.json({ message: String((err as Error).message) }, { status: 400 })
  }
})

// --- seed data ------------------------------------------------------------------------

const EMAIL = 'learner@example.com' // the SAME address is a pending cohort student
const ENR = '00000000-0000-4000-8000-000000000001'
const SESSION = '00000000-0000-4000-8000-0000000000s1'.replace('s1', '51')
const enrollment = {
  id: ENR, full_name: 'Same Person', email: EMAIL, whatsapp: '+233000000000', city: 'Accra',
  experience_level: 'beginner', chosen_option: 'cohort_only', amount_ghs: 750, amount_paid_ghs: 400,
  payment_plan: true, first_instalment_ghs: 400, payment_status: 'partially_paid',
  paystack_reference: 'BPA-CAB-2026-ENROLL1', created_at: '2026-10-01T00:00:00Z',
}
const installmentRow = {
  id: '00000000-0000-4000-8000-0000000000a2', enrollment_id: ENR, installment_number: 2,
  amount_ghs: 350, status: 'sent', paystack_reference: 'BPA-CAB-2026-INSTAL2',
}

async function reset(session: Row = {}) {
  failRpc = false
  failAttemptLookup = false
  await pg.exec(`truncate public.workshop_payment_events, public.workshop_meta_events, public.workshop_notifications, public.workshop_status_tokens,
    public.workshop_payment_attempts, public.workshop_registrations, public.workshop_sessions,
    public.payment_events, public.payment_plan_installments, public.enrollments cascade`)
  await pg.exec('alter table public.enrollments disable trigger enrollments_seed_intermediate_payment_plan')
  await insert('enrollments', enrollment)
  await pg.exec('alter table public.enrollments enable trigger enrollments_seed_intermediate_payment_plan')
  await insert('payment_plan_installments', installmentRow)
  await insert('workshop_sessions', {
    id: SESSION, slug: 'test-webinar', kind: 'webinar', title: 'Test webinar',
    starts_at: new Date(Date.now() + 7 * 86400000).toISOString(), duration_minutes: 90,
    format: 'Online (Zoom)', price_ghs: 150, status: 'published', ...session,
  })
}

const cohortSnapshot = async () => ({
  e: (await select('select * from public.enrollments where id = $1', [ENR]))[0],
  i: await select('select * from public.payment_plan_installments order by installment_number'),
})
async function assertCohortUntouched(before: Row) {
  assertEquals(await cohortSnapshot(), before, 'cohort enrollment or installments changed')
  assertEquals(await count('select 1 from public.payment_events'), 0, 'the training ledger was written to')
}

let seq = 0
const ref = (mode: 'live' | 'test' = 'live') =>
  (mode === 'live' ? 'BPA-WEB-2026-' : 'BPA-WTEST-2026-') + String(++seq).padStart(10, '0')

async function register(email = EMAIL, opts: Row = {}): Promise<string> {
  const res = await pg.query<{ j: Row }>(
    `select public.workshop_register(p_slug => 'test-webinar', p_email => $1, p_full_name => 'Same Person',
       p_whatsapp => null, p_whatsapp_consent => false, p_terms_version => '2026-11-03',
       p_token_hash => null, p_attribution => $2::jsonb, p_ad_consent => $3) as j`,
    [email, JSON.stringify({ utm_campaign: '1200001', utm_content: 'ad-7', fbp: 'fb.1.1.1' }), opts.consent ?? true])
  assert(['created', 'existing'].includes(res.rows[0].j.outcome), JSON.stringify(res.rows[0].j))
  return res.rows[0].j.registration_id
}
async function start(regId: string, mode: 'live' | 'test' = 'live'): Promise<string> {
  const reference = ref(mode)
  const res = await pg.query<{ j: Row }>(
    `select public.workshop_start_attempt(p_registration_id => $1, p_reference => $2, p_mode => $3) as j`,
    [regId, reference, mode])
  assertEquals(res.rows[0].j.outcome, 'started', JSON.stringify(res.rows[0].j))
  return reference
}
/** An attempt whose seat hold expired long ago (created_at is immutable, so insert it aged). */
async function staleAttempt(regId: string): Promise<string> {
  const reference = ref('live')
  await insert('workshop_payment_attempts', {
    registration_id: regId, reference, amount_minor: 15000, currency: 'GHS', mode: 'live',
    created_at: new Date(Date.now() - 3 * 3600000).toISOString(),
  })
  return reference
}
const reg = async (id: string) => (await select('select * from public.workshop_registrations where id = $1', [id]))[0]
const attempt = async (r: string) => (await select('select * from public.workshop_payment_attempts where reference = $1', [r]))[0]
const lastEvent = async () => (await select('select * from public.workshop_payment_events order by received_at desc limit 1'))[0]
const count = async (sql: string, v: unknown[] = []) => (await select(`select count(*)::int as n from (${sql}) q`, v))[0].n

// --- the function under test ------------------------------------------------------------

Deno.env.set('WORKSHOP_PAYSTACK_SECRET_KEY', LIVE)
Deno.env.set('WORKSHOP_PAYSTACK_TEST_SECRET_KEY', TEST)
Deno.env.set('PAYSTACK_SECRET_KEY', TRAINING_LIVE)
Deno.env.set('PAYSTACK_TEST_SECRET_KEY', TRAINING_TEST)
Deno.env.set('PROJECT_URL', `http://127.0.0.1:${DB_PORT}`)
Deno.env.set('SERVICE_ROLE_KEY', 'service-role-for-tests')
const { handle, keysProblem } = await import('../supabase/functions/workshop-paystack-webhook/index.ts')

async function hmac(raw: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function deliver(event: Row, key: string = LIVE): Promise<Row> {
  const raw = JSON.stringify(event)
  const res = await handle(new Request('http://webhook.local/', { method: 'POST', headers: { 'x-paystack-signature': await hmac(raw, key) }, body: raw }))
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const charge = (reference: string, amount = 15000, extra: Row = {}) => ({
  event: 'charge.success',
  data: { reference, amount, currency: 'GHS', status: 'success', domain: 'live',
    paid_at: '2026-11-03T10:00:00.000Z', customer: { email: EMAIL }, ...extra },
})
const refund = (transactionReference: string, amount: number, id: number, extra: Row = {}) => ({
  event: 'refund.processed',
  data: { id, transaction_reference: transactionReference, amount, currency: 'GHS', status: 'processed',
    domain: 'live', customer: { email: EMAIL }, ...extra },
})
const opts = { sanitizeOps: false, sanitizeResources: false }


// --- isolation ---------------------------------------------------------------------------


Deno.test({ name: 'verified workshop charge confirms the registration and touches no cohort row', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id)
  const r = await deliver(charge(reference))
  assertEquals([r.status, r.outcome, r.applied], [200, 'confirmed', true])
  const g = await reg(id)
  assertEquals([g.status, g.payment_status, Number(g.amount_paid_minor)], ['confirmed', 'paid', 15000])
  assertEquals((await attempt(reference)).status, 'succeeded')
  const ev = await lastEvent()
  assertEquals([ev.matched, ev.signature_valid], [true, true])
  assertEquals((await attempt(reference)).payment_event_id, ev.id) // linked from the workshop side only
  assertEquals(await count(`select 1 from public.workshop_notifications where registration_id = $1 and kind = 'confirmation'`, [id]), 1)
  assertEquals(await count(`select 1 from public.workshop_meta_events where event_id = $1`, ['pu_' + id]), 1)
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'duplicate delivery of the same charge applies once', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id)
  await deliver(charge(reference))
  const again = await deliver(charge(reference))
  assertEquals([again.status, again.duplicate], [200, true])
  assertEquals(Number((await reg(id)).amount_paid_minor), 15000)
  assertEquals(await count(`select 1 from public.workshop_notifications where registration_id = $1`, [id]), 1)
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'retry: both references are kept; a late success on the OLD one confirms', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const first = await start(id)
  const second = await start(id)
  assert(first !== second)
  assertEquals(await count(`select 1 from public.workshop_payment_attempts where registration_id = $1`, [id]), 2)
  const r = await deliver(charge(first))
  assertEquals(r.outcome, 'confirmed')
  assertEquals((await attempt(second)).status, 'initialized') // still resolvable, never overwritten
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'second successful payment keeps access and flags the duplicate for refund review', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const first = await start(id)
  const second = await start(id)
  await deliver(charge(first))
  const r = await deliver(charge(second))
  assertEquals(r.outcome, 'duplicate_payment')
  const g = await reg(id)
  assertEquals([g.status, g.payment_status, g.review_reason, Number(g.amount_paid_minor)],
    ['confirmed', 'needs_review', 'duplicate_payment', 30000])
  assertEquals((await attempt(second)).status, 'duplicate_payment')
  assertEquals(await count(`select 1 from public.workshop_notifications where registration_id = $1 and kind = 'duplicate_payment'`, [id]), 1)
  // Only one Purchase is reported to Meta.
  assertEquals(await count(`select 1 from public.workshop_meta_events where registration_id = $1 and event_name = 'Purchase'`, [id]), 1)
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'refunding the duplicate returns the registration to paid; access never removed', ...opts, fn: async () => {
  await reset()
  const id = await register()
  const first = await start(id)
  const second = await start(id)
  await deliver(charge(first))
  await deliver(charge(second))
  const r = await deliver(refund(second, 15000, 7001))
  assertEquals(r.outcome, 'applied')
  const g = await reg(id)
  assertEquals([g.status, g.payment_status, g.review_reason, Number(g.amount_paid_minor)], ['confirmed', 'paid', null, 15000])
} })

for (const [label, extra, note] of [
  ['wrong amount', { amount: 1500 }, 'expected 15000'],
  ['wrong currency', { currency: 'NGN' }, 'NGN'],
] as const) {
  Deno.test({ name: `${label}: held for review, never confirmed, never cohort`, ...opts, fn: async () => {
    await reset()
    const before = await cohortSnapshot()
    const id = await register()
    const reference = await start(id)
    const r = await deliver(charge(reference, (extra as Row).amount ?? 15000, extra))
    assertEquals(r.outcome, 'mismatch')
    const g = await reg(id)
    assertEquals([g.status, g.payment_status, g.review_reason], ['pending_payment', 'needs_review', 'payment_mismatch'])
    assertEquals((await attempt(reference)).status, 'mismatch')
    assert(String((await lastEvent()).match_note).includes(note))
    await assertCohortUntouched(before)
  } })
}

Deno.test({ name: 'test-signed event claiming the live domain is refused', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id)
  const r = await deliver(charge(reference), TEST)
  assertEquals(r.applied, false)
  assert(/Refused/.test((await lastEvent()).match_note))
  assertEquals((await reg(id)).status, 'pending_payment')
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'test reference on a live charge is refused', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id, 'test')
  const r = await deliver(charge(reference))
  assertEquals(r.applied, false)
  assert(/Refused/.test((await lastEvent()).match_note))
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'test-mode workshop charge settles its test registration only', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id, 'test')
  const r = await deliver(charge(reference, 15000, { domain: 'test' }), TEST)
  assertEquals(r.outcome, 'confirmed')
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'unknown BPA-WEB- reference stays unmatched and never reaches email matching', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const r = await deliver(charge('BPA-WEB-2026-ZZZZZZZZZZ'))
  assertEquals([r.outcome, r.applied], ['unknown_reference', false])
  const ev = await lastEvent()
  assertEquals(ev.matched, false)
  assert(String(ev.match_note).includes('no matching payment attempt'))
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'a charge without a webinar reference is recorded only', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const r = await deliver(charge('T836219907499', 15000, { metadata: { app: 'bulletproof-training-workshops' } }))
  assertEquals(r.applied, false)
  assert(/Not a webinar reference/.test((await lastEvent()).match_note))
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'workshop charge without a customer email is still applied (and still isolated)', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id)
  const ev = charge(reference)
  delete (ev.data as Row).customer
  const r = await deliver(ev)
  assertEquals(r.outcome, 'confirmed')
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'database failure in the workshop RPC answers 503; the retry applies exactly once', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id)
  failRpc = true
  const down = await deliver(charge(reference))
  assertEquals(down.status, 503)
  assertEquals((await reg(id)).status, 'pending_payment')
  failRpc = false
  const retry = await deliver(charge(reference))
  assertEquals(retry.outcome, 'confirmed')
  assertEquals(Number((await reg(id)).amount_paid_minor), 15000)
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'late payment after the hold expired, session full: payment_received_review', ...opts, fn: async () => {
  await reset({ capacity: 1 })
  const before = await cohortSnapshot()
  const late = await register('late@example.com')
  const reference = await staleAttempt(late)
  // Somebody else takes the only seat while the late payer's hold has lapsed.
  const other = await register('other@example.com')
  await deliver(charge(await start(other)))
  const r = await deliver(charge(reference))
  assertEquals(r.outcome, 'review')
  const g = await reg(late)
  assertEquals([g.status, g.payment_status, g.review_reason], ['payment_received_review', 'paid', 'capacity'])
  assertEquals(await count(`select 1 from public.workshop_notifications where registration_id = $1 and kind = 'payment_review'`, [late]), 1)
  // Money held for review is NOT a confirmed paid enrollment: no Purchase yet.
  assertEquals(await count(`select 1 from public.workshop_meta_events where registration_id = $1 and event_name = 'Purchase'`, [late]), 0)
  // An admin admits over capacity: confirmed, and the admitted email is queued.
  const admit = await pg.query<{ j: Row }>(
    `select public.workshop_admin_action('johnathan@bulletproofautomations.com', $1, 'admit') as j`, [late])
  assertEquals(admit.rows[0].j.ok, true)
  assertEquals((await reg(late)).status, 'confirmed')
  assertEquals(await count(`select 1 from public.workshop_notifications where registration_id = $1 and kind = 'admitted'`, [late]), 1)
  // Admitted: now it is a confirmed paid enrollment, reported once at the verified amount.
  const purchases = await select(`select event_id, value_ghs from public.workshop_meta_events where registration_id = $1 and event_name = 'Purchase'`, [late])
  assertEquals(purchases.map((p) => [p.event_id, Number(p.value_ghs)]), [['pu_' + late, 150]])
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'late payment after the hold expired, seat still free: confirmed', ...opts, fn: async () => {
  await reset({ capacity: 5 })
  const id = await register()
  const r = await deliver(charge(await staleAttempt(id)))
  assertEquals(r.outcome, 'confirmed')
} })

Deno.test({ name: 'payment for a cancelled session is held for review, not confirmed', ...opts, fn: async () => {
  await reset()
  const id = await register()
  const reference = await start(id)
  await pg.query(`update public.workshop_sessions set status = 'cancelled' where id = $1`, [SESSION])
  const r = await deliver(charge(reference))
  assertEquals(r.outcome, 'review')
  assertEquals((await reg(id)).review_reason, 'session_unavailable')
  assertEquals(await count(`select 1 from public.workshop_meta_events where registration_id = $1 and event_name = 'Purchase'`, [id]), 0)
} })

Deno.test({ name: 'review then refund: refund_pending until refund.processed releases the seat', ...opts, fn: async () => {
  await reset({ capacity: 1 })
  const late = await register('late@example.com')
  const reference = await staleAttempt(late)
  await deliver(charge(await start(await register('other@example.com'))))
  await deliver(charge(reference))
  const action = await pg.query<{ j: Row }>(
    `select public.workshop_admin_action('johnathan@bulletproofautomations.com', $1, 'request_refund') as j`, [late])
  assertEquals(action.rows[0].j.ok, true)
  assertEquals((await reg(late)).status, 'refund_pending')
  await deliver(refund(reference, 15000, 7002))
  const g = await reg(late)
  assertEquals([g.status, g.payment_status, Number(g.amount_paid_minor)], ['refunded', 'refunded', 0])
} })

Deno.test({ name: 'partial workshop refund; replay does not reverse twice; cohort untouched', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id)
  await deliver(charge(reference))
  await deliver(refund(reference, 5000, 7003))
  const replay = await deliver(refund(reference, 5000, 7003))
  assertEquals(replay.duplicate, true)
  const g = await reg(id)
  assertEquals([g.status, g.payment_status, Number(g.amount_paid_minor)], ['confirmed', 'partially_refunded', 10000])
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'refund larger than received is clamped and recorded', ...opts, fn: async () => {
  await reset()
  const id = await register()
  const reference = await start(id)
  await deliver(charge(reference))
  await deliver(refund(reference, 1500000, 7004))
  assertEquals(Number((await reg(id)).amount_paid_minor), 0)
  assert(String((await lastEvent()).match_note).includes('CLAMPED'))
} })

Deno.test({ name: 'cross-product: a cohort refund never touches a workshop registration', ...opts, fn: async () => {
  await reset()
  const id = await register()
  await deliver(charge(await start(id)))
  await deliver(refund('BPA-CAB-2026-ENROLL1', 40000, 7005))
  const g = await reg(id)
  assertEquals([g.status, g.payment_status], ['confirmed', 'paid'])
} })

Deno.test({ name: 'no ad consent: payment confirms but no Meta event is queued', ...opts, fn: async () => {
  await reset()
  const id = await register(EMAIL, { consent: false })
  await deliver(charge(await start(id)))
  assertEquals(await count(`select 1 from public.workshop_meta_events where registration_id = $1`, [id]), 0)
  const g = await reg(id)
  assertEquals([g.utm_campaign, g.fbp], ['1200001', null]) // UTMs kept, Meta identifiers not
} })

// --- separation from the training business and Bulletproof Scheduling --------------------

Deno.test({ name: 'cohort and Scheduling references sent here are recorded only, never credited anywhere', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  for (const ev of [
    charge('BPA-CAB-2026-INSTAL2', 35000),                                                   // a cohort installment reference
    charge('BPA-CAB-2026-ENROLL1', 105000),                                                  // a cohort enrollment reference
    charge('BPS-LIVE-2026-APPT0001', 225000, { metadata: { app: 'bulletproof-scheduling' } }), // a Scheduling payment
    refund('BPA-CAB-2026-ENROLL1', 40000, 8801),                                              // a cohort refund
  ]) {
    const r = await deliver(ev)
    assertEquals([r.status, r.applied], [200, false])
    assert(/Not a webinar reference/.test((await lastEvent()).match_note))
  }
  await assertCohortUntouched(before)
  assertEquals(await count('select 1 from public.workshop_registrations'), 0)
} })

Deno.test({ name: 'an event signed with a TRAINING business key is rejected as unsigned', ...opts, fn: async () => {
  await reset()
  const before = await cohortSnapshot()
  const id = await register()
  const reference = await start(id)
  const r = await deliver(charge(reference), TRAINING_LIVE)
  assertEquals([r.status, r.applied, r.signature_valid], [200, false, false])
  assertEquals((await reg(id)).status, 'pending_payment')
  await assertCohortUntouched(before)
} })

Deno.test({ name: 'key guard: the webhook refuses to run with a training key or a wrong key type', ...opts, fn: () => {
  assertEquals(keysProblem(LIVE, TEST, [TRAINING_LIVE, TRAINING_TEST]), null)
  assert(keysProblem(TRAINING_LIVE, TEST, [TRAINING_LIVE, TRAINING_TEST])!.includes('not a separate Paystack business'))
  assert(keysProblem(LIVE, TRAINING_TEST, [TRAINING_LIVE, TRAINING_TEST])!.includes('not a separate Paystack business'))
  assert(keysProblem(TEST, '', [])!.includes('not a live secret key'))
  assert(keysProblem('', '', [])!.includes('no webinar Paystack key'))
} })
