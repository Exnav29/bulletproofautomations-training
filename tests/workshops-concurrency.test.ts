/**
 * Concurrency and event ordering for webinars and workshops, on a REAL PostgreSQL
 * server (not PGlite). Every case that involves two dispatchers, two webhook
 * deliveries or a delivery racing a charge uses independent connections, so the
 * row locks, SKIP LOCKED and READ COMMITTED re-reads are PostgreSQL's own.
 *
 * Regressions for the Codex audit of 9 November 2026 (commit 78a707b):
 *   1  concurrent duplicate refund application
 *   2  a refund event arriving before its charge
 *   3  waitlist checkout holds extending beyond their deadline
 *   5  concurrent waitlist emails invalidating registration links
 *   6  overlapping Google Calendar runs leaving an unauthorized guest
 *
 * Each test runs in its own database, cloned from a template loaded with the
 * production ledger fixtures and every workshop migration in order.
 *
 *   WORKSHOP_PG_URL=postgres://postgres:<pw>@localhost:5432/postgres \
 *   deno test --node-modules-dir=none --allow-net --allow-read --allow-env tests/workshops-concurrency.test.ts
 */
import postgres from 'npm:postgres@3.4.5'
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'

const BASE = Deno.env.get('WORKSHOP_PG_URL')
if (!BASE) throw new Error('WORKSHOP_PG_URL is required: this suite needs a real PostgreSQL server, not PGlite')
const dbUrl = (name: string) => { const u = new URL(BASE); u.pathname = '/' + name; return u.href }
type Sql = ReturnType<typeof postgres>
const quiet = { onnotice: () => {} }

// Every workshop migration, in order: release 1 onwards.
const migrations = [...Deno.readDirSync(new URL('../supabase/migrations/', import.meta.url))]
  .map((e) => e.name).filter((n) => n.endsWith('.sql') && n >= '20261103120000').sort()
const files = ['./fixtures/payment-ledger.sql', './fixtures/supabase-stubs.sql', './fixtures/graduate-records.sql',
  ...migrations.map((m) => '../supabase/migrations/' + m)]

const admin = postgres(BASE, { max: 1, ...quiet })
const TPL = 'workshop_concurrency_tpl'
await admin.unsafe(`drop database if exists ${TPL} with (force)`)
await admin.unsafe(`create database ${TPL}`)
{
  const t = postgres(dbUrl(TPL), { max: 1, ...quiet })
  for (const f of files) await t.unsafe(await Deno.readTextFile(new URL(f, import.meta.url)))
  await t.end()
}
const opened: Sql[] = []
let seq = 0
async function fresh(): Promise<Sql> {
  const name = `wc_${Date.now()}_${seq++}`
  await admin.unsafe(`create database ${name} template ${TPL}`)
  const sql = postgres(dbUrl(name), { max: 6, ...quiet })
  opened.push(sql)
  return sql
}
const opts = { sanitizeOps: false, sanitizeResources: false }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const hash = (n: number) => n.toString(16).padStart(64, '0')
const ref = (n: number) => 'BPA-WTEST-2026-' + String(n).padStart(10, '0')

/**
 * Two independent sessions racing. `first` runs inside a transaction that stays open
 * (holding its row locks) until `second` has started; `second` runs on another
 * connection. Returns whether `second` was actually blocked by `first`. The open
 * transaction is always released, so a failed expectation can never hang the suite.
 */
async function race(sql: Sql, first: (tx: Sql) => Promise<unknown>, second: () => Promise<unknown>, fn: string) {
  let held = false
  let failed: unknown = null
  let release!: () => void
  const gate = new Promise<void>((g) => (release = g))
  const a = sql.begin(async (tx) => {
    try { await first(tx as unknown as Sql) } catch (err) { failed = err; throw err } finally { held = true }
    await gate
  })
  try {
    for (let i = 0; !held && i < 400; i++) await delay(10)
    if (failed) throw failed
    const b = Promise.resolve(second()) // postgres.js queries are lazy: start it now
    const blocked = await waitBlocked(sql, fn)
    release()
    await Promise.all([a, b])
    return blocked
  } finally { release() }
}

/** Waits until some backend in this database is blocked on a row lock running `fn`. */
async function waitBlocked(sql: Sql, fn: string) {
  for (let i = 0; i < 200; i++) {
    const r = await sql`select count(*)::int n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query ilike ${'%' + fn + '%'}`
    if (r[0].n > 0) return true
    await delay(25)
  }
  return false
}

