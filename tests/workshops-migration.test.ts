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
await pg.exec(await read('./fixtures/graduate-records.sql'))

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

Deno.test('release 2 (admission + benefits): additive, idempotent, reversible to the exact original functions, closed to anon', async () => {
  const UP2 = await read('../supabase/migrations/20261109120000_workshop_admission_benefits.sql')
  const DOWN2 = await read('../supabase/migrations/rollback/20261109120000_workshop_admission_benefits_down.sql')
  const cols = async (t: string) => (await q(`select column_name from information_schema.columns where table_name = $1 order by ordinal_position`, [t])).map((r) => r.column_name).join(',')
  // Compared without line endings: a Windows checkout loads CRLF files, CI loads LF.
  const body = async (fn: string) => String((await q(`select prosrc from pg_proc where proname = $1`, [fn]))[0].prosrc).replace(/\r\n/g, '\n')
  const before = {
    s: await cols('workshop_sessions'), r: await cols('workshop_registrations'), p: await cols('payment_events'),
    e: await cols('enrollments'), c: await cols('credentials'),
    reg: await body('workshop_register'), start: await body('workshop_start_attempt'), seats: await body('workshop_seats_in_use'),
  }
  // Existing sessions are classified from their own payments. As production stands: a session with
  // only test checkouts (test-webinar-checkout), and one with none (workshop 01, a draft).
  const seed = async (both: boolean) => {
    await pg.exec(`truncate public.workshop_payment_attempts, public.workshop_registrations, public.workshop_sessions cascade`)
    for (const [slug, modes] of [['only-test', ['test']], ['only-live', ['live']], ['no-payments', []], ...(both ? [['both-modes', ['test', 'live']]] : [])] as [string, string[]][]) {
      const s = (await q(`insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs)
        values ($1, 'workshop', 'Seeded', now() + interval '9 days', 60, 'Online', 10) returning id`, [slug]))[0].id
      let n = 0
      for (const mode of modes) {
        const r = (await q(`insert into public.workshop_registrations (session_id, email_normalized, full_name, terms_ack, terms_version)
          values ($1, $2, 'Seeded', true, '2026-11-03') returning id`, [s, slug + (++n) + '@example.com']))[0].id
        await q(`insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, mode) values ($1, $2, 1000, $3)`,
          [r, (mode === 'live' ? 'BPA-WEB-2026-' : 'BPA-WTEST-2026-') + (slug.replace(/-/g, '').toUpperCase() + 'XXXXXXXXXX').slice(0, 9) + n, mode])
      }
    }
  }
  // A session with both kinds cannot be classified: the migration stops, and (applied in one
  // transaction, as Supabase applies migrations) leaves nothing behind.
  await seed(true)
  let stopped = ''
  try { await pg.exec('begin;\n' + UP2 + '\ncommit;') } catch (e) { stopped = String((e as Error).message); await pg.exec('rollback') }
  assert(stopped.includes('both test and live payments'), stopped)
  assertEquals(await cols('workshop_sessions'), before.s, 'a stopped migration changes nothing')
  await seed(false)
  await pg.exec('begin;\n' + UP2 + '\ncommit;')
  assertEquals((await q(`select slug, is_test from public.workshop_sessions order by slug`)).map((r) => [r.slug, r.is_test]),
    [['no-payments', false], ['only-live', false], ['only-test', true]])
  await pg.exec(UP2) // idempotent
  for (const c of ['admission', 'calendar_event_id', 'foundations_discount_pct', 'graduate_free', 'reserved_graduate_seats', 'referral_discount_ghs', 'referral_commission_ghs', 'is_test']) {
    assert((await cols('workshop_sessions')).split(',').includes(c), c)
  }
  for (const c of ['attend_email', 'invited_email', 'price_tier', 'benefit_credential_id', 'list_price_ghs', 'discount_kind', 'discount_ghs', 'referral_code', 'referrer_id', 'commission_ghs']) {
    assert((await cols('workshop_registrations')).split(',').includes(c), c)
  }
  assertEquals([await cols('payment_events'), await cols('enrollments'), await cols('credentials')], [before.p, before.e, before.c],
    'the training ledger, enrollments and the certificate register are untouched')
  for (const fn of ['workshop_set_attend_email(uuid,text)', 'workshop_admin_admission(text,uuid,text,text)', 'workshop_credential_tier(text)', 'workshop_email_may_claim(text,text,uuid)', 'workshop_benefit_request(text,text,text,text)',
    'workshop_benefit_confirm(text,text,text,text,text)', 'workshop_price(uuid,text,text,text)', 'workshop_quote(text,text,text,text,text)', 'workshop_is_test_registration(uuid)',
    'workshop_obligations_met(uuid)', 'workshop_admin_referral(text,text,text,uuid,text,text,text,uuid)', 'workshop_register(text,text,text,text,boolean,text,text,jsonb,boolean,numeric,timestamptz)']) {
    for (const role of ['anon', 'authenticated']) {
      assertEquals((await q(`select has_function_privilege($1, $2, 'execute') ok`, [role, 'public.' + fn]))[0].ok, false, role + ' ' + fn)
    }
  }
  for (const t of ['workshop_referrers', 'workshop_referral_payouts', 'workshop_benefit_verifications', 'workshop_benefit_email_grants']) {
    assertEquals((await q(`select has_table_privilege('anon', $1, 'select') ok`, ['public.' + t]))[0].ok, false, t)
  }
  // Defaults leave every existing session exactly as it behaved.
  await session()
  assertEquals((await q(`select admission, foundations_discount_pct, graduate_free, reserved_graduate_seats, is_test from public.workshop_sessions`))[0],
    { admission: 'link', foundations_discount_pct: 0, graduate_free: false, reserved_graduate_seats: 0, is_test: false })
  // A Google Calendar event ID of realistic length is accepted (a repetition count above 255
  // in the check would make every non-null value an error).
  await pg.exec(`update public.workshop_sessions set calendar_event_id = '${'a'.repeat(26)}'`)
  await pg.exec(DOWN2)
  assertEquals((await q(`select count(*)::int n from pg_trigger where tgname in ('workshop_payout_guard', 'workshop_session_test_fixed')`))[0].n, 0)
  assertEquals((await q(`select count(*)::int n from pg_proc where proname in ('workshop_is_test_registration', 'workshop_payout_guard',
    'workshop_session_test_fixed', 'workshop_quote', 'workshop_price')`))[0].n, 0, 'rollback removes every release 2 function')
  assertEquals([await cols('workshop_sessions'), await cols('workshop_registrations')], [before.s, before.r])
  assertEquals([await body('workshop_register'), await body('workshop_start_attempt'), await body('workshop_seats_in_use')],
    [before.reg, before.start, before.seats], 'rollback restores the original function bodies exactly')
  await pg.exec(UP2)
})

