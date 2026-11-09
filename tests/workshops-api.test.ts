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
const adminAction = (await import('../functions/api/admin/workshops.js')).onRequestPost

// --- external services ------------------------------------------------------------------
const paystack = { paid: new Map<string, Row>(), initialized: [] as Row[], failInit: false }
const mail: Row[] = []
const meta: Row[] = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const body = init?.body ? JSON.parse(String(init.body)) : null
  if (url.host === 'paystack.mock' || url.host === 'api.paystack.co') {
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
    // This suite runs as a test-mode deployment (sk_test_ key), so its sessions are test sessions.
    format: 'Online, live', price_ghs: 150, status: 'published', is_test: true, join_instructions: 'Zoom link: https://zoom.example/j/1',
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
  await reset({ is_test: false })
  const r = await call(register, '/api/workshops/register', form(), { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_live_webinar_api_suite_only' })
  assertEquals([r.json.state, r.json.checkout], ['pending_payment', 'unavailable'])
  assertEquals((await rows(`select count(*)::int n from public.workshop_payment_attempts`))[0].n, 0)
})

Deno.test('paid: the training business key alone never opens webinar checkout', opts, async () => {
  await reset({ is_test: false })
  const env = { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: undefined }
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true }), env)
  assertEquals([r.json.state, r.json.checkout], ['pending_payment', 'unavailable'])
  assertEquals(paystack.initialized.length, 0)
})

