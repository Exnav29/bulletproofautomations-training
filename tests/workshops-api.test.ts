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
const pg = await loadDatabase([u('./fixtures/payment-ledger.sql'), u('./fixtures/supabase-stubs.sql'),
  u('../supabase/migrations/20261103120000_workshops.sql')])
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
const W01 = { title: 'You know automation. Do you know what to charge?', kind: 'workshop', price_ghs: 250, capacity: 25,
  duration_minutes: 180, time_zone: 'Africa/Accra', format: 'live online', join_instructions: MEET }

async function paidAndConfirmed(email = 'ama@example.com') {
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true, email }))
  await pg.query(`select public.workshop_apply_charge(p_reference => $1, p_amount_minor => 25000, p_currency => 'GHS',
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
    'We have received your payment of GHS 250', 'https://meet.google.com/tst-abcd-xyz', 'johnathan@bulletproofautomations.com',
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
  await pg.query(`select public.workshop_apply_refund(p_reference => $1, p_amount_minor => 25000, p_domain => 'test')`, [r.json.reference])
  const reg = (await rows(`select status from public.workshop_registrations`))[0]
  assert(reg.status !== 'confirmed', 'refunded registration is no longer confirmed: ' + reg.status)
  const out = await dispatchNow()
  assertEquals([out.json.report.emails.sent, out.json.report.emails.skipped], [0, 1])
  assertEquals(mail.length, 0)
  assertEquals((await call(calendar, '/api/workshops/calendar?t=' + r.json.token, null)).status, 404)
})