Deno.test('release 2 deployment checks: preflight, apply, postflight, rollback, rollback check on a production-shaped database', async () => {
  const db = new PGlite()
  const x = async (sql: string, v: unknown[] = []) => (await db.query<Row>(sql, v)).rows
  for (const f of ['./fixtures/payment-ledger.sql', './fixtures/supabase-stubs.sql', './fixtures/graduate-records.sql']) await db.exec(await read(f))
  // What production has that the fixtures do not: the migration history and the dispatcher job.
  await db.exec(`create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (version text primary key, name text);
    create schema if not exists cron; create table if not exists cron.job (jobname text, command text);
    insert into cron.job values ('workshop-dispatch', 'select net.http_post(url := ''https://webinar-e2e-test.bulletproofautomations-training.pages.dev/api/workshops/dispatch'')')`)
  await db.exec(UP)
  await db.exec(`insert into supabase_migrations.schema_migrations values ('20261103120000', 'workshops')`)
  // Production as it stands: a test session with paid test registrations, and workshop 01 as a draft.
  const t = (await x(`insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs, capacity, status, join_instructions)
    values ('test-webinar-checkout', 'webinar', 'Test', now() + interval '30 days', 60, 'test', 10, 10, 'draft', 'x') returning id`))[0].id
  await x(`insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs, capacity, status, join_instructions)
    values ('what-to-charge-for-automation', 'workshop', 'W01', now() + interval '33 days', 180, 'live online', 350, 25, 'draft', 'private')`)
  for (let i = 1; i <= 3; i++) {
    const r = (await x(`insert into public.workshop_registrations (session_id, email_normalized, full_name, terms_ack, terms_version, status, payment_status, amount_ghs, amount_paid_minor)
      values ($1, $2, 'Tester', true, '2026-11-03', 'confirmed', 'paid', 10, 1000) returning id`, [t, `t${i}@example.com`]))[0].id
    await x(`insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, mode, status) values ($1, $2, 1000, 'test', 'succeeded')`,
      [r, 'BPA-WTEST-2026-PREFLIGHT' + i])
  }
  const run = async (f: string) => Object.values((await x(await read(f)))[0])[0] as Row
  const pre = await run('../supabase/checks/20261109120000_preflight.sql')
  for (const k of Object.keys(pre).filter((k) => k.startsWith('ok_'))) assertEquals(pre[k], true, 'preflight ' + k)
  assertEquals([pre.will_become_test_sessions, pre.live_attempts], [['test-webinar-checkout'], 0])

  // Applied as Supabase applies a migration: one transaction, recorded in the history.
  await db.exec('begin;\n' + await read('../supabase/migrations/20261109120000_workshop_admission_benefits.sql') +
    `\ninsert into supabase_migrations.schema_migrations values ('20261109120000', 'workshop_admission_benefits');\ncommit;`)
  const post = await run('../supabase/checks/20261109120000_postflight.sql')
  for (const k of Object.keys(post).filter((k) => k.startsWith('ok_'))) assertEquals(post[k], true, 'postflight ' + k)
  assertEquals(post.sessions, [['test-webinar-checkout', true], ['what-to-charge-for-automation', false]])
  assertEquals(post.snapshot, pre.snapshot, 'nothing outside release 2 changed, including every existing registration and payment')

  await db.exec(await read('../supabase/migrations/rollback/20261109120000_workshop_admission_benefits_down.sql'))
  const back = await run('../supabase/checks/20261109120000_rollback_check.sql')
  for (const k of Object.keys(back).filter((k) => k.startsWith('ok_'))) assertEquals(back[k], true, 'rollback ' + k)
  assertEquals(back.release1_bodies, pre.release1_bodies, 'rollback restores the release 1 functions exactly')
  assertEquals(back.snapshot, pre.snapshot)
})

