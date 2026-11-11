/**
 * Release 6 (workshop studio), end to end against releases 1 to 6 on production's
 * ledger schema (PGlite): workshops created, edited, published, closed, cancelled and
 * deleted from the admin; pages rendered from the database; referral codes for anyone
 * under one set of terms; and certificate prices applied at once for the certificate's
 * own email, with a code to the certificate's address for any other.
 *
 *   deno test --node-modules-dir=none --allow-net --allow-read --allow-env tests/workshops-studio.test.ts
 */
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { loadDatabase, serveDatabase } from './helpers/postgrest.ts'

type Row = Record<string, any>
const u = (p: string) => new URL(p, import.meta.url)
const MIGRATIONS = ['20261103120000_workshops', '20261109120000_workshop_admission_benefits', '20261110120000_workshop_calendar_sync',
  '20261111120000_workshop_waitlist', '20261112120000_workshop_audit_corrections']
const pg = await loadDatabase([u('./fixtures/payment-ledger.sql'), u('./fixtures/supabase-stubs.sql'), u('./fixtures/graduate-records.sql'),
  ...MIGRATIONS.map((m) => u(`../supabase/migrations/${m}.sql`))])
// Workshop 01 exists before release 6, as in production.
await pg.exec(`insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs, capacity, status,
  admission, calendar_event_id, reserved_graduate_seats, foundations_discount_pct, graduate_free, referral_discount_ghs, referral_commission_ghs)
  values ('what-to-charge-for-automation', 'workshop', 'You know automation. Do you know what to charge?', now() + interval '30 days', 180,
  'live online', 350, 25, 'published', 'invite', 'liveevent0001', 5, 20, true, 50, 50)`)
await pg.exec(await Deno.readTextFile(u('../supabase/migrations/20261113120000_workshop_admin_studio.sql')))
await pg.exec(await Deno.readTextFile(u('../supabase/migrations/20261113120100_workshop_content_seed.sql')))
const DB = serveDatabase(pg, 54351)

const adminAction = (await import('../functions/api/admin/workshops.js')).onRequestPost
const benefit = (await import('../functions/api/workshops/benefit.js')).onRequestPost
const quote = (await import('../functions/api/workshops/quote.js')).onRequestPost
const register = (await import('../functions/api/workshops/register.js')).onRequestPost
const pages = await import('../functions/workshops/[[path]].js')
const sitemap = (await import('../functions/sitemap.xml.js')).onRequestGet

const mail: Row[] = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  let body: any = null
  try { body = init?.body ? JSON.parse(String(init.body)) : null } catch (_) { body = null }
  if (url.host === 'api.mail.hostinger.com') {
    if (url.pathname.endsWith('/me')) return Response.json({ data: { mailboxes: [{ address: 'johnathan@bulletproofautomations.com', resourceId: 'box1' }] } })
    mail.push(body); return Response.json({ ok: true })
  }
  if (url.host === 'paystack.mock' || url.host === 'api.paystack.co') {
    return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x', reference: body?.reference } })
  }
  if (url.pathname === '/auth/v1/user') {
    const auth = (init?.headers as Row)?.Authorization
    return auth === 'Bearer admin-jwt' ? Response.json({ email: 'johnathan@bulletproofautomations.com' })
      : auth === 'Bearer other-jwt' ? Response.json({ email: 'someone@example.com' }) : new Response('no', { status: 401 })
  }
  return realFetch(input, init)
}

// The built shell and 404 page, as Cloudflare's ASSETS binding serves them.
const SHELL = '<!DOCTYPE html><html lang="en"><head><title>__WS_TITLE__</title><meta name="description" content="__WS_DESCRIPTION__">' +
  '<link rel="canonical" href="__WS_CANONICAL__"></head><body><!-- ws-body --></body></html>'
