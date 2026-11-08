/**
 * The real /api/workshops/* Pages Functions, end to end, against the workshop
 * migration on production's ledger schema (PGlite) and stand-ins for Paystack,
 * the Hostinger mail API and the Meta Conversions API.
 *
 *   deno test --node-modules-dir=none --allow-net --allow-read --allow-env tests/workshops-api.test.ts
 */
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { loadDatabase, serveDatabase } from './helpers/postgrest.ts'

type Row = Record<string, any>
const u = (p: string) => new URL(p, import.meta.url)
const pg = await loadDatabase([u('./fixtures/payment-ledger.sql'), u('./fixtures/supabase-stubs.sql'), u('./fixtures/graduate-records.sql'),
  u('../supabase/migrations/20261103120000_workshops.sql'), u('../supabase/migrations/20261109120000_workshop_admission_benefits.sql')])
const DB = serveDatabase(pg, 54341)

const register = (await import('../functions/api/workshops/register.js')).onRequestPost
const status = (await import('../functions/api/workshops/status.js')).onRequestPost
const session = (await import('../functions/api/workshops/session.js')).onRequestGet
const dispatch = (await import('../functions/api/workshops/dispatch.js')).onRequestPost
const calendar = (await import('../functions/api/workshops/calendar.js')).onRequestGet
const adminAction = (await import('../functions/api/admin/workshops.js')).onRequestPost

// --- external services ------------------------------------------------------------------
const paystack = { paid: new Map<string, Row>(), initialized: [] as Row[], failInit: false }
const mail: Row[] = []
const meta: Row[] = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const body = init?.body ? JSON.parse(String(init.body)) : null
  if (url.host === 'paystack.mock') {
    if (url.pathname === '/transaction/initialize') {
      if (paystack.failInit) return Response.json({ status: false, message: 'declined' }, { status: 400 })
      paystack.initialized.push({ ...body, _auth: (init?.headers as Row)?.Authorization })
      return Response.json({ status: true, data: { authorization_url: 'https://checkout.paystack.com/x', reference: body.reference } })
    }
    const ref = decodeURIComponent(url.pathname.replace('/transaction/verify/', ''))
    const t = paystack.paid.get(ref)
    return Response.json({ status: true, data: t ?? { status: 'abandoned', reference: ref } })
  }
  if (url.host === 'api.mail.hostinger.com') {
    if (url.pathname.endsWith('/me')) {
      return Response.json({ data: { mailboxes: [{ address: 'johnathan@bulletproofautomations.com', resourceId: 'box1' }] } })
    }
    mail.push(body)
    return Response.json({ ok: true })
  }
  if (url.host === 'graph.facebook.com') {
    meta.push({ url: url.href, auth: (init?.headers as Row)?.Authorization, body })
    return Response.json({ events_received: body.data.length })
  }
  if (url.pathname === '/auth/v1/user') {
    const auth = (init?.headers as Row)?.Authorization
    return auth === 'Bearer admin-jwt' ? Response.json({ email: 'johnathan@bulletproofautomations.com' })
      : new Response('no', { status: 401 })
  }
  return realFetch(input, init)
}

const ENV: Row = {
  SUPABASE_URL: DB.url,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-for-tests',
  // The WEBINAR business's key. The training business's key is set too, and differs.
  WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_test_webinar_api_suite_only',
  WORKSHOP_PAYSTACK_API_BASE: 'http://paystack.mock',
  PAYSTACK_SECRET_KEY: 'sk_test_training_api_suite_only',
  HOSTINGER_MAIL_API_TOKEN: 'mail-token',
}

async function call(fn: Function, path: string, body: Row | null, env: Row = ENV, headers: Row = {}) {
  const pending: Promise<unknown>[] = []
  const request = new Request('https://training.example' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'TestPhone/1.0', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const res: Response = await fn({ request, env, waitUntil: (p: Promise<unknown>) => pending.push(p) })
  await Promise.all(pending)
  const text = await res.text()
  let json: Row = {}
  try { json = JSON.parse(text) } catch (_) { json = { raw: text } }
  return { status: res.status, json, text, headers: res.headers }
}

async function reset(over: Row = {}) {
  paystack.paid.clear(); paystack.initialized.length = 0; paystack.failInit = false
  mail.length = 0; meta.length = 0; DB.fail.clear()
  await pg.exec(`truncate public.workshop_meta_events, public.workshop_notifications, public.workshop_status_tokens,
    public.workshop_payment_attempts, public.workshop_registrations, public.workshop_sessions, public.workshop_dispatch_config cascade`)
  const row = { slug: 'automate-invoices', kind: 'webinar', title: 'Automate your invoices', duration_minutes: 90,
    format: 'Online, live', price_ghs: 150, status: 'published', join_instructions: 'Zoom link: https://zoom.example/j/1',
    starts_at: new Date(Date.now() + 5 * 86400000).toISOString(), ...over }
  const keys = Object.keys(row)
  await pg.query(`insert into public.workshop_sessions (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
    keys.map((k) => (row as Row)[k]))
}
const form = (over: Row = {}) => ({
  slug: 'automate-invoices', full_name: 'Ama Mensah', email: 'ama@example.com', ack_terms: true,
  attribution: { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: '120210000', utm_content: 'ad-42',
    landing_path: '/workshops/automate-invoices', fbclid: 'IwAR0abcdefgh', fbp: 'fb.1.1730000000000.123456789' },
  ...over,
})
const rows = async (sql: string, v: unknown[] = []) => (await pg.query<Row>(sql, v)).rows
const opts = { sanitizeOps: false, sanitizeResources: false }

// --- free -------------------------------------------------------------------------------

Deno.test('free: confirmed immediately, email sent, CompleteRegistration id returned, no PII echoed', opts, async () => {
  await reset({ price_ghs: 0 })
  const r = await call(register, '/api/workshops/register', form({ ad_consent: true }))
  assertEquals([r.status, r.json.state, r.json.registration], [200, 'confirmed', 'created'])
  assert(/^[A-Za-z0-9_-]{43}$/.test(r.json.token))
  assert(r.json.events.complete_registration.startsWith('cr_'))
  assert(!r.text.includes('ama@example.com') && !r.text.includes('Ama Mensah'))
  assertEquals(mail.length, 1)
  assertEquals(mail[0].to, ['ama@example.com'])
  assert(mail[0].subject.startsWith("You're registered"))
  assert(mail[0].text.includes('Zoom link'), 'confirmed registrant receives join instructions')
  const reg = (await rows(`select * from public.workshop_registrations`))[0]
  assertEquals([reg.utm_campaign, reg.utm_content, reg.fbp, reg.client_ip], ['120210000', 'ad-42', 'fb.1.1730000000000.123456789', '203.0.113.7'])
})

Deno.test('free: the same email twice is one registration and one email', opts, async () => {
  await reset({ price_ghs: 0 })
  await call(register, '/api/workshops/register', form())
  const again = await call(register, '/api/workshops/register', form({ email: 'AMA@example.com ' }))
  assertEquals([again.json.state, again.json.registration], ['confirmed', 'existing'])
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations`))[0].n, 1)
  assertEquals(mail.length, 1)
})