Deno.test('paid: a webinar key equal to the training key is refused (same business = shared webhook)', opts, async () => {
  await reset({ is_test: false })
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

// --- dispatcher, Meta, admin ----------------------------------------------------------

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

Deno.test('Meet: the paid confirmation email has both clocks, the Meet button and the support address, and no calendar file', opts, async () => {
  // 12 December 2026, 11:30 GMT: the real workshop 01 instant.
  await reset({ ...W01, starts_at: '2026-12-12T11:30:00Z' })
  await paidAndConfirmed()
  assertEquals((await dispatchNow()).json.report.emails.sent, 1)
  const m = mail[0]
  assertEquals(m.to, ['ama@example.com'])
  assertEquals(m.subject, "You're registered: You know automation. Do you know what to charge?")
  assert(/Date: Saturday,? 12 December 2026/.test(m.text), 'date')
  for (const want of ['Ghana time: 11:30 AM\u20132:30 PM (GMT)', 'Lagos time: 12:30 PM\u20133:30 PM (WAT)',
    'We have received your payment of GHS 350', 'https://meet.google.com/tst-abcd-xyz', 'johnathan@bulletproofautomations.com']) {
    assert(m.text.includes(want), 'text has ' + want)
  }
  assert(m.html.includes('>Join on Google Meet</a>') && m.html.includes('href="https://meet.google.com/tst-abcd-xyz"'))
  // Calendar links were retired: the email adds no calendar entry, and mints no extra token.
  assert(!(m.text + m.html).includes('calendar.google.com') && !(m.text + m.html).includes('/api/workshops/calendar'))
  assertEquals((await rows(`select count(*)::int n from public.workshop_status_tokens`))[0].n, 1, 'only the browser token')
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
  // Registered but not paid: no email.
  await dispatchNow()
  assert(!mail.some((m) => JSON.stringify(m).includes('meet.google.com')), 'nothing sent to an unpaid registration')
})

Deno.test('Meet: a refund before the email goes out stops it', opts, async () => {
  await reset({ ...W01 })
  const r = await paidAndConfirmed()
  // Refunded in full before the dispatcher ran.
  await pg.query(`select public.workshop_apply_refund(p_reference => $1, p_amount_minor => 35000, p_domain => 'test')`, [r.json.reference])
  const reg = (await rows(`select status from public.workshop_registrations`))[0]
  assert(reg.status !== 'confirmed', 'refunded registration is no longer confirmed: ' + reg.status)
  const out = await dispatchNow()
  assertEquals([out.json.report.emails.sent, out.json.report.emails.skipped], [0, 1])
  assertEquals(mail.length, 0)
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

// --- release 2: prices, referrals, certificate benefits, reserved places ------------------------
// Test records only (PGlite). The shapes mirror production: the public credential
// register, Certificate Studio graduates, PR #54's entitlement table and view, and
// the cohort enrollments and installments the entitlement depends on.

const benefit = (await import('../functions/api/workshops/benefit.js')).onRequestPost
const quote = (await import('../functions/api/workshops/quote.js')).onRequestPost

const RELEASE = { ...W01, price_ghs: 350, capacity: 25, admission: 'invite', reserved_graduate_seats: 5,
  foundations_discount_pct: 20, graduate_free: true, referral_discount_ghs: 50, referral_commission_ghs: 50 }

async function seedRecords() {
  await pg.exec(`truncate public.workshop_referral_payouts, public.workshop_referrers cascade;
    truncate private.studio_graduate_webinar_entitlements, private.studio_graduates, public.credentials,
      public.payment_plan_installments cascade;
    delete from public.enrollments;`)
  await pg.exec(`insert into public.credentials (credential_id, holder_name, holder_email, credential, status) values
    ('BPA-FND-2026-AAAAAA', 'Efua Foundations', 'efua@example.com', 'foundations', 'valid'),
    ('BPA-FND-2026-BBBBBB', 'Esi Foundations', 'esi@example.com', 'foundations', 'valid'),
    ('BPA-FND-2026-RRRRRR', 'Revoked Holder', 'revoked@example.com', 'foundations', 'revoked')`)
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
// A signed charge in the reference's own mode (BPA-WEB- live, BPA-WTEST- test).
const domainOf = (reference: string) => reference.startsWith('BPA-WEB-') ? 'live' : 'test'
const pay = (reference: string, minor: number) => pg.query(`select public.workshop_apply_charge(p_reference => $1,
  p_amount_minor => $2, p_currency => 'GHS', p_domain => $3, p_paid_at => now(), p_via => 'webhook')`, [reference, minor, domainOf(reference)])
const refund = (reference: string, minor: number) => pg.query(`select public.workshop_apply_refund(p_reference => $1, p_amount_minor => $2,
  p_domain => $3)`, [reference, minor, domainOf(reference)])
const activate = (credential_id: string) => adminPost({ action: 'activate_referrer', credential_id })
const reg = (over: Row) => call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'meet@gmail.com', ...over }))
const adminPost = (body: Row) => call(adminAction, '/api/admin/workshops', body, ENV, adminEnv)
const issueCode = (credential_id: string, value = '') => adminPost({ action: 'create_referrer', credential_id, value })
const codeSentTo = (email: string) => {
  const m = [...mail].reverse().find((x) => x.to[0] === email && /verification code/i.test(x.subject))
  return m ? m.text.match(/code is (\d{6})/)![1] : null
}
async function verifyCert(email: string, certificate_id: string) {
  const req = await call(benefit, '/api/workshops/benefit', { step: 'request', slug: 'automate-invoices', email, certificate_id })
  assertEquals(req.json, { ok: true, sent: 'if_eligible' }, 'the same answer whatever the outcome')
  const code = codeSentTo(email)
  if (!code) return null
  const ok = await call(benefit, '/api/workshops/benefit', { step: 'confirm', slug: 'automate-invoices', email, certificate_id, code })
  return ok.json.verification as string
}
const payable = async (email: string) => (await rows(`select public.workshop_commission_payable(r) p from public.workshop_registrations r
  where email_normalized = $1`, [email]))[0].p

Deno.test('release 1-2: standard GHS 350; referral GHS 300 with GHS 50 commission and GHS 250 retained', opts, async () => {
  // Commission is only ever payable on a live sale, so this runs as the live deployment.
  await reset({ ...RELEASE, is_test: false }); await seedRecords()
  const std = await liveReg({ email: 'ama@example.com', expected_price: 350 })
  assertEquals([std.json.state, std.json.price_ghs, paystack.initialized.at(-1)!.amount], ['checkout', 350, 35000])
  await pay(std.json.reference, 35000)
  assertEquals([(await regRow('ama@example.com')).status, (await regRow('ama@example.com')).commission_ghs], ['confirmed', '0.00'])

  assertEquals((await issueCode('BPA-TRN-2026-GRAD01', 'KWAME50')).json.code, 'KWAME50')
  await activate('BPA-TRN-2026-GRAD01')
  const q = await call(quote, '/api/workshops/quote', { slug: 'automate-invoices', email: 'kofi@example.com', ref: 'kwame50' }, LIVE)
  assertEquals([q.json.list_price_ghs, q.json.discount_kind, q.json.discount_ghs, q.json.price_ghs], [350, 'referral', 50, 300])
  const kofi = await liveReg({ email: 'kofi@example.com', ref: 'kwame50', expected_price: 300 })
  assertEquals([kofi.json.price_ghs, kofi.json.discount_kind, paystack.initialized.at(-1)!.amount], [300, 'referral', 30000])
  await pay(kofi.json.reference, 30000)
  const r = await regRow('kofi@example.com')
  assertEquals([r.status, r.list_price_ghs, r.discount_ghs, r.amount_ghs, r.referral_code, r.commission_ghs],
    ['confirmed', '350.00', '50.00', '300.00', 'KWAME50', '50.00'])
  assertEquals(await payable('kofi@example.com'), true)
  assertEquals((await adminPost({ action: 'record_payout', registration_id: r.id, value: 'MOMO-1' })).json.ok, true)
  const p = (await rows(`select amount_ghs from public.workshop_referral_payouts`))[0]
  assertEquals([p.amount_ghs, 300 - Number(p.amount_ghs)], ['50.00', 250], 'GHS 250 retained before fees')
  // The confirmation, sent by the dispatcher, names the discount.
  await dispatchNow()
  assert(mail.some((m) => m.to[0] === 'kofi@example.com' && m.text.includes('GHS 300, with a GHS 50 referral discount')))
})

Deno.test('release 3-4, 7: Foundations GHS 280; Foundations plus referral is still GHS 280 (never 230) with GHS 50 commission', opts, async () => {
  await reset({ ...RELEASE, is_test: false }); await seedRecords()
  await issueCode('BPA-TRN-2026-GRAD01', 'KWAME50'); await activate('BPA-TRN-2026-GRAD01')
  const t1 = await verifyCert('efua@example.com', 'BPA-FND-2026-AAAAAA')
  assert(t1)
  const efua = await liveReg({ email: 'efua@example.com', verification: t1, expected_price: 280 })
  assertEquals([efua.json.price_ghs, efua.json.discount_kind, paystack.initialized.at(-1)!.amount], [280, 'foundations', 28000])
  assertEquals((await regRow('efua@example.com')).commission_ghs, '0.00')

  const t2 = await verifyCert('esi@example.com', 'BPA-FND-2026-BBBBBB')
  const q = await call(quote, '/api/workshops/quote', { slug: 'automate-invoices', email: 'esi@example.com', ref: 'KWAME50', verification: t2 }, LIVE)
  assertEquals([q.json.price_ghs, q.json.discount_kind, q.json.discount_ghs, q.json.referral], [280, 'foundations', 70, 'applied'])
  const esi = await liveReg({ email: 'esi@example.com', ref: 'KWAME50', verification: t2, expected_price: 280 })
  assertEquals([esi.json.price_ghs, paystack.initialized.at(-1)!.amount], [280, 28000], 'the larger discount, not both')
  await pay(esi.json.reference, 28000)
  const r = await regRow('esi@example.com')
  assertEquals([r.discount_kind, r.discount_ghs, r.referral_code, r.commission_ghs], ['foundations', '70.00', 'KWAME50', '50.00'])
  assertEquals(await payable('esi@example.com'), true)
  assertEquals(280 - Number(r.commission_ghs), 230, 'GHS 230 retained before fees')
})

Deno.test('release 5: an eligible graduate attends free, uses a reserved place, earns no commission and is invited like a payer', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  await issueCode('BPA-TRN-2026-GRAD01', 'KWAME50')
  const t = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  const g = await reg({ email: 'abena@example.com', ref: 'KWAME50', verification: t, expected_price: 0, attend_email: 'abena.meet@gmail.com' })
  assertEquals([g.json.state, g.json.price_ghs, g.json.price_tier], ['confirmed', 0, 'graduate'])
  assertEquals(paystack.initialized.length, 0, 'no checkout')
  const r = await regRow('abena@example.com')
  assertEquals([r.payment_status, r.referral_code, r.commission_ghs, r.benefit_credential_id], ['not_required', null, '0.00', 'BPA-TRN-2026-GRAD02'])
  assert(mail.some((m) => m.to[0] === 'abena@example.com' && m.text.includes('complimentary') && !m.text.includes('meet.google.com')))
  assertEquals((await admit(r.id, 'mark_invited')).json.ok, true)
  // Entitlement lapses (an installment reopened) before a second graduate is invited: refused.
  await pg.exec(`update public.payment_plan_installments set status = 'sent' where installment_number = 2
    and enrollment_id = (select enrollment_id from public.credentials where credential_id = 'BPA-TRN-2026-GRAD02')`)
  await admit(r.id, 'mark_removed')
  assertEquals((await admit(r.id, 'mark_invited')).status, 409)
})

Deno.test('release 6: Paystack and the webhook enforce the price; a client-sent amount or a changed price is never charged', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  await issueCode('BPA-TRN-2026-GRAD01', 'KWAME50')
  // The page showed 350 but the code makes it 300: refused so the customer re-quotes.
  const stale = await reg({ email: 'kofi@example.com', ref: 'KWAME50', expected_price: 350 })
  assertEquals([stale.status, stale.json.code, stale.json.price_ghs], [409, 'price_changed', 300])
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations`))[0].n, 0)
  // Injected amounts are ignored; Paystack is asked for the stored price.
  const r = await reg({ email: 'kofi@example.com', ref: 'KWAME50', expected_price: 300, amount_ghs: 1, price_ghs: 1, amount: 100 })
  assertEquals(paystack.initialized.at(-1)!.amount, 30000)
  // The webhook path (workshop_apply_charge) holds any other amount for review.
  await pay(r.json.reference, 35000)
  const held = await regRow('kofi@example.com')
  assert(held.status !== 'confirmed' && held.payment_status === 'needs_review', held.status + '/' + held.payment_status)
  assertEquals(await payable('kofi@example.com'), false)
})

Deno.test('release 8: unknown, expired, suspended, self and lapsed-referrer codes are rejected', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  await issueCode('BPA-TRN-2026-GRAD01', 'KWAME50')
  await issueCode('BPA-TRN-2026-GRAD02', 'ABENA50')
  // Codes are never certificate numbers, and owing graduates get none.
  assertEquals((await issueCode('BPA-TRN-2026-GRAD02', 'GRAD02X')).json.code, 'ABENA50', 'one code per graduate')
  await pg.exec(`delete from public.workshop_referrers where code = 'ABENA50'`)
  assertEquals((await issueCode('BPA-TRN-2026-GRAD02', 'XGRAD02')).status, 409, 'contains the certificate number')
  await issueCode('BPA-TRN-2026-GRAD02', 'ABENA50')
  assertEquals((await issueCode('BPA-TRN-2026-OWING1')).status, 409)
  const bad = async (email: string, ref: string) => {
    const r = await reg({ email, ref, expected_price: 300 })
    assertEquals([r.status, r.json.code], [409, 'referral_invalid'], ref + ' ' + email)
    const q = await call(quote, '/api/workshops/quote', { slug: 'automate-invoices', email, ref })
    assertEquals(q.json.code, 'referral_invalid')
  }
  await bad('a@example.com', 'NOSUCHCODE')
  await pg.exec(`update public.workshop_referrers set expires_at = now() - interval '1 minute' where code = 'KWAME50'`)
  await bad('b@example.com', 'KWAME50')
  await pg.exec(`update public.workshop_referrers set expires_at = null where code = 'KWAME50'`)
  await adminPost({ action: 'suspend_referrer', credential_id: 'BPA-TRN-2026-GRAD01' })
  await bad('c@example.com', 'KWAME50')
  await bad('abena@example.com', 'ABENA50')            // the referrer's own email
  await pg.exec(`update public.credentials set status = 'revoked' where credential_id = 'BPA-TRN-2026-GRAD02'`)
  await bad('d@example.com', 'ABENA50')                // referrer no longer eligible
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations`))[0].n, 0)
  assertEquals(paystack.initialized.length, 0)
})