/** Moves an attempt back in time: every timestamp it carries, triggers off (attempts are immutable). */
async function age(sql: Sql, reference: string, minutes: number) {
  const hasHold = (await sql`select count(*)::int n from information_schema.columns
    where table_name = 'workshop_payment_attempts' and column_name = 'hold_until'`)[0].n > 0
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`
    await tx`update public.workshop_payment_attempts set created_at = created_at - make_interval(mins => ${minutes})
      where reference = ${reference}`
    if (hasHold) {
      await tx.unsafe(`update public.workshop_payment_attempts set hold_until = hold_until - make_interval(mins => ${minutes})
        where reference = $1 and hold_until is not null`, [reference])
    }
  })
}

async function session(sql: Sql, over: Record<string, unknown> = {}) {
  const row = { slug: 'race-session', kind: 'workshop', title: 'Race session', duration_minutes: 90, format: 'Online, live',
    price_ghs: 350, status: 'published', is_test: true, capacity: 25, starts_at: new Date(Date.now() + 20 * 86400000), ...over }
  const [s] = await sql`insert into public.workshop_sessions ${sql(row)} returning id`
  return s.id as string
}
async function register(sql: Sql, email: string, attribution: Record<string, unknown> = {}) {
  const [r] = await sql`select public.workshop_register(p_slug => 'race-session', p_email => ${email}, p_full_name => 'Race Person',
    p_whatsapp => null, p_whatsapp_consent => false, p_terms_version => '2026-11-09', p_token_hash => ${null},
    p_attribution => ${sql.json({ deployment_mode: 'test', ...attribution })}) as j`
  return r.j as Record<string, any>
}
async function start(sql: Sql, registrationId: string, reference: string) {
  const [r] = await sql`select public.workshop_start_attempt(${registrationId}, ${reference}, 'test') as j`
  return r.j as Record<string, any>
}
async function charge(sql: Sql, reference: string, eventId: string | null = null, amount = 35000) {
  const [r] = await sql`select public.workshop_apply_charge(p_reference => ${reference}, p_amount_minor => ${amount},
    p_currency => 'GHS', p_domain => 'test', p_paid_at => now(), p_via => 'webhook', p_payment_event_id => ${eventId}) as j`
  return r.j as Record<string, any>
}
/** The row the webhook logs before calling the RPC, keyed per refund as the webhook keys it. */
async function refundEvent(sql: Sql, reference: string, refundId: string, amount: number) {
  const [e] = await sql`insert into public.workshop_payment_events (event, reference, amount_minor, currency, status, domain, signature_valid, raw)
    values ('refund.processed', ${reference + ':refund:' + refundId}, ${amount}, 'GHS', 'processed', 'test', true, '{}') returning id`
  return e.id as string
}
async function chargeEvent(sql: Sql, reference: string, amount = 35000) {
  const [e] = await sql`insert into public.workshop_payment_events (event, reference, amount_minor, currency, status, domain, signature_valid, raw)
    values ('charge.success', ${reference}, ${amount}, 'GHS', 'success', 'test', true, '{}') returning id`
  return e.id as string
}
const refundCall = (sql: Sql, reference: string, amount: number, eventId: string) =>
  sql`select public.workshop_apply_refund(${reference}, ${amount}, 'test', ${eventId}) as j`
const attempt = async (sql: Sql, reference: string) =>
  (await sql`select status, received_minor::int, refunded_minor::int from public.workshop_payment_attempts where reference = ${reference}`)[0]
const registration = async (sql: Sql, id: string) =>
  (await sql`select status, payment_status, amount_paid_minor::int from public.workshop_registrations where id = ${id}`)[0]
const event = async (sql: Sql, id: string) =>
  (await sql`select matched, match_note from public.workshop_payment_events where id = ${id}`)[0]

async function paidRegistration(sql: Sql, email = 'paid@example.com', n = 1) {
  const r = await register(sql, email)
  assertEquals((await start(sql, r.registration_id, ref(n))).outcome, 'started')
  assertEquals((await charge(sql, ref(n), await chargeEvent(sql, ref(n)))).outcome, 'confirmed')
  return r.registration_id as string
}

// --- 1. Concurrent duplicate refund application ------------------------------------------

Deno.test('1: the same refund delivered twice at once is applied once', opts, async () => {
  const sql = await fresh()
  await session(sql)
  await paidRegistration(sql)
  // Paystack delivers one partial refund twice. Both deliveries pass the webhook's
  // duplicate check, because neither has committed when the other reads the ledger.
  const ev = await refundEvent(sql, ref(1), '7001', 10000)
  const blocked = await race(sql, (tx) => refundCall(tx, ref(1), 10000, ev), () => refundCall(sql, ref(1), 10000, ev), 'workshop_apply_refund')
  assert(blocked, 'the two deliveries really overlapped')
  assertEquals((await attempt(sql, ref(1))).refunded_minor, 10000, 'GHS 100 refunded once, never twice')
  assertEquals((await event(sql, ev)).matched, true)
})

Deno.test('1: two different partial refunds at once are both applied', opts, async () => {
  const sql = await fresh()
  await session(sql)
  await paidRegistration(sql)
  const e1 = await refundEvent(sql, ref(1), '7001', 10000)
  const e2 = await refundEvent(sql, ref(1), '7002', 5000)
  await Promise.all([refundCall(sql, ref(1), 10000, e1), refundCall(sql, ref(1), 5000, e2)])
  assertEquals((await attempt(sql, ref(1))).refunded_minor, 15000)
})

// --- 2. Refund before its charge ---------------------------------------------------------

Deno.test('2: a refund that arrives before its charge is applied when the charge lands', opts, async () => {
  const sql = await fresh()
  await session(sql)
  const r = await register(sql, 'early@example.com')
  await start(sql, r.registration_id, ref(1))
  const ev = await refundEvent(sql, ref(1), '8001', 35000)
  const early = (await refundCall(sql, ref(1), 35000, ev))[0].j
  assert(early.outcome !== 'applied', 'nothing to reverse yet')
  assertEquals((await event(sql, ev)).matched, false, 'held, not marked done, so it is not lost')
  await charge(sql, ref(1), await chargeEvent(sql, ref(1)))
  assertEquals((await attempt(sql, ref(1))).refunded_minor, 35000)
  const reg = await registration(sql, r.registration_id)
  assertEquals([reg.status, reg.payment_status], ['refunded', 'refunded'], 'a refunded payment never holds a confirmed place')
  assertEquals((await event(sql, ev)).matched, true)
  assertEquals((await sql`select count(*)::int n from public.workshop_meta_events where event_name = 'Purchase'`)[0].n, 0,
    'no Purchase is reported for money already given back')
})

Deno.test('2: a charge applied by the verify path (no webhook event) also picks up the early refund', opts, async () => {
  const sql = await fresh()
  await session(sql)
  const r = await register(sql, 'verify@example.com')
  await start(sql, r.registration_id, ref(1))
  const ev = await refundEvent(sql, ref(1), '8002', 10000)
  await refundCall(sql, ref(1), 10000, ev)
  await charge(sql, ref(1), null)
  assertEquals((await attempt(sql, ref(1))).refunded_minor, 10000)
  assertEquals((await registration(sql, r.registration_id)).payment_status, 'partially_refunded')
})

Deno.test('2: a refund racing its charge on two connections is applied exactly once, whichever commits first', opts, async () => {
  for (const chargeFirst of [true, false]) {
    const sql = await fresh()
    await session(sql)
    const r = await register(sql, 'race@example.com')
    await start(sql, r.registration_id, ref(1))
    const ce = await chargeEvent(sql, ref(1))
    const re = await refundEvent(sql, ref(1), '8003', 35000)
    const blocked = chargeFirst
      ? await race(sql, (tx) => charge(tx, ref(1), ce), () => refundCall(sql, ref(1), 35000, re), 'workshop_apply_refund')
      : await race(sql, (tx) => refundCall(tx, ref(1), 35000, re), () => charge(sql, ref(1), ce), 'workshop_apply_charge')
    assert(blocked, 'the refund and the charge really overlapped (charge first: ' + chargeFirst + ')')
    assertEquals((await attempt(sql, ref(1))).refunded_minor, 35000, 'charge first: ' + chargeFirst)
    assertEquals((await registration(sql, r.registration_id)).status, 'refunded', 'charge first: ' + chargeFirst)
  }
})

// --- 3. Checkout holds stay inside their deadline ----------------------------------------

Deno.test('3: restarting checkout does not extend a lapsed waitlist offer past its hold', opts, async () => {
  const sql = await fresh()
  const sid = await session(sql, { capacity: 1 })
  await sql`insert into public.workshop_waitlist (session_id, email_normalized, full_name, status, offer_token_hash, offered_at, offer_expires_at)
    values (${sid}, 'w1@example.com', 'First Waiting', 'offered', ${hash(1)}, now(), now() + interval '1 hour')`
  await sql`insert into public.workshop_waitlist (session_id, email_normalized, full_name, status, created_at)
    values (${sid}, 'w2@example.com', 'Second Waiting', 'waiting', now() + interval '1 second')`
  const r1 = await register(sql, 'w1@example.com', { offer_token_hash: hash(1) })
  assertEquals(r1.outcome, 'created')
  assertEquals((await start(sql, r1.registration_id, ref(1))).outcome, 'started')
  // The offer lapses with that checkout under way; 25 minutes into its 30-minute hold
  // the person restarts checkout, which is allowed: it is their place until the hold ends.
  await sql`update public.workshop_waitlist set offer_expires_at = now() - interval '1 minute' where email_normalized = 'w1@example.com'`
  await age(sql, ref(1), 25)
  assertEquals((await start(sql, r1.registration_id, ref(2))).outcome, 'started')
  // Six minutes later the first hold has ended. The restart must not have renewed it.
  await age(sql, ref(1), 6); await age(sql, ref(2), 6)
  assertEquals((await sql`select public.workshop_payment_in_flight(${r1.registration_id}) as v`)[0].v, false)
  assertEquals((await sql`select public.workshop_seats_in_use(${sid}) as v`)[0].v, 0, 'the place is free for the next person')
  // A payment that lands now is held for review, never confirmed ahead of w2.
  const late = await charge(sql, ref(2))
  assertEquals([late.outcome, late.review_reason], ['review', 'capacity'])
})

Deno.test('3: chaining checkouts cannot hold an ordinary place beyond one hold', opts, async () => {
  const sql = await fresh()
  await session(sql, { capacity: 1 })
  const a = await register(sql, 'a@example.com')
  const b = await register(sql, 'b@example.com')
  assertEquals((await start(sql, a.registration_id, ref(1))).outcome, 'started')
  assertEquals((await start(sql, b.registration_id, ref(9))).outcome, 'full', 'a holds the only place')
  await age(sql, ref(1), 25)
  assertEquals((await start(sql, a.registration_id, ref(2))).outcome, 'started', 'a may retry inside its hold')
  await age(sql, ref(1), 6); await age(sql, ref(2), 6)
  assertEquals((await start(sql, b.registration_id, ref(10))).outcome, 'started', "a's hold ended 30 minutes after it began")
})

Deno.test('3: a retry inside the hold keeps the place, as before', opts, async () => {
  const sql = await fresh()
  await session(sql, { capacity: 1 })
  const a = await register(sql, 'a@example.com')
  const b = await register(sql, 'b@example.com')
  await start(sql, a.registration_id, ref(1))
  await age(sql, ref(1), 10)
  await start(sql, a.registration_id, ref(2))
  assertEquals((await start(sql, b.registration_id, ref(3))).outcome, 'full')
  assertEquals((await charge(sql, ref(2))).outcome, 'confirmed')
})

// --- 5. Waitlist emails: one dispatcher per row ------------------------------------------

async function offeredEntry(sql: Sql) {
  const sid = await session(sql, { capacity: 1 })
  await sql`insert into public.workshop_waitlist (session_id, email_normalized, full_name, status, offered_at, offer_expires_at, joined_email_at)
    values (${sid}, 'w1@example.com', 'First Waiting', 'offered', now(), now() + interval '24 hours', now())`
  return sid
}
const due = (sql: Sql) => sql`select id, kind from public.workshop_waitlist_mail_due(true, 10)`

Deno.test('5: two overlapping dispatcher runs never both send the same offer', opts, async () => {
  const sql = await fresh()
  await offeredEntry(sql)
  const runA = await due(sql)
  assertEquals(runA.map((r) => r.kind), ['offer'])
  // Run B starts while A is still sending (each RPC commits on its own).
  const runB = await due(sql)
  assertEquals(runB.length, 0, 'the row belongs to run A until it reports back')
  // A mints the link it emails. Nothing can replace it.
  await sql`select public.workshop_waitlist_set_token(${runA[0].id}, ${hash(11)})`
  await sql`select public.workshop_waitlist_mail_done(${runA[0].id}, 'offer', true, null)`
  assertEquals((await sql`select offer_token_hash from public.workshop_waitlist`)[0].offer_token_hash, hash(11))
  assertEquals((await sql`select count(*)::int n from public.workshop_waitlist_offer(${hash(11)})`)[0].n, 1, 'the emailed link works')
  assertEquals((await due(sql)).length, 0)
})

Deno.test('5: SKIP LOCKED: a run inside another run\'s claim transaction gets nothing', opts, async () => {
  const sql = await fresh()
  await offeredEntry(sql)
  let a: unknown[] = [], b: unknown[] = []
  // Run A's claim is still uncommitted; run B must neither wait for it nor take the row.
  await race(sql, async (tx) => { a = await due(tx) }, async () => { b = await due(sql) }, 'workshop_waitlist_mail_due')
  assertEquals([a.length, b.length], [1, 0])
})

Deno.test('5: a failed send releases the row for the next run', opts, async () => {
  const sql = await fresh()
  await offeredEntry(sql)
  const [row] = await due(sql)
  await sql`select public.workshop_waitlist_mail_done(${row.id}, 'offer', false, 'mail-503')`
  assertEquals((await due(sql)).map((r) => r.kind), ['offer'])
})

// --- 6. Google Calendar: one run per registration ----------------------------------------

async function invitedSessionWithPaidRegistration(sql: Sql) {
  await session(sql, { admission: 'invite', calendar_event_id: 'raceevent123' })
  const id = await paidRegistration(sql, 'payer@example.com')
  await sql`select public.workshop_set_attend_email(${id}, 'first.account@example.com')`
  return id
}
const plan = (sql: Sql) => sql`select registration_id, add_email, remove_email from public.workshop_calendar_plan(true, 10)`
const record = (sql: Sql, id: string, added: string | null, removed: string | null) =>
  sql`select public.workshop_calendar_record(${id}, true, ${added}, ${removed}, null, false)`

Deno.test('6: overlapping calendar runs cannot leave an account on the event that nothing will remove', opts, async () => {
  const sql = await fresh()
  const id = await invitedSessionWithPaidRegistration(sql)
  const guests = new Set<string>() // the event's guest list, as Google would hold it
  // Run A plans to add the first account, then works on Google.
  const a = await plan(sql)
  assertEquals(a.map((r) => r.add_email), ['first.account@example.com'])
  // Meanwhile the admin records an approved change of account.
  await sql`update public.workshop_registrations set attend_email = 'second.account@example.com' where id = ${id}`
  // Run B starts before A has reported back.
  const b = await plan(sql)
  // A finishes: the first account is on the event, and recorded.
  guests.add('first.account@example.com'); await record(sql, id, 'first.account@example.com', null)
  // B, if it was given the row, adds the second account and records it over A's record.
  for (const row of b) { if (row.add_email) guests.add(row.add_email); await record(sql, id, row.add_email, row.remove_email) }
  // Later runs bring the event in step with the record until nothing is left to do.
  for (let i = 0; i < 3; i++) {
    for (const row of await plan(sql)) {
      if (row.remove_email) guests.delete(row.remove_email)
      if (row.add_email) guests.add(row.add_email)
      await record(sql, id, row.add_email, row.remove_email)
    }
  }
  assertEquals([...guests], ['second.account@example.com'], 'only the account the registration now names is invited')
})

Deno.test('6: a registration being synced is not handed to a second run', opts, async () => {
  const sql = await fresh()
  const id = await invitedSessionWithPaidRegistration(sql)
  assertEquals((await plan(sql)).length, 1)
  assertEquals((await plan(sql)).length, 0, 'claimed by the first run')
  // A run that records a failure releases it for the next run.
  await sql`select public.workshop_calendar_record(${id}, false, null, null, 'Google 503', false)`
  assertEquals((await plan(sql)).length, 1)
})

Deno.test({ name: 'teardown', ...opts, fn: async () => {
  for (const s of opened) await s.end({ timeout: 2 })
  await admin.end({ timeout: 2 })
} })