Deno.test('without ad consent: UTMs kept, Meta identifiers and request context dropped', opts, async () => {
  await reset({ price_ghs: 0 })
  await call(register, '/api/workshops/register', form({ ad_consent: false }))
  const reg = (await rows(`select * from public.workshop_registrations`))[0]
  assertEquals([reg.utm_campaign, reg.fbclid, reg.fbp, reg.client_ip, reg.client_user_agent], ['120210000', null, null, null, null])
  assertEquals((await rows(`select count(*)::int n from public.workshop_meta_events`))[0].n, 0)
})

Deno.test('validation: terms required; honeypot records nothing; stale price refused; unknown slug 404', opts, async () => {
  await reset()
  assertEquals((await call(register, '/api/workshops/register', form({ ack_terms: false }))).status, 400)
  const bot = await call(register, '/api/workshops/register', form({ company_website: 'spam.example' }))
  assertEquals(bot.status, 200)
  assertEquals((await call(register, '/api/workshops/register', form({ displayed_price: 100 }))).json.code, 'stale_page')
  assertEquals((await call(register, '/api/workshops/register', form({ slug: 'no-such-session' }))).status, 404)
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations`))[0].n, 0)
})

// --- paid -------------------------------------------------------------------------------

Deno.test('paid: live key without WORKSHOP_PAID_CHECKOUT takes no money and starts no attempt', opts, async () => {
  await reset()
  const r = await call(register, '/api/workshops/register', form(), { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_live_webinar_api_suite_only' })
  assertEquals([r.json.state, r.json.checkout], ['pending_payment', 'unavailable'])
  assertEquals((await rows(`select count(*)::int n from public.workshop_payment_attempts`))[0].n, 0)
})

Deno.test('paid: the training business key alone never opens webinar checkout', opts, async () => {
  await reset()
  const env = { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: undefined }
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }), env)
  assertEquals([r.json.state, r.json.checkout], ['pending_payment', 'unavailable'])
  assertEquals(paystack.initialized.length, 0)
})

Deno.test('paid: a webinar key equal to the training key is refused (same business = shared webhook)', opts, async () => {
  await reset()
  const env = { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_test_same_key_everywhere', PAYSTACK_SECRET_KEY: 'sk_test_same_key_everywhere' }
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }), env)
  assertEquals([r.json.state, r.json.checkout], ['pending_payment', 'unavailable'])
  assertEquals(paystack.initialized.length, 0)
})

Deno.test('paid: a test key reaches checkout only with the explicit test opt-in', opts, async () => {
  await reset()
  const plain = await call(register, '/api/workshops/register', form())
  assertEquals(plain.json.checkout, 'unavailable')
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true, amount: 1, price_ghs: 1 }))
  assertEquals([r.json.state, r.json.test], ['checkout', true])
  assert(/^BPA-WTEST-\d{4}-[0-9A-Z]{10}$/.test(r.json.reference))
  assert(r.json.events.initiate_checkout.startsWith('ic_'))
  const sent = paystack.initialized[0]
  assertEquals([sent.amount, sent.currency, sent.metadata.app], [15000, 'GHS', 'bulletproof-training-workshops'])
  assertEquals(sent._auth, 'Bearer sk_test_webinar_api_suite_only') // the webinar business's key, never the training key
  assertEquals(sent.channels, ['mobile_money', 'card'])
  assert(!('cohort' in sent.metadata), 'cohort metadata must not appear on a workshop checkout')
})

Deno.test('paid: initialize failure keeps the attempt; a retry adds a second reference', opts, async () => {
  await reset()
  paystack.failInit = true
  const first = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  assertEquals([first.json.state, first.json.checkout, first.json.retry], ['pending_payment', 'unavailable', true])
  paystack.failInit = false
  const second = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  assertEquals(second.json.state, 'checkout')
  const attempts = await rows(`select status from public.workshop_payment_attempts order by created_at`)
  assertEquals(attempts.map((a) => a.status), ['init_failed', 'initialized'])
})

Deno.test('status: a reference alone reveals nothing; the right token confirms only on verified payment', opts, async () => {
  await reset()
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true, ad_consent: true }))
  const reference = r.json.reference
  const fake = 'A'.repeat(43)
  assertEquals((await call(status, '/api/workshops/status', { token: fake, reference })).json, { ok: true, state: 'unknown' })
  assertEquals((await call(status, '/api/workshops/status', { reference })).json, { ok: true, state: 'unknown' })

  // Back from Paystack, not paid: still pending, and no Purchase is offered to the Pixel.
  const pending = await call(status, '/api/workshops/status', { token: r.json.token, reference })
  assertEquals([pending.json.state, pending.json.events.purchase], ['pending_payment', undefined])
  assert(!pending.text.includes('ama@example.com') && !pending.text.includes('Ama Mensah'))

  // Paystack now reports success. The status endpoint verifies server-side (throttle lifted).
  paystack.paid.set(reference, { status: 'success', reference, amount: 15000, currency: 'GHS', domain: 'test', paid_at: new Date().toISOString() })
  await pg.query(`update public.workshop_payment_attempts set last_verify_at = null`)
  const done = await call(status, '/api/workshops/status', { token: r.json.token, reference })
  assertEquals([done.json.state, done.json.test], ['confirmed', true])
  assertEquals(done.json.events.purchase, { id: pending.json.events.purchase?.id ?? done.json.events.purchase.id, value: 150, currency: 'GHS' })
  assert(done.json.events.purchase.id.startsWith('pu_'))
  const att = (await rows(`select status, verified_via from public.workshop_payment_attempts`))[0]
  assertEquals([att.status, att.verified_via], ['succeeded', 'verify'])
  assertEquals(mail.filter((m) => m.to[0] === 'ama@example.com').length, 1)
})

Deno.test('status: a valid token cannot read or verify somebody else\'s reference', opts, async () => {
  await reset()
  const a = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  const b = await call(register, '/api/workshops/register', form({ testOptIn: true, email: 'kofi@example.com', full_name: 'Kofi Boateng' }))
  paystack.paid.set(b.json.reference, { status: 'success', reference: b.json.reference, amount: 15000, currency: 'GHS', domain: 'test' })
  const cross = await call(status, '/api/workshops/status', { token: a.json.token, reference: b.json.reference })
  assertEquals(cross.json, { ok: true, state: 'unknown' })
  assertEquals((await rows(`select status from public.workshop_payment_attempts where reference = $1`, [b.json.reference]))[0].status, 'initialized')
})

Deno.test('status: money held for review is not offered to the Pixel as a Purchase', opts, async () => {
  await reset({ capacity: 1 })
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  await pg.query(`update public.workshop_registrations set status = 'payment_received_review', payment_status = 'paid',
    review_reason = 'capacity', amount_paid_minor = 15000`)
  const s = await call(status, '/api/workshops/status', { token: r.json.token })
  assertEquals([s.json.state, s.json.events.purchase], ['payment_review', undefined])
})

Deno.test('status: an underpaid verify result is held for review, never confirmed', opts, async () => {
  await reset()
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  paystack.paid.set(r.json.reference, { status: 'success', reference: r.json.reference, amount: 100, currency: 'GHS', domain: 'test' })
  const s = await call(status, '/api/workshops/status', { token: r.json.token, reference: r.json.reference })
  assertEquals([s.json.state, s.json.events.purchase], ['needs_attention', undefined])
})

// --- dispatcher, Meta, calendar, admin ------------------------------------------------

Deno.test('dispatch: refuses without the secret; reconciles a missed webhook; sends Meta events when configured', opts, async () => {
  await reset()
  const secret = 'dispatch-secret-for-tests'
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  await pg.query(`insert into public.workshop_dispatch_config (secret_hash) values ($1)`, [hash])
  assertEquals((await call(dispatch, '/api/workshops/dispatch', {})).status, 403)

  const r = await call(register, '/api/workshops/register', form({ testOptIn: true, ad_consent: true }))
  // The visitor never came back and the webhook never arrived; Paystack has the money.
  await pg.query(`alter table public.workshop_payment_attempts disable trigger workshop_payment_attempts_immutable`)
  await pg.query(`update public.workshop_payment_attempts set created_at = now() - interval '20 minutes'`)
  await pg.query(`alter table public.workshop_payment_attempts enable trigger workshop_payment_attempts_immutable`)
  paystack.paid.set(r.json.reference, { status: 'success', reference: r.json.reference, amount: 15000, currency: 'GHS', domain: 'test' })

  const env = { ...ENV, META_PIXEL_ID: '1234567890', META_CAPI_ACCESS_TOKEN: 'meta-token-for-tests-000000', META_TEST_EVENT_CODE: 'TEST123' }
  const out = await call(dispatch, '/api/workshops/dispatch', {}, env, { 'x-workshop-dispatch': secret })
  assertEquals(out.json.report.reconciled, 1)
  assertEquals((await rows(`select status from public.workshop_registrations`))[0].status, 'confirmed')
  assertEquals(meta.length, 1)
  const events = meta[0].body.data.map((e: Row) => e.event_name).sort()
  assertEquals(events, ['InitiateCheckout', 'Purchase'])
  const purchase = meta[0].body.data.find((e: Row) => e.event_name === 'Purchase')
  assertEquals([purchase.custom_data.value, purchase.custom_data.currency, meta[0].body.test_event_code], [150, 'GHS', 'TEST123'])
  assert(/^[0-9a-f]{64}$/.test(purchase.user_data.em[0]), 'email is hashed')
  assert(!JSON.stringify(meta[0].body).includes('ama@example.com'))
  assertEquals(meta[0].auth, 'Bearer meta-token-for-tests-000000')
  const reg = (await rows(`select client_ip, client_user_agent from public.workshop_registrations`))[0]
  assertEquals([reg.client_ip, reg.client_user_agent], [null, null]) // cleared once Purchase was sent
})

Deno.test('dispatch: webhook-confirmed payments get their confirmation emails in one run, and only once', opts, async () => {
  await reset()
  const secret = 'dispatch-secret-for-tests'
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  await pg.query(`insert into public.workshop_dispatch_config (secret_hash) values ($1)`, [hash])
  // Two students pay; the webhook confirms both before either returns to the site,
  // so neither page visit sends the email. Only the dispatcher can.
  for (const email of ['ama@example.com', 'kofi@example.com']) {
    const r = await call(register, '/api/workshops/register', form({ testOptIn: true, email }))
    await pg.query(`select public.workshop_apply_charge(p_reference => $1, p_amount_minor => 15000, p_currency => 'GHS',
      p_domain => 'test', p_paid_at => now(), p_via => 'webhook')`, [r.json.reference])
  }
  assertEquals(mail.length, 0)
  const first = await call(dispatch, '/api/workshops/dispatch', {}, ENV, { 'x-workshop-dispatch': secret })
  assertEquals(first.status, 200, first.text)
  assertEquals(first.json.report.emails.sent, 2)
  assertEquals(mail.map((m) => m.to[0]).sort(), ['ama@example.com', 'kofi@example.com'])
  assertEquals((await rows(`select status from public.workshop_notifications order by created_at`)).map((r) => r.status), ['sent', 'sent'])
  // The next run finds nothing to send: nobody gets a second copy.
  const second = await call(dispatch, '/api/workshops/dispatch', {}, ENV, { 'x-workshop-dispatch': secret })
  assertEquals(second.json.report.emails.sent, 0)
  assertEquals(mail.length, 2)
})

Deno.test('not bookable: a draft session and a planned workshop with no row create nothing and start no checkout', opts, async () => {
  // Workshop 01 waits as a draft row until go-live; workshops 02-10 have no row at all.
  await reset({ status: 'draft' })
  for (const slug of ['automate-invoices', 'who-should-you-sell-to']) {
    const r = await call(register, '/api/workshops/register', form({ slug, testOptIn: true }))
    assertEquals([r.status, r.json.code], [404, 'not_found'], slug)
    const s = await call(session, '/api/workshops/session?slug=' + slug, null)
    assertEquals(s.status, 404, slug)
  }
  assertEquals((await rows('select count(*)::int as n from public.workshop_registrations'))[0].n, 0)
  assertEquals((await rows('select count(*)::int as n from public.workshop_payment_attempts'))[0].n, 0)
  assertEquals(paystack.initialized.length, 0)
  assertEquals(mail.length, 0)
})

Deno.test('Meta not configured: events stay queued and nothing is sent', opts, async () => {
  await reset({ price_ghs: 0 })
  await call(register, '/api/workshops/register', form({ ad_consent: true }))
  assertEquals(meta.length, 0)
  assertEquals((await rows(`select status from public.workshop_meta_events`))[0].status, 'queued')
})

Deno.test('session endpoint exposes public fields only — no capacity figure, no join link', opts, async () => {
  await reset({ capacity: 25 })
  const s = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assertEquals([s.json.open, s.json.status, s.json.session.price_ghs], [true, 'open', 150])
  assert(!s.text.includes('zoom.example') && !s.text.includes('"capacity"'))
})

Deno.test('calendar: only for a confirmed registration, by token', opts, async () => {
  await reset({ price_ghs: 0 })
  const r = await call(register, '/api/workshops/register', form())
  const ics = await call(calendar, '/api/workshops/calendar?t=' + r.json.token, null)
  assertEquals(ics.status, 200)
  assert(ics.text.includes('BEGIN:VEVENT') && ics.text.includes('SUMMARY:Automate your invoices'))
  assertEquals((await call(calendar, '/api/workshops/calendar?t=' + 'B'.repeat(43), null)).status, 404)
})

Deno.test('admin: refused without a session; admits a payment held for review and emails the attendee', opts, async () => {
  await reset({ capacity: 1 })
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  const reg = (await rows(`select id from public.workshop_registrations`))[0]
  await pg.query(`update public.workshop_registrations set status = 'payment_received_review', payment_status = 'paid',
    review_reason = 'capacity', amount_paid_minor = 15000 where id = $1`, [reg.id])
  assertEquals((await call(adminAction, '/api/admin/workshops', { registration_id: reg.id, action: 'admit' })).status, 403)
  const ok = await call(adminAction, '/api/admin/workshops', { registration_id: reg.id, action: 'admit' }, ENV,
    { Authorization: 'Bearer admin-jwt' })
  assertEquals(ok.json.ok, true)
  assertEquals((await rows(`select status from public.workshop_registrations`))[0].status, 'confirmed')
  assert(mail.some((m) => m.to[0] === 'ama@example.com' && m.subject.startsWith("You're registered")))
  assert(r.json.token)
})

// --- joining details: Google Meet ---------------------------------------------------------

const MEET = 'Join on Google Meet: https://meet.google.com/tst-abcd-xyz\nUse the name you registered with so we can let you in.'
const W01 = { title: 'You know automation. Do you know what to charge?', kind: 'workshop', price_ghs: 350, capacity: 25,
  duration_minutes: 180, time_zone: 'Africa/Accra', format: 'live online', join_instructions: MEET }

async function paidAndConfirmed(email = 'ama@example.com') {
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true, email }))
  await pg.query(`select public.workshop_apply_charge(p_reference => $1, p_amount_minor => 35000, p_currency => 'GHS',
    p_domain => 'test', p_paid_at => now(), p_via => 'webhook')`, [r.json.reference])
  return r
}
async function dispatchNow() {
  const secret = 'dispatch-secret-for-tests'
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  await pg.query(`insert into public.workshop_dispatch_config (secret_hash) values ($1) on conflict do nothing`, [hash])
  return call(dispatch, '/api/workshops/dispatch', {}, ENV, { 'x-workshop-dispatch': secret })
}

Deno.test('Meet: the paid confirmation email has both clocks, the Meet button, both calendar options and the support address', opts, async () => {
  // 12 December 2026, 11:30 GMT: the real workshop 01 instant.
  await reset({ ...W01, starts_at: '2026-12-12T11:30:00Z' })
  await paidAndConfirmed()
  assertEquals((await dispatchNow()).json.report.emails.sent, 1)
  const m = mail[0]
  assertEquals(m.to, ['ama@example.com'])
  assertEquals(m.subject, "You're registered: You know automation. Do you know what to charge?")
  assert(/Date: Saturday,? 12 December 2026/.test(m.text), 'date')
  for (const want of ['Ghana time: 11:30 AM\u20132:30 PM (GMT)', 'Lagos time: 12:30 PM\u20133:30 PM (WAT)',
    'We have received your payment of GHS 350', 'https://meet.google.com/tst-abcd-xyz', 'johnathan@bulletproofautomations.com',
    'calendar.google.com/calendar/render', '/api/workshops/calendar?t=']) {
    assert(m.text.includes(want), 'text has ' + want)
  }
  assert(m.html.includes('>Join on Google Meet</a>') && m.html.includes('href="https://meet.google.com/tst-abcd-xyz"'))
  // The Google Calendar link carries the real slot, in UTC.
  const g = new URL(m.text.match(/https:\/\/calendar\.google\.com\S+/)![0])
  assertEquals(g.searchParams.get('dates'), '20261212T113000Z/20261212T143000Z')
  assertEquals(g.searchParams.get('location'), 'https://meet.google.com/tst-abcd-xyz')
  // The .ics matches: same slot, the Meet link, and nothing that sends an invitation.
  const token = m.text.match(/calendar\?t=([A-Za-z0-9_-]{43})/)![1]
  const ics = await call(calendar, '/api/workshops/calendar?t=' + token, null)
  assertEquals(ics.status, 200)
  const unfolded = ics.text.replace(/\r\n /g, '')
  assert(unfolded.includes('DTSTART:20261212T113000Z') && unfolded.includes('DTEND:20261212T143000Z'))
  assert(unfolded.includes('LOCATION:https://meet.google.com/tst-abcd-xyz'))
  assert(unfolded.includes('METHOD:PUBLISH') && !/ATTENDEE|ORGANIZER|METHOD:REQUEST/.test(unfolded), 'no invitation is generated')
  assert(ics.text.split('\r\n').every((l) => l.length <= 75), 'lines are folded')
  // A second dispatcher run sends nothing more.
  assertEquals((await dispatchNow()).json.report.emails.sent, 0)
  assertEquals(mail.length, 1)
})

Deno.test('Meet: no public or unconfirmed path returns the joining link', opts, async () => {
  await reset({ ...W01 })
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  assert(!r.text.includes('meet.google.com'), 'register reply')
  const s = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assert(!s.text.includes('meet.google.com'), 'public session reply')
  const st = await call(status, '/api/workshops/status', { token: r.json.token, reference: r.json.reference })
  assert(!st.text.includes('meet.google.com'), 'status reply')
  // Registered but not paid: no calendar file, no email.
  assertEquals((await call(calendar, '/api/workshops/calendar?t=' + r.json.token, null)).status, 404)
  await dispatchNow()
  assert(!mail.some((m) => JSON.stringify(m).includes('meet.google.com')), 'nothing sent to an unpaid registration')
})

Deno.test('Meet: a refund before the email goes out stops it, and a refunded registration loses the calendar file', opts, async () => {
  await reset({ ...W01 })
  const r = await paidAndConfirmed()
  const ok = await call(calendar, '/api/workshops/calendar?t=' + r.json.token, null)
  assertEquals(ok.status, 200)
  // Refunded in full before the dispatcher ran.
  await pg.query(`select public.workshop_apply_refund(p_reference => $1, p_amount_minor => 35000, p_domain => 'test')`, [r.json.reference])
  const reg = (await rows(`select status from public.workshop_registrations`))[0]
  assert(reg.status !== 'confirmed', 'refunded registration is no longer confirmed: ' + reg.status)
  const out = await dispatchNow()
  assertEquals([out.json.report.emails.sent, out.json.report.emails.skipped], [0, 1])
  assertEquals(mail.length, 0)
  assertEquals((await call(calendar, '/api/workshops/calendar?t=' + r.json.token, null)).status, 404)
})

// --- admission by Google Calendar invitation ------------------------------------------------

const adminEnv = { Authorization: 'Bearer admin-jwt' }
const admit = (id: string, action: string, email?: string) =>
  call(adminAction, '/api/admin/workshops', { registration_id: id, action, ...(email ? { email } : {}) }, ENV, adminEnv)
const regRow = async (email = 'ama@example.com') =>
  (await rows(`select * from public.workshop_registrations where email_normalized = $1`, [email]))[0]

Deno.test('invite: an invitation-only session refuses a registration without a Google account, and writes nothing', opts, async () => {
  await reset({ ...W01, admission: 'invite' })
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  assertEquals([r.status, r.json.code], [400, 'attend_email_required'])
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations`))[0].n, 0)
  assertEquals(paystack.initialized.length, 0)
  const bad = await call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'not-an-email' }))
  assertEquals(bad.status, 400)
})