Deno.test('release 9: certificate claims need the one-time code from the certificate email; sharing, guessing and replay fail', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  // Someone else's (public) certificate ID with my email: same answer, no code sent anywhere.
  mail.length = 0
  assertEquals(await verifyCert('me@example.com', 'BPA-FND-2026-AAAAAA'), null)
  assertEquals(await verifyCert('revoked@example.com', 'BPA-FND-2026-RRRRRR'), null)
  assertEquals(await verifyCert('owing@example.com', 'BPA-TRN-2026-OWING1'), null)
  assertEquals(mail.length, 0)
  // A certificate ID alone, with no token, gives no benefit.
  const plain = await reg({ email: 'efua@example.com', certificate_id: 'BPA-FND-2026-AAAAAA', expected_price: 350 })
  assertEquals(plain.json.price_ghs, 350)
  await reset({ ...RELEASE }); await seedRecords()
  // Guessing: five wrong codes burn the request.
  await call(benefit, '/api/workshops/benefit', { step: 'request', slug: 'automate-invoices', email: 'efua@example.com', certificate_id: 'BPA-FND-2026-AAAAAA' })
  const real = codeSentTo('efua@example.com')!
  const wrong = real === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) {
    const r = await call(benefit, '/api/workshops/benefit', { step: 'confirm', slug: 'automate-invoices', email: 'efua@example.com', certificate_id: 'BPA-FND-2026-AAAAAA', code: wrong })
    assertEquals(r.json.ok, false)
  }
  const late = await call(benefit, '/api/workshops/benefit', { step: 'confirm', slug: 'automate-invoices', email: 'efua@example.com', certificate_id: 'BPA-FND-2026-AAAAAA', code: real })
  assertEquals(late.json.ok, false, 'the right code after five misses is refused')
  // Throttle: a fourth request in an hour sends nothing.
  mail.length = 0
  for (let i = 0; i < 3; i++) await call(benefit, '/api/workshops/benefit', { step: 'request', slug: 'automate-invoices', email: 'efua@example.com', certificate_id: 'BPA-FND-2026-AAAAAA' })
  assertEquals(mail.filter((m) => m.to[0] === 'efua@example.com').length, 2, '3 requests an hour, the first already used')
  await pg.exec(`update public.workshop_benefit_verifications set created_at = now() - interval '2 hours'`)
  // A token works once, for its own email only.
  const t = (await verifyCert('esi@example.com', 'BPA-FND-2026-BBBBBB'))!
  assertEquals((await reg({ email: 'someone@example.com', verification: t, expected_price: 280 })).json.code, 'benefit_not_valid', 'bound to the email')
  assertEquals((await reg({ email: 'esi@example.com', verification: t, expected_price: 280 })).json.price_ghs, 280)
  assertEquals((await reg({ email: 'esi2@example.com', verification: t, expected_price: 280 })).json.code, 'benefit_not_valid', 'replay')
  // The certificate cannot be redeemed twice for the session, even with a fresh code.
  mail.length = 0
  assertEquals(await verifyCert('esi@example.com', 'BPA-FND-2026-BBBBBB'), null)
  // Recovery: the admin authorises a new address for one certificate and session.
  assertEquals((await adminPost({ action: 'grant_email', credential_id: 'BPA-FND-2026-AAAAAA', email: 'efua.new@example.com',
    session: 'automate-invoices', value: 'Called Efua on her recorded WhatsApp' })).json.ok, true)
  const tn = await verifyCert('efua.new@example.com', 'BPA-FND-2026-AAAAAA')
  assert(tn, 'the authorised address receives the code')
  assertEquals((await reg({ email: 'efua.new@example.com', verification: tn!, expected_price: 280 })).json.price_ghs, 280)
})

