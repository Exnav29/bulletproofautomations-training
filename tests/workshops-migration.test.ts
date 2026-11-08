/**
 * The workshop migration on production's ledger schema (PGlite): up, down, up again,
 * plus the RPCs the webhook suite does not reach — registration, capacity holds,
 * status tokens, the outbox claims, attempt immutability and admin actions.
 *
 *   deno test --node-modules-dir=none --allow-read tests/workshops-migration.test.ts
 */
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { PGlite } from 'npm:@electric-sql/pglite@0.3.14'

type Row = Record<string, any>
const read = (f: string) => Deno.readTextFile(new URL(f, import.meta.url))
const UP = await read('../supabase/migrations/20261103120000_workshops.sql')
const DOWN = await read('../supabase/migrations/rollback/20261103120000_workshops_down.sql')

const pg = new PGlite()
await pg.exec(await read('./fixtures/payment-ledger.sql'))
await pg.exec(await read('./fixtures/supabase-stubs.sql'))

const q = async (sql: string, v: unknown[] = []) => (await pg.query<Row>(sql, v)).rows
const j = async (sql: string, v: unknown[] = []): Promise<any> => (await pg.query<{ j: any }>(`select ${sql} as j`, v)).rows[0].j
const ADMIN = 'johnathan@bulletproofautomations.com'
const hash = (n: number) => n.toString(16).padStart(64, '0')