Deno.test('release 3 (calendar sync): additive, idempotent, closed to anon, and its rollback leaves release 2 exactly', async () => {
  const UP3 = await read('../supabase/migrations/20261110120000_workshop_calendar_sync.sql')
  const DOWN3 = await read('../supabase/migrations/rollback/20261110120000_workshop_calendar_sync_down.sql')
  const cols = async (t: string) => (await q(`select column_name from information_schema.columns where table_name = $1 order by ordinal_position`, [t])).map((r) => r.column_name).join(',')
  const fns = async () => (await q(`select p.proname || ':' || md5(p.prosrc) f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'workshop%' order by 1`)).map((r) => r.f).join(',')
  const before = { s: await cols('workshop_sessions'), r: await cols('workshop_registrations'), p: await cols('payment_events'), f: await fns() }
  await pg.exec(UP3)
  await pg.exec(UP3) // idempotent
  for (const c of ['calendar_sync_failures', 'calendar_sync_error', 'calendar_sync_at']) assert((await cols('workshop_registrations')).split(',').includes(c), c)
  assertEquals([await cols('workshop_sessions'), await cols('payment_events')], [before.s, before.p], 'sessions and the training ledger untouched')
  for (const fn of ['workshop_calendar_plan(boolean,integer)', 'workshop_calendar_record(uuid,boolean,text,text,text,boolean)', 'workshop_calendar_retry(text,uuid)']) {
    for (const role of ['anon', 'authenticated']) {
      assertEquals((await q(`select has_function_privilege($1, $2, 'execute') ok`, [role, 'public.' + fn]))[0].ok, false, role + ' ' + fn)
    }
  }
  // No existing function was replaced: every release 1 and 2 body is byte-identical.
  const after = (await fns()).split(',').filter((f) => !/^workshop_calendar_/.test(f)).join(',')
  assertEquals(after, before.f)
  await pg.exec(DOWN3)
  assertEquals([await cols('workshop_registrations'), await fns()], [before.r, before.f], 'rollback restores release 2 exactly')
  await pg.exec(UP3)
})