Deno.test('release 10: general places full while a reserved graduate place remains; reserved places never go to anyone else', opts, async () => {
  await reset({ ...RELEASE, capacity: 1, reserved_graduate_seats: 1 }); await seedRecords()
  const first = await reg({ email: 'ama@example.com', expected_price: 350 })
  await pay(first.json.reference, 35000)
  const s1 = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assertEquals([s1.json.open, s1.json.status, s1.json.general_full, s1.json.graduate_places_open], [true, 'graduates_only', true, true])
  assert(!/"(capacity|seats|remaining)"/.test(s1.text), 'no seat counter')
  assertEquals((await reg({ email: 'kofi@example.com', expected_price: 350 })).json.code, 'full')
  const tf = await verifyCert('efua@example.com', 'BPA-FND-2026-AAAAAA')
  assertEquals((await reg({ email: 'efua@example.com', verification: tf, expected_price: 280 })).json.code, 'full', 'a discount is not a reserved place')
  const tg = await verifyCert('kwame@example.com', 'BPA-TRN-2026-GRAD01')
  assertEquals((await reg({ email: 'kwame@example.com', verification: tg, expected_price: 0 })).json.state, 'confirmed')
  const s2 = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assertEquals([s2.json.open, s2.json.status], [false, 'full'])
  const ta = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  assertEquals((await reg({ email: 'abena@example.com', verification: ta, expected_price: 0 })).json.code, 'full', 'the reserved places are used up')
  assertEquals((await rows(`select public.workshop_seats_in_use(id) g, public.workshop_graduate_seats_in_use(id) r from public.workshop_sessions`))[0], { g: 1, r: 1 })
})