Deno.test('invite: the Google account is stored once; re-submitting with the same payment email cannot redirect it', opts, async () => {
  await reset({ ...W01, admission: 'invite' })
  await call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'Ama.Meet@Gmail.com ' }))
  assertEquals((await regRow()).attend_email, 'ama.meet@gmail.com')
  const again = await call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'intruder@gmail.com' }))
  assertEquals(again.json.registration, 'existing')
  assertEquals((await regRow()).attend_email, 'ama.meet@gmail.com', 'first write wins')
})

Deno.test('invite: the confirmation explains the invitation, carries no Meet link and no calendar file', opts, async () => {
  await reset({ ...W01, admission: 'invite', starts_at: '2026-12-12T11:30:00Z' })
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'ama.meet@gmail.com' }))
  await pg.query(`select public.workshop_apply_charge(p_reference => $1, p_amount_minor => 35000, p_currency => 'GHS',
    p_domain => 'test', p_paid_at => now(), p_via => 'webhook')`, [r.json.reference])
  assertEquals((await dispatchNow()).json.report.emails.sent, 1)
  const m = mail[0]
  assert(!JSON.stringify(m).includes('meet.google.com'), 'no joining link before the invitation exists')
  assert(!m.text.includes('calendar.google.com') && !m.text.includes('/api/workshops/calendar'), 'no second calendar entry')
  assert(m.text.includes('ama.meet@gmail.com') && m.text.includes('Google Calendar invitation'))
  assert(m.text.includes('Ghana time: 11:30 AM–2:30 PM (GMT)') && m.text.includes('Lagos time: 12:30 PM–3:30 PM (WAT)'))
  const tokenRow = (await rows(`select count(*)::int n from public.workshop_status_tokens`))[0].n
  assert(tokenRow >= 1)
  // The browser's own token: no .ics for an invitation-only session.
  assertEquals((await call(calendar, '/api/workshops/calendar?t=' + r.json.token, null)).status, 404)
  const st = await call(status, '/api/workshops/status', { token: r.json.token, reference: r.json.reference })
  assertEquals([st.json.state, st.json.session.admission], ['confirmed', 'invite'])
  assert(!st.text.includes('ama.meet@gmail.com') && !st.text.includes('meet.google.com'), 'status reveals no account or link')
})