async function session(over: Row = {}) {
  await pg.exec(`truncate public.workshop_meta_events, public.workshop_notifications, public.workshop_status_tokens,
    public.workshop_payment_attempts, public.workshop_registrations, public.workshop_sessions cascade`)
  const cols = { slug: 'test-session', kind: 'webinar', title: 'Test session', duration_minutes: 60,
    format: 'Online', price_ghs: 150, status: 'published',
    starts_at: new Date(Date.now() + 86400000).toISOString(), ...over }
  const keys = Object.keys(cols)
  await pg.query(`insert into public.workshop_sessions (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
    keys.map((k) => (cols as Row)[k]))
}
const register = (email: string, token: string | null = null, extra = '') =>
  j(`public.workshop_register(p_slug => 'test-session', p_email => $1, p_full_name => 'Test Person',
      p_whatsapp => null, p_whatsapp_consent => false, p_terms_version => '2026-11-03', p_token_hash => $2${extra})`,
    [email, token])
const start = (id: string, ref: string) =>
  j(`public.workshop_start_attempt(p_registration_id => $1, p_reference => $2, p_mode => 'live')`, [id, ref])

Deno.test('up, down, up: the migration is reversible and leaves the ledger intact', async () => {
  const ledgerBefore = (await q(`select column_name from information_schema.columns where table_name = 'payment_events' order by ordinal_position`)).map((r) => r.column_name).join(',')
  await pg.exec(UP)
  const ledgerDuring = (await q(`select column_name from information_schema.columns where table_name = 'payment_events' order by ordinal_position`)).map((r) => r.column_name).join(',')
  assertEquals(ledgerDuring, ledgerBefore, 'migration must not alter payment_events')
  await pg.exec(DOWN)
  const left = await q(`select table_name from information_schema.tables where table_name like 'workshop%'`)
  assertEquals(left.length, 0)
  // The shared ledger's schema is identical before, during and after: the migration never alters it.
  const cols = async () => (await q(`select column_name from information_schema.columns where table_name = 'payment_events' order by ordinal_position`)).map((r) => r.column_name).join(',')
  assertEquals(await cols(), ledgerBefore)
  await pg.exec(UP)
  assertEquals((await q(`select count(*)::int n from information_schema.tables where table_name like 'workshop%'`))[0].n, 8)
})

Deno.test('free session: registration is confirmed at once and a confirmation is queued', async () => {
  await session({ price_ghs: 0 })
  const r = await register('free@example.com', hash(1))
  assertEquals([r.outcome, r.status, r.payment_status], ['created', 'confirmed', 'not_required'])
  assertEquals((await q(`select kind from public.workshop_notifications`)).map((x) => x.kind), ['confirmation'])
})

Deno.test('same email twice: one registration; email is normalised; a second device gets its own token', async () => {
  await session()
  const a = await register('Someone@Example.com ', hash(2))
  const b = await register('someone@example.com', hash(3))
  assertEquals([a.outcome, b.outcome, a.registration_id], ['created', 'existing', b.registration_id])
  assertEquals((await q(`select count(*)::int n from public.workshop_status_tokens`))[0].n, 2)
})

Deno.test('stale page: a displayed price that disagrees with the database registers nobody', async () => {
  await session()
  const r = await register('stale@example.com', null, ', p_displayed_price => 100')
  assertEquals(r.outcome, 'stale_page')
  assertEquals((await q(`select count(*)::int n from public.workshop_registrations`))[0].n, 0)
})

Deno.test('capacity: confirmed seats and live checkout holds both count; no waitlist row is created', async () => {
  await session({ capacity: 1 })
  const a = await register('a@example.com')
  assertEquals((await start(a.registration_id, 'BPA-WEB-2026-AAAAAAAAAA')).outcome, 'started')
  // a's checkout is holding the only seat
  const b = await register('b@example.com')
  assertEquals(b.outcome, 'full')
  assertEquals((await q(`select count(*)::int n from public.workshop_registrations`))[0].n, 1)
})

Deno.test('closed, draft and past sessions do not take registrations', async () => {
  await session({ status: 'closed' })
  assertEquals((await register('c@example.com')).outcome, 'closed')
  await session({ status: 'draft' })
  assertEquals((await register('c@example.com')).outcome, 'not_found')
  await session({ starts_at: new Date(Date.now() - 3600000).toISOString() })
  assertEquals((await register('c@example.com')).outcome, 'closed')
})

Deno.test('attempts: amount comes from the session; identity is immutable; rows cannot be deleted', async () => {
  await session({ price_ghs: 275.5 })
  const r = await register('i@example.com')
  const s = await start(r.registration_id, 'BPA-WEB-2026-BBBBBBBBBB')
  assertEquals(Number(s.amount_minor), 27550)
  for (const sql of [
    `update public.workshop_payment_attempts set amount_minor = 1`,
    `update public.workshop_payment_attempts set reference = 'BPA-WEB-2026-CCCCCCCCCC'`,
    `delete from public.workshop_payment_attempts`,
  ]) {
    let refused = false
    try { await pg.exec(sql) } catch (_) { refused = true }
    assert(refused, sql)
  }
  // A malformed or mode-inconsistent reference is refused by the table itself.
  let bad = false
  try { await start(r.registration_id, 'BPA-WTEST-2026-DDDDDDDDDD') } catch (_) { bad = true }
  assert(bad, 'test reference recorded as live')
})

Deno.test('status token: reveals state and session only; wrong token and wrong reference look identical', async () => {
  await session()
  const r = await register('t@example.com', hash(9))
  await start(r.registration_id, 'BPA-WEB-2026-EEEEEEEEEE')
  const good = await j(`public.workshop_status_for_token($1, $2)`, [hash(9), 'BPA-WEB-2026-EEEEEEEEEE'])
  assertEquals([good.state, good.status, good.session.slug], ['known', 'pending_payment', 'test-session'])
  assertEquals(good.email_sent, false) // nothing delivered yet, so the page must not say it was
  const text = JSON.stringify(good)
  assert(!text.includes('t@example.com') && !text.includes('Test Person'), 'PII leaked')
  const wrongToken = await j(`public.workshop_status_for_token($1, $2)`, [hash(10), 'BPA-WEB-2026-EEEEEEEEEE'])
  const wrongRef = await j(`public.workshop_status_for_token($1, $2)`, [hash(9), 'BPA-WEB-2026-FFFFFFFFFF'])
  assertEquals(wrongToken, { state: 'unknown' })
  assertEquals(wrongRef, { state: 'unknown' })
})

Deno.test('verify throttle: one claim per reference per 10 seconds', async () => {
  await session()
  const r = await register('v@example.com')
  await start(r.registration_id, 'BPA-WEB-2026-GGGGGGGGGG')
  assertEquals(await j(`public.workshop_claim_verify('BPA-WEB-2026-GGGGGGGGGG')`), true)
  assertEquals(await j(`public.workshop_claim_verify('BPA-WEB-2026-GGGGGGGGGG')`), false)
})

Deno.test('notification outbox: a claimed row is not claimed twice; failures retry, then stop at 5', async () => {
  await session({ price_ghs: 0 })
  await register('n@example.com')
  const first = await q(`select * from public.workshop_claim_notifications(10)`)
  const second = await q(`select * from public.workshop_claim_notifications(10)`)
  assertEquals([first.length, second.length], [1, 0])
  await q(`select public.workshop_finish_notification($1, false, 'mail down')`, [first[0].id])
  assertEquals((await q(`select status from public.workshop_notifications`))[0].status, 'queued')
  for (let i = 0; i < 4; i++) {
    const c = await q(`select * from public.workshop_claim_notifications(10)`)
    await q(`select public.workshop_finish_notification($1, false, 'mail down')`, [c[0].id])
  }
  assertEquals((await q(`select status, attempts from public.workshop_notifications`))[0], { status: 'failed', attempts: 5 })
})

Deno.test('Meta outbox: queued only with consent; Meta identifiers dropped without it', async () => {
  await session({ price_ghs: 0 })
  await register('noconsent@example.com', null, `, p_attribution => '{"fbp":"fb.1.1"}'::jsonb, p_ad_consent => false`)
  await register('consent@example.com', null,
    `, p_attribution => '{"fbp":"fb.1.2","client_ip":"203.0.113.9","client_user_agent":"UA"}'::jsonb, p_ad_consent => true`)
  const events = await q(`select event_name from public.workshop_meta_events`)
  assertEquals(events.map((e) => e.event_name), ['CompleteRegistration'])
  const leaked = await q(`select fbp from public.workshop_registrations where email_normalized = 'noconsent@example.com'`)
  assertEquals(leaked[0].fbp, null)
})

Deno.test('admin actions: allowlisted actor only; cancel refused while money is held', async () => {
  await session()
  const r = await register('adm@example.com')
  let refused = false
  try { await j(`public.workshop_admin_action('someone@else.com', $1, 'cancel')`, [r.registration_id]) } catch (_) { refused = true }
  assert(refused)
  assertEquals((await j(`public.workshop_admin_action($1, $2, 'attendance', 'attended')`, [ADMIN, r.registration_id])).ok, true)
  assertEquals((await j(`public.workshop_admin_action($1, $2, 'admit')`, [ADMIN, r.registration_id])).error, 'not_in_review')
  assertEquals((await j(`public.workshop_admin_action($1, $2, 'cancel')`, [ADMIN, r.registration_id])).ok, true)
})

Deno.test('privileges: anon and authenticated cannot execute RPCs or read tokens', async () => {
  const rpc = await q(`select has_function_privilege('anon', 'public.workshop_apply_charge(text,bigint,text,text,timestamptz,text,uuid)', 'execute') a,
                              has_function_privilege('authenticated', 'public.workshop_register(text,text,text,text,boolean,text,text,jsonb,boolean,numeric,timestamptz)', 'execute') b,
                              has_table_privilege('authenticated', 'public.workshop_status_tokens', 'select') c,
                              has_table_privilege('anon', 'public.workshop_registrations', 'select') d,
                              has_table_privilege('authenticated', 'public.workshop_registrations', 'update') e`)
  assertEquals(rpc[0], { a: false, b: false, c: false, d: false, e: false })
})

Deno.test('admission migration: additive, reversible, and closed to anon and authenticated', async () => {
  const ADM_UP = await read('../supabase/migrations/20261108120000_workshop_admission.sql')
  const ADM_DOWN = await read('../supabase/migrations/rollback/20261108120000_workshop_admission_down.sql')
  const cols = async (t: string) => (await q(`select column_name from information_schema.columns where table_name = $1 order by ordinal_position`, [t])).map((r) => r.column_name).join(',')
  const before = { s: await cols('workshop_sessions'), r: await cols('workshop_registrations'), p: await cols('payment_events') }
  await pg.exec(ADM_UP)
  await pg.exec(ADM_UP) // idempotent
  assert((await cols('workshop_sessions')).endsWith(',admission,calendar_event_id'))
  assert((await cols('workshop_registrations')).endsWith(',attend_email,invited_email,invited_at,invite_removed_at'))
  assertEquals(await cols('payment_events'), before.p, 'the shared ledger is untouched')
  for (const fn of ['public.workshop_set_attend_email(uuid,text)', 'public.workshop_admin_admission(text,uuid,text,text)']) {
    for (const role of ['anon', 'authenticated']) {
      assertEquals((await q(`select has_function_privilege($1, $2, 'execute') ok`, [role, fn]))[0].ok, false, role + ' ' + fn)
    }
  }
  // Existing sessions default to emailed joining details.
  await session()
  assertEquals((await q(`select admission from public.workshop_sessions`))[0].admission, 'link')
  await pg.exec(ADM_DOWN)
  assertEquals([await cols('workshop_sessions'), await cols('workshop_registrations')], [before.s, before.r])
  await pg.exec(ADM_UP)
})