Deno.test('release 11: no commission on a refunded or duplicate purchase; a refund after payout is flagged, not clawed back', opts, async () => {
  await reset({ ...RELEASE, is_test: false }); await seedRecords()
  await issueCode('BPA-TRN-2026-GRAD01', 'KWAME50'); await activate('BPA-TRN-2026-GRAD01')
  // Refunded before payout: never payable.
  const a = await liveReg({ email: 'a@example.com', ref: 'KWAME50', expected_price: 300 })
  await pay(a.json.reference, 30000)
  await refund(a.json.reference, 30000)
  assertEquals(await payable('a@example.com'), false)
  assertEquals((await adminPost({ action: 'record_payout', registration_id: (await regRow('a@example.com')).id, value: 'MOMO-A' })).status, 409)
  // Duplicate payment: not payable while the extra money is held.
  const b = await liveReg({ email: 'b@example.com', ref: 'KWAME50', expected_price: 300 })
  await pay(b.json.reference, 30000)
  const again = await liveReg({ email: 'b@example.com', ref: 'KWAME50', expected_price: 300 })
  await pg.query(`insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, currency, mode)
    values ($1, 'BPA-WEB-2026-DUPLICATE1', 30000, 'GHS', 'live')`, [(await regRow('b@example.com')).id])
  await pay('BPA-WEB-2026-DUPLICATE1', 30000)
  assertEquals((await regRow('b@example.com')).payment_status, 'needs_review')
  assertEquals(await payable('b@example.com'), false)
  assertEquals(again.json.registration, 'existing')
  // Paid out, then refunded: the payout stays on record, the commission is no longer payable, the admin reviews it.
  const c = await liveReg({ email: 'c@example.com', ref: 'KWAME50', expected_price: 300 })
  await pay(c.json.reference, 30000)
  const cid = (await regRow('c@example.com')).id
  assertEquals((await adminPost({ action: 'record_payout', registration_id: cid, value: 'MOMO-C' })).json.ok, true)
  assertEquals((await adminPost({ action: 'record_payout', registration_id: cid, value: 'MOMO-C2' })).json.already, true, 'paid once')
  await refund(c.json.reference, 30000)
  assertEquals(await payable('c@example.com'), false)
  assertEquals((await rows(`select count(*)::int n from public.workshop_referral_payouts where registration_id = $1`, [cid]))[0].n, 1)
  // A voided (fraudulent) sale is not payable either.
  const d = await liveReg({ email: 'd@example.com', ref: 'KWAME50', expected_price: 300 })
  await pay(d.json.reference, 30000)
  await adminPost({ action: 'void_commission', registration_id: (await regRow('d@example.com')).id, value: 'Card reported stolen' })
  assertEquals(await payable('d@example.com'), false)
  assert(paystack.initialized.every((i) => !('subaccount' in i) && !('split' in i) && !('split_code' in i)), 'no Paystack split')
})