Deno.test('invite: only a paid, confirmed registration can be marked invited; refunds and account changes surface as removals', opts, async () => {
  await reset({ ...W01, admission: 'invite' })
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'ama.meet@gmail.com' }))
  const id = (await regRow()).id
  // Not admin: refused. Unpaid: refused.
  assertEquals((await call(adminAction, '/api/admin/workshops', { registration_id: id, action: 'mark_invited' })).status, 403)
  const early = await admit(id, 'mark_invited')
  assertEquals(early.status, 409)
  assert(early.json.error.includes('confirmed, paid'))
  // Paid: invited once; a second click changes nothing.
  await pg.query(`select public.workshop_apply_charge(p_reference => $1, p_amount_minor => 35000, p_currency => 'GHS',
    p_domain => 'test', p_paid_at => now(), p_via => 'webhook')`, [r.json.reference])
  assertEquals((await admit(id, 'mark_invited')).json.ok, true)
  assertEquals((await admit(id, 'mark_invited')).json.already, true)
  let row = await regRow()
  assertEquals([row.invited_email, row.attend_email], ['ama.meet@gmail.com', 'ama.meet@gmail.com'])
  // Account change: the old account must come off the event before the new one goes on.
  assertEquals((await admit(id, 'set_attend_email', 'ama.work@gmail.com')).json.ok, true)
  assertEquals((await admit(id, 'mark_invited')).status, 409, 'remove the old account first')
  assertEquals((await admit(id, 'mark_removed')).json.ok, true)
  assertEquals((await admit(id, 'mark_invited')).json.ok, true)
  row = await regRow()
  assertEquals(row.invited_email, 'ama.work@gmail.com')
  // The same Google account cannot be invited for a second registration.
  const k = await call(register, '/api/workshops/register', form({ testOptIn: true, email: 'kofi@example.com', attend_email: 'ama.work@gmail.com' }))
  await pg.query(`select public.workshop_apply_charge(p_reference => $1, p_amount_minor => 35000, p_currency => 'GHS',
    p_domain => 'test', p_paid_at => now(), p_via => 'webhook')`, [k.json.reference])
  const kofi = (await regRow('kofi@example.com')).id
  assertEquals((await admit(kofi, 'mark_invited')).status, 409)
  // Refund: the registration stops being confirmed while its account is still on
  // the event, which is exactly the "remove" condition the admin list shows.
  await pg.query(`select public.workshop_apply_refund(p_reference => $1, p_amount_minor => 35000, p_domain => 'test')`, [r.json.reference])
  row = await regRow()
  assert(row.status !== 'confirmed' && row.invited_email === 'ama.work@gmail.com', 'refunded and still on the event: listed for removal')
  assertEquals((await admit(id, 'mark_removed')).json.ok, true)
  assertEquals((await regRow()).invited_email, null)
  // A refunded registration cannot be invited again.
  assertEquals((await admit(id, 'mark_invited')).status, 409)
})