const SITEMAP = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n  <url>\n    <loc>https://training.bulletproofautomations.com/</loc>\n  </url>\n</urlset>\n'
const ASSETS = { fetch: async (req: Request) => {
  const p = new URL(req.url).pathname
  if (p === '/workshops/_shell.html') return new Response(SHELL)
  if (p === '/404.html') return new Response('<p>not found</p>')
  if (p === '/sitemap.xml') return new Response(SITEMAP)
  return new Response('missing', { status: 404 })
} }
const ENV: Row = { SUPABASE_URL: DB.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role-for-tests', HOSTINGER_MAIL_API_TOKEN: 'mail-token',
  WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_live_webinar_studio_suite', WORKSHOP_PAID_CHECKOUT: 'on', PAYSTACK_SECRET_KEY: 'sk_live_training_other', ASSETS }
const TEST_ENV: Row = { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_test_webinar_studio_suite', WORKSHOP_PAYSTACK_API_BASE: 'http://paystack.mock' }

async function call(fn: Function, path: string, body: Row | null, env: Row = ENV, headers: Row = {}) {
  const request = new Request('https://training.example' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const pending: Promise<unknown>[] = []
  const res: Response = await fn({ request, env, waitUntil: (p: Promise<unknown>) => pending.push(p) })
  await Promise.all(pending)
  const text = await res.text()
  let json: Row = {}
  try { json = JSON.parse(text) } catch (_) { json = { raw: text } }
  return { status: res.status, json, text, headers: res.headers }
}
const admin = (body: Row, auth = 'Bearer admin-jwt') => call(adminAction, '/api/admin/workshops', body, ENV, { Authorization: auth })
const page = (path: string, env: Row = ENV) => call(pages.onRequestGet, path, null, env)
const rows = async (sql: string, v: unknown[] = []) => (await pg.query<Row>(sql, v)).rows
const one = async (slug: string) => (await rows(`select * from public.workshop_sessions where slug = $1`, [slug]))[0]
const opts = { sanitizeOps: false, sanitizeResources: false }
const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString()

const draft = {
  title: 'Write proposals clients sign', kind: 'workshop', price_ghs: 350, capacity: 3, reserved_graduate_seats: 0,
  foundations_discount_pct: 20, graduate_free: false, admission: 'link', duration_minutes: 120,
  join_instructions: 'Join on Google Meet: https://meet.google.com/abc-defg-hij',
  content: { summary: 'Turn a conversation into a signed proposal.', outcomes: ['Write the scope', 'Price it'],
    faq: [{ q: 'Is it recorded?', a: 'No.' }], run_of_show: [{ at: '0:00', title: 'Welcome' }] }
}

Deno.test('the seed moves the page content onto the database without touching any booking field', opts, async () => {
  const w = await one('what-to-charge-for-automation')
  assertEquals([w.status, w.price_ghs, w.capacity, w.reserved_graduate_seats, w.series_slug, w.series_number], ['published', '350.00', 25, 5, 'get-paid-for-automation', 1])
  assert(w.content.summary.startsWith('Stop guessing'), 'content copied word for word')
  const planned = await rows(`select slug, status, announce, starts_at, series_number from public.workshop_sessions where announce order by series_number`)
  assertEquals(planned.length, 9)
  assert(planned.every((p) => p.status === 'draft' && p.starts_at === null))
  assertEquals(planned.map((p) => p.series_number), [2, 3, 4, 5, 6, 7, 8, 9, 10])
  // Running the seed again changes nothing.
  await pg.exec(await Deno.readTextFile(u('../supabase/migrations/20261113120100_workshop_content_seed.sql')))
  assertEquals((await rows(`select count(*)::int n from public.workshop_sessions`))[0].n, 10)
  assertEquals((await rows(`select referral_discount_ghs d, referral_commission_ghs c from public.workshop_settings`))[0], { d: '50.00', c: '50.00' })
})

Deno.test('pages render from the database: the live workshop, planned ones, the directory and the sitemap', opts, async () => {
  const live = await page('/workshops/what-to-charge-for-automation/')
  assertEquals(live.status, 200)
  assert(live.text.includes('data-price="350"') && live.text.includes('Stop guessing'))
  assert(live.text.includes("From someone's referral link or code: GHS 300"))
  assert(!/meet\.google\.com|liveevent0001/.test(live.text), 'no joining details or Calendar event on a public page')
  assert(String(live.headers.get('Content-Security-Policy')).includes("form-action 'self' https://checkout.paystack.com"), 'the /workshops* headers are set')
  assertEquals(live.headers.get('X-Frame-Options'), 'DENY')
  const planned = await page('/workshops/close-the-deal')
  assertEquals(planned.status, 200)
  assert(planned.text.includes('data-ws-page="planned"') && !planned.text.includes('data-ws-form'))
  const dir = await page('/workshops')
  assert(dir.text.includes('The ten workshops'))
  assertEquals((await page('/workshops/_shell')).status, 404)
  assertEquals((await page('/workshops/does-not-exist')).status, 404)
  const map = await call(sitemap, '/sitemap.xml', null)
  assert(map.text.includes('/workshops/what-to-charge-for-automation</loc>') && map.text.includes('/workshops/close-the-deal</loc>'))
})

Deno.test('create, publish, edit, close, reopen: the database enforces every rule', opts, async () => {
  assertEquals((await admin({ action: 'session_save', session: draft }, 'Bearer other-jwt')).status, 403, 'admin only')
  const made = await admin({ action: 'session_save', session: draft })
  assertEquals([made.status, made.json.slug, made.json.status], [200, 'write-proposals-clients-sign', 'draft'])
  const id = made.json.id
  const row = await one('write-proposals-clients-sign')
  assertEquals([row.referral_discount_ghs, row.referral_commission_ghs], ['50.00', '50.00'], 'new workshops take the referral terms')
  assert(row.admin_notes.includes('save'), 'audited')
  // A draft has no page, even with a date.
  assertEquals((await page('/workshops/write-proposals-clients-sign')).status, 404)
  // Publishing needs a date.
  const early = await admin({ action: 'session_publish', session_id: id })
  assertEquals(early.status, 409)
  assert(early.json.error.includes('set a date'))
  assertEquals((await admin({ action: 'session_save', session_id: id, session: { starts_at: inDays(20) } })).status, 200)
  assertEquals((await admin({ action: 'session_publish', session_id: id })).json.ok, true)
  const pub = await page('/workshops/write-proposals-clients-sign')
  assertEquals(pub.status, 200)
  assert(pub.text.includes('Turn a conversation into a signed proposal.'))
  assert(!pub.text.includes('meet.google.com'), 'joining instructions stay private')
  // Edits go live at once.
  assertEquals((await admin({ action: 'session_save', session_id: id, session: { content: { ...draft.content, summary: 'A sharper summary.' } } })).status, 200)
  assert((await page('/workshops/write-proposals-clients-sign')).text.includes('A sharper summary.'))
  // An edit that would leave a published workshop unpublishable is refused, and nothing changes.
  const blank = await admin({ action: 'session_save', session_id: id, session: { title: 'Renamed', content: { summary: '' } } })
  assertEquals(blank.status, 409)
  assertEquals((await one('write-proposals-clients-sign')).title, 'Write proposals clients sign')
  // The address cannot change once open, and a meeting link cannot reach the page.
  assertEquals((await admin({ action: 'session_save', session_id: id, session: { slug: 'new-address' } })).status, 409)
  assertEquals((await admin({ action: 'session_save', session_id: id, session: { content: { summary: 'See https://zoom.us/j/1' } } })).status, 409)
  // Invitation-only needs a Calendar event, and an event cannot serve two workshops.
  const inv = await admin({ action: 'session_save', session_id: id, session: { admission: 'invite' } })
  assert(inv.json.error.includes('Google Calendar event'))
  const dup = await admin({ action: 'session_save', session_id: id, session: { admission: 'invite', calendar_event_id: 'liveevent0001' } })
  assert(dup.json.error.includes('already attached'))
  // Close, then reopen.
  assertEquals((await admin({ action: 'session_close', session_id: id })).json.ok, true)
  assertEquals((await one('write-proposals-clients-sign')).status, 'closed')
  assertEquals((await page('/workshops/write-proposals-clients-sign')).status, 200, 'a shared link still explains itself')
  assertEquals((await admin({ action: 'session_publish', session_id: id })).json.ok, true)
  // Completed only after it starts.
  assertEquals((await admin({ action: 'session_complete', session_id: id })).status, 409)
})

Deno.test('a refused save leaves nothing behind: no half-created workshop, no half-applied edit', opts, async () => {
  const before = (await rows(`select count(*)::int n from public.workshop_sessions`))[0].n
  const dup = await admin({ action: 'session_save', session: { ...draft, title: 'Clash on the calendar', admission: 'invite', calendar_event_id: 'liveevent0001' } })
  assertEquals(dup.status, 409)
  assertEquals((await rows(`select count(*)::int n from public.workshop_sessions`))[0].n, before, 'the insert was undone with the refusal')
  const w = await one('what-to-charge-for-automation')
  const bad = await admin({ action: 'session_save', session_id: w.id, session: { title: 'Half applied?', admission: 'invite', calendar_event_id: 'u2cqtiqhcl289nme78vq2ff7v0x', series_number: 2 } })
  assertEquals(bad.status, 409, 'series number 2 belongs to another workshop')
  const after = await one('what-to-charge-for-automation')
  assertEquals([after.title, after.calendar_event_id, after.series_number], [w.title, w.calendar_event_id, 1])
})

Deno.test('capacity never drops below places taken; a workshop with registrations is cancelled, never deleted', opts, async () => {
  const made = await admin({ action: 'session_save', session: { ...draft, title: 'Deliver like a pro, again', starts_at: inDays(20) } })
  const id = made.json.id
  await admin({ action: 'session_publish', session_id: id })
  for (const email of ['a@example.com', 'b@example.com']) {
    await pg.query(`insert into public.workshop_registrations (session_id, email_normalized, full_name, status, payment_status, amount_ghs, terms_version, terms_ack)
      values ($1, $2, 'Paid Person', 'confirmed', 'paid', 350, '2026-11-03', true)`, [id, email])
  }
  const low = await admin({ action: 'session_save', session_id: id, session: { capacity: 1 } })
  assertEquals(low.status, 409)
  assert(low.json.error.includes('2 taken'))
  assertEquals((await admin({ action: 'session_save', session_id: id, session: { capacity: 2 } })).status, 200)
  const del = await admin({ action: 'session_delete', session_id: id })
  assert(del.json.error.includes('Cancel it instead'))
  assertEquals((await admin({ action: 'session_cancel', session_id: id, reason: 'no' })).status, 409, 'a reason is required')
  assertEquals((await admin({ action: 'session_cancel', session_id: id, reason: 'Instructor unavailable' })).json.ok, true)
  const after = await one('deliver-like-a-pro-again')
  assertEquals(after.status, 'cancelled')
  assert(after.admin_notes.includes('Instructor unavailable'))
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations where session_id = $1 and status = 'confirmed'`, [id]))[0].n, 2,
    'paid places stay on record')
  // A workshop nobody registered for is deleted outright.
  const spare = await admin({ action: 'session_save', session: { ...draft, title: 'Spare draft' } })
  assertEquals((await admin({ action: 'session_delete', session_id: spare.json.id })).json.deleted, true)
  assertEquals(await one('spare-draft'), undefined)
})

Deno.test('referral codes for anyone: one code, every workshop, one set of terms; no self-referral', opts, async () => {
  const bad = await admin({ action: 'referrer_create', referrer: { name: 'Kofi Addo', email: 'not-an-email', payout_method: 'MoMo 024' } })
  assertEquals(bad.status, 409)
  const made = await admin({ action: 'referrer_create', referrer: { name: 'Kofi Addo', email: 'Kofi@Example.com', payout_method: 'MoMo 024 000 0000', code: 'kofi50' } })
  assertEquals([made.json.code], ['KOFI50'])
  assertEquals((await admin({ action: 'referrer_create', referrer: { name: 'Other', email: 'o@example.com', payout_method: 'MoMo', code: 'KOFI50' } })).status, 409)
  const q = (email: string, ref: string) => call(quote, '/api/workshops/quote', { slug: 'what-to-charge-for-automation', email, ref })
  assertEquals((await q('buyer@example.com', 'KOFI50')).json.price_ghs, 300, 'works on a live workshop at once')
  assertEquals((await q('kofi@example.com', 'KOFI50')).json.code, 'referral_invalid', 'not on their own place')
  // Terms change once and apply to every open workshop.
  assertEquals((await admin({ action: 'referral_terms', referrer: { discount_ghs: 70, commission_ghs: 40 } })).json.ok, true)
  assertEquals((await q('buyer@example.com', 'KOFI50')).json.price_ghs, 280)
  assertEquals((await one('who-should-you-sell-to')).referral_commission_ghs, '40.00', 'planned workshops too')
  await admin({ action: 'referral_terms', referrer: { discount_ghs: 50, commission_ghs: 50 } })
  // Suspended codes work nowhere; reactivated ones work again.
  await admin({ action: 'referrer_suspend', referrer_id: made.json.id })
  assertEquals((await q('buyer@example.com', 'KOFI50')).json.code, 'referral_invalid')
  await admin({ action: 'referrer_activate', referrer_id: made.json.id })
  assertEquals((await q('buyer@example.com', 'KOFI50')).json.price_ghs, 300)
  assertEquals((await admin({ action: 'referrer_payouts', referrer_id: made.json.id, referrer: { reference: 'MP123456' } })).json.error,
    'Nothing is owed on this code right now.')
})

Deno.test('certificate price: the certificate email applies at once; any other email gets a code at the certificate address', opts, async () => {
  await pg.exec(`insert into public.credentials (credential_id, holder_name, holder_email, credential, status)
    values ('BPA-FND-2026-STUDIO', 'Esi Mensah', 'esi@example.com', 'foundations', 'valid') on conflict do nothing`)
  const ask = (email: string) => call(benefit, '/api/workshops/benefit', { step: 'request', slug: 'what-to-charge-for-automation', email, certificate_id: 'BPA-FND-2026-STUDIO' })
  mail.length = 0
  const same = await ask('ESI@example.com')
  assertEquals([same.json.verified, same.json.tier], [true, 'foundations'])
  assertEquals(mail.length, 0, 'no email needed')
  const priced = await call(quote, '/api/workshops/quote', { slug: 'what-to-charge-for-automation', email: 'esi@example.com', verification: same.json.verification })
  assertEquals(priced.json.price_ghs, 280)
  // Someone else typing Esi's public ID: the code goes to Esi, never to them.
  const other = await ask('copycat@example.com')
  assertEquals(other.json, { ok: true, sent: 'if_eligible' })
  assertEquals(mail.map((m) => m.to[0]), ['esi@example.com'])
  assert(mail[0].text.includes('copycat@example.com'), 'the holder is told who is asking')
  const code = mail[0].text.match(/code is (\d{6})/)![1]
  const ok = await call(benefit, '/api/workshops/benefit', { step: 'confirm', slug: 'what-to-charge-for-automation', email: 'copycat@example.com', certificate_id: 'BPA-FND-2026-STUDIO', code })
  assertEquals(ok.json.ok, true, 'the holder can pass the code on, as before')
  const bound = await call(quote, '/api/workshops/quote', { slug: 'what-to-charge-for-automation', email: 'someone-else@example.com', verification: ok.json.verification })
  assertEquals(bound.json.code, 'benefit_not_valid', 'bound to the registering email')
})

Deno.test('test sessions appear only on a test-mode deployment, and real ones only on the others', opts, async () => {
  const t = await admin({ action: 'session_save', session: { ...draft, title: 'Studio rehearsal', is_test: true, starts_at: inDays(15) } })
  await admin({ action: 'session_publish', session_id: t.json.id })
  assertEquals((await page('/workshops/studio-rehearsal')).status, 404)
  assertEquals((await page('/workshops/studio-rehearsal', TEST_ENV)).status, 200)
  assertEquals((await page('/workshops/what-to-charge-for-automation', TEST_ENV)).status, 404)
})

Deno.test('the release 6 rollback restores release 5 exactly, and the release applies again', opts, async () => {
  // Rows that exist only under release 6 must be dealt with first: that is the documented precondition.
  await pg.exec(`delete from public.workshop_registrations where session_id in (select id from public.workshop_sessions where starts_at is null);
    delete from public.workshop_sessions where starts_at is null;
    delete from public.workshop_registrations where referrer_id in (select id from public.workshop_referrers where credential_id is null);
    delete from public.workshop_referrers where credential_id is null;`)
  await pg.exec(await Deno.readTextFile(u('../supabase/migrations/rollback/20261113120000_workshop_admin_studio_down.sql')))
  const left = await rows(`select column_name from information_schema.columns where table_name = 'workshop_sessions' and column_name in ('content','announce','admin_notes')`)
  assertEquals(left.length, 0)
  assertEquals((await rows(`select count(*)::int n from information_schema.tables where table_name in ('workshop_series','workshop_settings')`))[0].n, 0)
  await pg.exec(await Deno.readTextFile(u('../supabase/migrations/20261113120000_workshop_admin_studio.sql')))
  await pg.exec(await Deno.readTextFile(u('../supabase/migrations/20261113120100_workshop_content_seed.sql')))
  assertEquals((await rows(`select count(*)::int n from public.workshop_sessions where announce`))[0].n, 9)
})