// --- release 2 corrections: test isolation --------------------------------------------------
// A live deployment, simulated: a live key with live checkout on. A live key always talks to
// api.paystack.co, which the fetch stand-in above intercepts, so nothing leaves this machine.
const LIVE: Row = { ...ENV, WORKSHOP_PAYSTACK_SECRET_KEY: 'sk_live_webinar_api_suite_only', WORKSHOP_PAID_CHECKOUT: 'on' }
const liveReg = (over: Row) => call(register, '/api/workshops/register', form({ attend_email: 'meet@gmail.com', ...over }), LIVE)
const REHEARSAL = { slug: 'rehearsal-what-to-charge', is_test: true, calendar_event_id: 'rehearsalevent01' }
async function addSession(over: Row) {
  const row = { ...RELEASE, title: 'Rehearsal', format: 'Online, live', status: 'published', duration_minutes: 180,
    starts_at: new Date(Date.now() + 5 * 86400000).toISOString(), ...over }
  const keys = Object.keys(row)
  await pg.query(`insert into public.workshop_sessions (${keys.join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
    keys.map((k) => (row as Row)[k]))
}
const seats = async (slug: string) => (await rows(`select public.workshop_seats_in_use(id) g, public.workshop_graduate_seats_in_use(id) r
  from public.workshop_sessions where slug = $1`, [slug]))[0]

Deno.test('isolation: a test-mode deployment cannot see, register on, hold or pay for a live workshop', opts, async () => {
  await reset({ ...RELEASE, is_test: false }); await seedRecords()
  // The Preview deployment (test key) and the live workshop.
  const s = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assertEquals(s.status, 404)
  assertEquals((await call(quote, '/api/workshops/quote', { slug: 'automate-invoices', email: 'ama@example.com' })).status, 404)
  const r = await reg({ email: 'ama@example.com', expected_price: 350 })
  assertEquals([r.status, r.json.code], [409, 'closed'])
  // The free graduate path, which takes no payment, is refused the same way.
  const t = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  assertEquals((await reg({ email: 'abena@example.com', verification: t, expected_price: 0 })).json.code, 'closed')
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations`))[0].n, 0)
  assertEquals(await seats('automate-invoices'), { g: 0, r: 0 })
  assertEquals(paystack.initialized.length, 0)
  // Below the Pages Functions: a test checkout on a live registration is refused by the database.
  const live = await liveReg({ email: 'kofi@example.com', expected_price: 350 })
  assertEquals(live.json.state, 'checkout')
  const out = (await rows(`select public.workshop_start_attempt($1, 'BPA-WTEST-2026-ABCDEFGHIJ', 'test') o`, [(await regRow('kofi@example.com')).id]))[0].o
  assertEquals(out.outcome, 'mode_not_allowed')
  assertEquals((await rows(`select count(*)::int n from public.workshop_payment_attempts where mode = 'test'`))[0].n, 0)
})