Deno.test('invite: a link session refuses admission actions and still asks for no Google account', opts, async () => {
  await reset({ ...W01 })
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  assertEquals(r.status, 200)
  const id = (await regRow()).id
  const out = await admit(id, 'mark_invited')
  assertEquals(out.status, 409)
  assert(out.json.error.includes('not set to join by invitation'))
})

// --- prices, certificate benefits, reserved graduate seats, referrals --------------------------
// Test records only (PGlite). The shapes mirror production: the public credential
// register, Certificate Studio graduates, PR #54's entitlement table and view, and
// the cohort enrollments and installments the entitlement depends on.

const RELEASE = { ...W01, price_ghs: 350, capacity: 25, admission: 'invite', reserved_graduate_seats: 5,
  foundations_discount_pct: 20, graduate_free: true, referral_commission_ghs: 50 }

async function seedRecords() {
  await pg.exec(`truncate public.workshop_referral_payouts, public.workshop_referrers cascade;
    truncate private.studio_graduate_webinar_entitlements, private.studio_graduates, public.credentials,
      public.payment_plan_installments cascade;
    delete from public.enrollments;`)
  // Foundations certificates: one valid, one revoked.
  await pg.exec(`insert into public.credentials (credential_id, holder_name, holder_email, credential, status) values
    ('BPA-FND-2026-AAAAAA', 'Efua Foundations', 'efua@example.com', 'foundations', 'valid'),
    ('BPA-FND-2026-RRRRRR', 'Revoked Holder', 'revoked@example.com', 'foundations', 'revoked')`)
  // Intermediate graduates: two eligible (paid in full), one still owing an installment.
  for (const [cid, email, paid] of [['BPA-TRN-2026-GRAD01', 'kwame@example.com', true],
    ['BPA-TRN-2026-GRAD02', 'abena@example.com', true], ['BPA-TRN-2026-OWING1', 'owing@example.com', false]]) {
    const e = (await pg.query<Row>(`insert into public.enrollments (full_name, email, whatsapp, city, experience_level, chosen_option,
        amount_ghs, payment_plan, payment_status, amount_paid_ghs)
      values ('Graduate', $1, '+233000000000', 'Accra', 'foundations_graduate', 'cohort_only', 750, true, $2, $3) returning id`,
      [email, paid ? 'paid' : 'partially_paid', paid ? 750 : 400])).rows[0]
    await pg.query(`insert into public.payment_plan_installments (enrollment_id, installment_number, amount_ghs, status)
      values ($1, 1, 400, 'paid'), ($1, 2, 350, $2)`, [e.id, paid ? 'paid' : 'sent'])
    await pg.query(`insert into public.credentials (credential_id, holder_name, holder_email, credential, status, enrollment_id)
      values ($1, 'Graduate', $2, 'completion', 'valid', $3)`, [cid, email, e.id])
    const g = (await pg.query<Row>(`insert into private.studio_graduates (data, credential_id, state)
      values (jsonb_build_object('email', $1::text), $2, 'issued') returning id`, [email, cid])).rows[0]
    await pg.query(`insert into private.studio_graduate_webinar_entitlements (graduate_id) values ($1)`, [g.id])
  }
}
const pay = (reference: string, minor: number) => pg.query(`select public.workshop_apply_charge(p_reference => $1,
  p_amount_minor => $2, p_currency => 'GHS', p_domain => 'test', p_paid_at => now(), p_via => 'webhook')`, [reference, minor])