Deno.test('isolation: a live deployment cannot register on a test session; test registrations never use live places', opts, async () => {
  await reset({ ...RELEASE, is_test: false, capacity: 2, reserved_graduate_seats: 1 }); await seedRecords()
  await addSession({ ...REHEARSAL, capacity: 2, reserved_graduate_seats: 1 })
  // The production deployment cannot see or book the rehearsal session.
  assertEquals((await call(session, '/api/workshops/session?slug=rehearsal-what-to-charge', null, LIVE)).status, 404)
  assertEquals((await liveReg({ slug: 'rehearsal-what-to-charge', email: 'x@example.com', expected_price: 350 })).json.code, 'closed')
  // Fill the rehearsal session completely, general and reserved, in test mode.
  for (const email of ['t1@example.com', 't2@example.com']) {
    const t = await reg({ slug: 'rehearsal-what-to-charge', email, expected_price: 350 })
    await pay(t.json.reference, 35000)
  }
  const tg = await call(benefit, '/api/workshops/benefit', { step: 'request', slug: 'rehearsal-what-to-charge', email: 'abena@example.com', certificate_id: 'BPA-TRN-2026-GRAD02' })
  assertEquals(tg.json.ok, true)
  const code = codeSentTo('abena@example.com')!
  const tok = (await call(benefit, '/api/workshops/benefit', { step: 'confirm', slug: 'rehearsal-what-to-charge', email: 'abena@example.com', certificate_id: 'BPA-TRN-2026-GRAD02', code })).json.verification
  assertEquals((await reg({ slug: 'rehearsal-what-to-charge', email: 'abena@example.com', verification: tok, expected_price: 0 })).json.state, 'confirmed')
  assertEquals(await seats('rehearsal-what-to-charge'), { g: 2, r: 1 })
  // The live workshop is untouched: every place still free, and both kinds still bookable.
  assertEquals(await seats('automate-invoices'), { g: 0, r: 0 })
  const live = await call(session, '/api/workshops/session?slug=automate-invoices', null, LIVE)
  assertEquals([live.json.status, live.json.general_full, live.json.graduate_places_open], ['open', false, true])
  // A graduate who rehearsed can still redeem the same certificate on the live workshop.
  const t2 = await call(benefit, '/api/workshops/benefit', { step: 'request', slug: 'automate-invoices', email: 'abena@example.com', certificate_id: 'BPA-TRN-2026-GRAD02' })
  assertEquals(t2.json.ok, true)
  const code2 = codeSentTo('abena@example.com')!
  const tok2 = (await call(benefit, '/api/workshops/benefit', { step: 'confirm', slug: 'automate-invoices', email: 'abena@example.com', certificate_id: 'BPA-TRN-2026-GRAD02', code: code2 })).json.verification
  assertEquals((await liveReg({ email: 'abena@example.com', verification: tok2, expected_price: 0 })).json.state, 'confirmed')
  assertEquals(await seats('automate-invoices'), { g: 0, r: 1 })
  // Test rows are identified by the database itself.
  const flags = await rows(`select r.email_normalized e, public.workshop_is_test_registration(r.id) t from public.workshop_registrations r
    join public.workshop_sessions s on s.id = r.session_id order by s.slug, r.email_normalized`)
  assertEquals(flags.map((f) => f.t), [false, true, true, true])
})

Deno.test('isolation: a commission on a test registration can never be paid, by any route', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  await issueCode('BPA-TRN-2026-GRAD01', 'KWAME50')
  const t = await reg({ email: 'kofi@example.com', ref: 'KWAME50', expected_price: 300 })
  await pay(t.json.reference, 30000)
  const r = await regRow('kofi@example.com')
  assertEquals([r.status, r.payment_status, r.commission_ghs], ['confirmed', 'paid', '50.00'], 'otherwise a qualifying sale')
  assertEquals(await payable('kofi@example.com'), false)
  // The admin endpoint.
  const viaAdmin = await adminPost({ action: 'record_payout', registration_id: r.id, value: 'MOMO-1' })
  assertEquals(viaAdmin.status, 409)
  assert(viaAdmin.json.error.includes('test registration'))
  // The database function, called directly.
  const viaRpc = (await rows(`select public.workshop_admin_referral('johnathan@bulletproofautomations.com', 'record_payout',
    p_registration_id => $1, p_value => 'MOMO-2') o`, [r.id]))[0].o
  assertEquals(viaRpc, { ok: false, error: 'test_registration' })
  // A direct insert into the payouts table, as the service role could do through the REST API.
  let refused = ''
  try {
    await pg.query(`insert into public.workshop_referral_payouts (registration_id, referrer_id, amount_ghs, payout_reference, recorded_by)
      values ($1, $2, 50, 'MOMO-3', 'sql')`, [r.id, r.referrer_id])
  } catch (e) { refused = String((e as Error).message) }
  assert(refused.includes('test registration'), refused)
  assertEquals((await rows(`select count(*)::int n from public.workshop_referral_payouts`))[0].n, 0)
  // A live sale becomes test, and unpayable, the moment any test checkout is recorded against it.
  await activate('BPA-TRN-2026-GRAD01')
  await addSession({ slug: 'live-twin', is_test: false, calendar_event_id: 'livetwinevent01' })
  const lr = await liveReg({ slug: 'live-twin', email: 'esi@example.com', ref: 'KWAME50', expected_price: 300 })
  await pay(lr.json.reference, 30000)
  assertEquals(await payable('esi@example.com'), true)
  await pg.query(`insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, currency, mode)
    values ($1, 'BPA-WTEST-2026-STRAYTEST1', 30000, 'GHS', 'test')`, [(await regRow('esi@example.com')).id])
  assertEquals(await payable('esi@example.com'), false)
  assertEquals((await adminPost({ action: 'record_payout', registration_id: (await regRow('esi@example.com')).id, value: 'MOMO-4' })).status, 409)
})

Deno.test('isolation: is_test is fixed once a session has registrations; no two sessions share a Calendar event', opts, async () => {
  await reset({ ...RELEASE, calendar_event_id: 'realevent01' }); await seedRecords()
  await reg({ email: 'ama@example.com', expected_price: 350 })
  let msg = ''
  try { await pg.exec(`update public.workshop_sessions set is_test = false where slug = 'automate-invoices'`) } catch (e) { msg = String((e as Error).message) }
  assert(msg.includes('is_test cannot change'), msg)
  msg = ''
  try { await addSession({ slug: 'second', is_test: false, calendar_event_id: 'realevent01' }) } catch (e) { msg = String((e as Error).message) }
  assert(msg.includes('workshop_sessions_calendar_event_once'), msg)
  // A session with no registrations can still be reclassified (set up before it opens).
  await addSession({ slug: 'empty', is_test: false, calendar_event_id: 'emptyevent01' })
  await pg.exec(`update public.workshop_sessions set is_test = true where slug = 'empty'`)
})

Deno.test('referral codes are issued prepared: rehearsal only until activated, for links and typed codes alike', opts, async () => {
  await reset({ ...RELEASE, is_test: false }); await seedRecords()
  await addSession(REHEARSAL)
  const issued = await issueCode('BPA-TRN-2026-GRAD01', 'KWAME50')
  assertEquals([issued.json.code, issued.json.status], ['KWAME50', 'prepared'])
  const liveQuote = () => call(quote, '/api/workshops/quote', { slug: 'automate-invoices', email: 'kofi@example.com', ref: 'KWAME50' }, LIVE)
  const testQuote = () => call(quote, '/api/workshops/quote', { slug: 'rehearsal-what-to-charge', email: 'kofi@example.com', ref: 'KWAME50' })
  // Prepared: works on the rehearsal session, refused on the live workshop.
  assertEquals((await testQuote()).json.price_ghs, 300)
  assertEquals((await liveQuote()).json.code, 'referral_invalid')
  assertEquals((await liveReg({ email: 'kofi@example.com', ref: 'KWAME50', expected_price: 300 })).json.code, 'referral_invalid')
  // A typed code and a link both arrive as the same field; a typed lower-case code is accepted.
  assertEquals((await reg({ slug: 'rehearsal-what-to-charge', email: 'kofi@example.com', ref: 'kwame50', expected_price: 300 })).json.price_ghs, 300)
  // Activated: valid on the live workshop.
  assertEquals((await adminPost({ action: 'activate_referrer', credential_id: 'BPA-TRN-2026-GRAD01' })).json.ok, true)
  assertEquals((await liveQuote()).json.price_ghs, 300)
  // Suspended: valid nowhere.
  await adminPost({ action: 'suspend_referrer', credential_id: 'BPA-TRN-2026-GRAD01' })
  assertEquals([(await liveQuote()).json.code, (await testQuote()).json.code], ['referral_invalid', 'referral_invalid'])
})