const reg = (over: Row) => call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'meet@gmail.com', ...over }))

Deno.test('release: GHS 350 standard, GHS 280 with a Foundations certificate, free for an eligible graduate; checkout charges the stored price', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  const std = await reg({ email: 'ama@example.com' })
  assertEquals([std.json.state, std.json.price_ghs, paystack.initialized.at(-1)!.amount], ['checkout', 350, 35000])

  const fnd = await reg({ email: 'efua@example.com', certificate_id: 'bpa-fnd-2026-aaaaaa' })
  assertEquals([fnd.json.price_ghs, fnd.json.price_tier, paystack.initialized.at(-1)!.amount], [280, 'foundations', 28000])
  // A charge of the standard amount against a Foundations attempt is a mismatch, never a confirmation.
  await pay(fnd.json.reference, 35000)
  assertEquals((await regRow('efua@example.com')).status, 'pending_payment')

  const grad = await reg({ email: 'kwame@example.com', certificate_id: 'BPA-TRN-2026-GRAD01' })
  assertEquals([grad.json.state, grad.json.price_ghs, grad.json.price_tier], ['confirmed', 0, 'graduate'])
  assertEquals(paystack.initialized.length, 2, 'no checkout for a complimentary place')
  const g = await regRow('kwame@example.com')
  assertEquals([g.payment_status, g.amount_ghs, g.benefit_credential_id], ['not_required', '0.00', 'BPA-TRN-2026-GRAD01'])
  // The graduate gets the same invitation email as a payer, with no Meet link.
  const m = mail.find((x) => x.to[0] === 'kwame@example.com')!
  assert(m.text.includes('complimentary') && m.text.includes('Google Calendar invitation') && !m.text.includes('meet.google.com'))
})

Deno.test('release: a certificate must belong to the registering email and be currently eligible; nothing is created otherwise', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  for (const [email, cert] of [
    ['someone@example.com', 'BPA-FND-2026-AAAAAA'],   // a public ID, someone else's certificate
    ['revoked@example.com', 'BPA-FND-2026-RRRRRR'],   // revoked
    ['owing@example.com', 'BPA-TRN-2026-OWING1'],     // graduate with an installment still owed
    ['ama@example.com', 'BPA-XXX-0000-NOPE00'],       // not in the register
  ]) {
    const r = await reg({ email, certificate_id: cert })
    assertEquals([r.status, r.json.code], [409, 'benefit_not_matched'], email)
  }
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations`))[0].n, 0)
  assertEquals(paystack.initialized.length, 0)
  // A session that offers no graduate place refuses the claim rather than charging silently.
  await reset({ ...RELEASE, graduate_free: false })
  const r = await reg({ email: 'kwame@example.com', certificate_id: 'BPA-TRN-2026-GRAD01' })
  assertEquals(r.json.code, 'benefit_not_available')
})

Deno.test('release: 25 general places and 5 reserved graduate places are counted apart', opts, async () => {
  await reset({ ...RELEASE, capacity: 1, reserved_graduate_seats: 1 }); await seedRecords()
  const first = await reg({ email: 'ama@example.com' })
  await pay(first.json.reference, 35000)
  assertEquals((await regRow('ama@example.com')).status, 'confirmed')
  // General places are full: a payer and a Foundations holder are both refused...
  assertEquals((await reg({ email: 'kofi@example.com' })).json.code, 'full')
  assertEquals((await reg({ email: 'efua@example.com', certificate_id: 'BPA-FND-2026-AAAAAA' })).json.code, 'full')
  // ...but the reserved graduate place is still there, and only one of them.
  assertEquals((await reg({ email: 'kwame@example.com', certificate_id: 'BPA-TRN-2026-GRAD01' })).json.state, 'confirmed')
  assertEquals((await reg({ email: 'abena@example.com', certificate_id: 'BPA-TRN-2026-GRAD02' })).json.code, 'full')
  // A graduate place never consumes a general one.
  assertEquals((await rows(`select public.workshop_seats_in_use(id) g, public.workshop_graduate_seats_in_use(id) r from public.workshop_sessions`))[0], { g: 1, r: 1 })
})

Deno.test('release: complimentary graduates are invited like payers, and lose it if the entitlement lapses', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  await reg({ email: 'kwame@example.com', certificate_id: 'BPA-TRN-2026-GRAD01', attend_email: 'kwame.meet@gmail.com' })
  await reg({ email: 'abena@example.com', certificate_id: 'BPA-TRN-2026-GRAD02', attend_email: 'abena.meet@gmail.com' })
  const kwame = (await regRow('kwame@example.com')).id, abena = (await regRow('abena@example.com')).id
  assertEquals((await admit(kwame, 'mark_invited')).json.ok, true)
  assertEquals((await regRow('kwame@example.com')).invited_email, 'kwame.meet@gmail.com')
  // Abena's certificate is revoked before she is invited: refused.
  await pg.exec(`update public.credentials set status = 'revoked' where credential_id = 'BPA-TRN-2026-GRAD02'`)
  const refused = await admit(abena, 'mark_invited')
  assertEquals(refused.status, 409)
  assert(refused.json.error.includes('no longer matches an active graduate entitlement'))
  // An unpaid registration still cannot be invited.
  await reg({ email: 'ama@example.com' })
  assertEquals((await admit((await regRow('ama@example.com')).id, 'mark_invited')).status, 409)
})

Deno.test('release: referral codes for eligible graduates only; GHS 50 per qualifying paid registration; paid out once, manually', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  const issue = (credential_id: string) => call(adminAction, '/api/admin/workshops', { action: 'create_referrer', credential_id }, ENV, adminEnv)
  assertEquals((await call(adminAction, '/api/admin/workshops', { action: 'create_referrer', credential_id: 'BPA-TRN-2026-GRAD01' })).status, 403)
  const code = (await issue('BPA-TRN-2026-GRAD01')).json.code
  assert(/^[A-Z2-9]{8}$/.test(code), code)
  assertEquals((await issue('BPA-TRN-2026-GRAD01')).json.code, code, 'one code per graduate')
  for (const c of ['BPA-TRN-2026-OWING1', 'BPA-FND-2026-AAAAAA']) assertEquals((await issue(c)).status, 409, c)

  // Who gets the referral recorded.
  const kofi = await reg({ email: 'kofi@example.com', ref: code.toLowerCase() })                     // a payer: yes
  await reg({ email: 'efua@example.com', certificate_id: 'BPA-FND-2026-AAAAAA', ref: code })          // Foundations payer: yes
  await reg({ email: 'kwame@example.com', ref: code })                                              // the referrer himself: no
  await reg({ email: 'abena@example.com', certificate_id: 'BPA-TRN-2026-GRAD02', ref: code })        // complimentary place: no
  await reg({ email: 'yaw@example.com', ref: 'ZZZZ2222' })                                          // unknown code: no
  const refs = Object.fromEntries((await rows(`select email_normalized e, referral_code c from public.workshop_registrations`)).map((r) => [r.e, r.c]))
  assertEquals(refs, { 'kofi@example.com': code, 'efua@example.com': code, 'kwame@example.com': null, 'abena@example.com': null, 'yaw@example.com': null })

  // Commission only once paid, at the session's GHS 50, recorded once.
  const kofiId = (await regRow('kofi@example.com')).id
  const payout = (reference: string) => call(adminAction, '/api/admin/workshops', { action: 'record_payout', registration_id: kofiId, reference }, ENV, adminEnv)
  assertEquals((await payout('MOMO-REF-1')).status, 409, 'not yet paid: not earned')
  await pay(kofi.json.reference, 35000)
  assertEquals((await payout('MOMO-REF-1')).json.ok, true)
  assertEquals((await payout('MOMO-REF-2')).json.already, true, 'never paid twice')
  const p = await rows(`select amount_ghs, payout_reference from public.workshop_referral_payouts`)
  assertEquals(p, [{ amount_ghs: '50.00', payout_reference: 'MOMO-REF-1' }])
  // A suspended code stops counting for new registrations; existing ones keep their record.
  await call(adminAction, '/api/admin/workshops', { action: 'suspend_referrer', credential_id: 'BPA-TRN-2026-GRAD01' }, ENV, adminEnv)
  await reg({ email: 'esi@example.com', ref: code })
  assertEquals((await regRow('esi@example.com')).referral_code, null)
  // A refund after payout leaves the payout on record for review (the admin shows "review"); nothing is clawed back automatically.
  await pg.query(`select public.workshop_apply_refund(p_reference => $1, p_amount_minor => 35000, p_domain => 'test')`, [kofi.json.reference])
  assert((await regRow('kofi@example.com')).status !== 'confirmed')
  assertEquals((await rows(`select count(*)::int n from public.workshop_referral_payouts`))[0].n, 1)
  // No Paystack split: every checkout went to the one Webinars business key, with no subaccount or split.
  assert(paystack.initialized.every((i) => !('subaccount' in i) && !('split' in i) && !('split_code' in i)))
})
