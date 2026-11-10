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
  u('../supabase/migrations/20261103120000_workshops.sql'), u('../supabase/migrations/20261109120000_workshop_admission_benefits.sql'),
  u('../supabase/migrations/20261110120000_workshop_calendar_sync.sql'), u('../supabase/migrations/20261111120000_workshop_waitlist.sql'),
  u('../supabase/migrations/20261112120000_workshop_audit_corrections.sql')])
const DB = serveDatabase(pg, 54341)

const register = (await import('../functions/api/workshops/register.js')).onRequestPost
const status = (await import('../functions/api/workshops/status.js')).onRequestPost
const session = (await import('../functions/api/workshops/session.js')).onRequestGet
const dispatch = (await import('../functions/api/workshops/dispatch.js')).onRequestPost
const adminAction = (await import('../functions/api/admin/workshops.js')).onRequestPost

// --- external services ------------------------------------------------------------------
const paystack = { paid: new Map<string, Row>(), initialized: [] as Row[], failInit: false }
// Google Calendar stand-in: the event's guest list and etag, and every write made to it.
const gcal = { events: new Map<string, Row>(), patches: [] as Row[], tokenFails: false, failNext: [] as number[],
  // Each GET of an event waits on the next gate, if any, so a test can pause dispatcher runs in a chosen order.
  gates: [] as Promise<void>[], paused: 0 }
const mail: Row[] = []
// Latency of the mail API, in ms. Real sends take time; that is the window two dispatcher runs race in.
let mailDelayMs = 0
const meta: Row[] = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  // JSON for every service here except Google's token endpoint, which is form-encoded.
  let body: any = null
  try { body = init?.body ? JSON.parse(String(init.body)) : null } catch (_) { body = null }
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
  if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
    const form = new URLSearchParams(String(init?.body))
    const good = !gcal.tokenFails && form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'google-refresh-for-tests'
    return good ? Response.json({ access_token: 'google-access', expires_in: 3599 }) : Response.json({ error: 'invalid_grant' }, { status: 400 })
  }
  if (url.host === 'www.googleapis.com') {
    const m = url.pathname.match(/^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/)
    if (!m || (init?.headers as Row)?.Authorization !== 'Bearer google-access') return new Response('no', { status: 401 })
    if (gcal.failNext.length) return new Response('{}', { status: gcal.failNext.shift() })
    const ev = gcal.events.get(decodeURIComponent(m[1]))
    if (!ev) return new Response('{}', { status: 404 })
    if ((init?.method ?? 'GET') === 'GET') {
      const gate = gcal.gates.shift()
      if (gate) { gcal.paused += 1; await gate }
      return Response.json({ etag: ev.etag, attendees: ev.attendees })
    }
    if ((init?.headers as Row)['If-Match'] !== ev.etag) return new Response('{}', { status: 412 })
    const body = JSON.parse(String(init!.body))
    gcal.patches.push({ event: m[1], sendUpdates: url.searchParams.get('sendUpdates'), emails: body.attendees.map((a: Row) => a.email) })
    ev.attendees = body.attendees; ev.etag = '"' + (Number(ev.etag.replace(/"/g, '')) + 1) + '"'
    return Response.json({ etag: ev.etag, attendees: ev.attendees })
  }
  if (url.host === 'api.mail.hostinger.com') {
    if (url.pathname.endsWith('/me')) {
      return Response.json({ data: { mailboxes: [{ address: 'johnathan@bulletproofautomations.com', resourceId: 'box1' }] } })
    }
    if (mailDelayMs) await new Promise((r) => setTimeout(r, mailDelayMs))
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
  // Automatic Google Calendar invitations (functions/api/_calendar.js), against the stand-in above.
  GOOGLE_CALENDAR_CLIENT_ID: 'client-for-tests', GOOGLE_CALENDAR_CLIENT_SECRET: 'secret-for-tests',
  GOOGLE_CALENDAR_REFRESH_TOKEN: 'google-refresh-for-tests',
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
    starts_at: new Date(Date.now() + 10 * 86400000).toISOString(), ...over }
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
  const first = await call(register, '/api/workshops/register', form())
  // The same browser, holding the token its first registration was given.
  const again = await call(register, '/api/workshops/register', form({ email: 'AMA@example.com ', token: first.json.token }))
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
  const r = await call(register, '/api/workshops/register', form({ testOptIn: true, amount: 1, price_ghs: 1, token: plain.json.token }))
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
  const second = await call(register, '/api/workshops/register', form({ testOptIn: true, token: first.json.token }))
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
async function dispatchNow(env: Row = ENV) {
  const secret = 'dispatch-secret-for-tests'
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))))
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  await pg.query(`insert into public.workshop_dispatch_config (secret_hash) values ($1) on conflict do nothing`, [hash])
  return call(dispatch, '/api/workshops/dispatch', {}, env, { 'x-workshop-dispatch': secret })
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
  const first = await call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'Ama.Meet@Gmail.com ' }))
  assertEquals((await regRow()).attend_email, 'ama.meet@gmail.com')
  // Even from the browser that holds the registration's token.
  const again = await call(register, '/api/workshops/register', form({ testOptIn: true, attend_email: 'intruder@gmail.com', token: first.json.token }))
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
  const again = await liveReg({ email: 'b@example.com', ref: 'KWAME50', expected_price: 300, token: b.json.token })
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
    starts_at: new Date(Date.now() + 10 * 86400000).toISOString(), ...over }
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

// --- automatic Google Calendar invitations (release 3) ---------------------------------------
// The real dispatcher, admin endpoint, payment and refund RPCs and database rules, against the
// Google Calendar stand-in. Each test's event starts with the host on it, who must never be removed.
const EVENT = 'w01event0001'
const HOST = { email: 'host@bulletproofautomations.com', organizer: true, responseStatus: 'accepted' }
async function inviteSession(over: Row = {}) {
  await reset({ ...RELEASE, calendar_event_id: EVENT, ...over }); await seedRecords()
  gcal.events.clear(); gcal.patches.length = 0; gcal.tokenFails = false; gcal.failNext.length = 0
  gcal.events.set(EVENT, { etag: '"1"', attendees: [HOST] })
}
const guests = () => gcal.events.get(EVENT)!.attendees.map((a: Row) => a.email)
const paidTest = async (email: string, attend: string) => {
  const r = await reg({ email, attend_email: attend, expected_price: 350 })
  await pay(r.json.reference, 35000)
  return r
}

Deno.test('calendar: a confirmed payment is invited automatically, once, keeping everyone else on the event', opts, async () => {
  await inviteSession()
  const r = await paidTest('ama@example.com', 'ama.meet@gmail.com')
  const out = await dispatchNow()
  assertEquals(out.json.report.calendar, { added: 1, removed: 0, failed: 0, blocked: 0 })
  assertEquals(guests(), ['host@bulletproofautomations.com', 'ama.meet@gmail.com'])
  assertEquals(gcal.patches, [{ event: EVENT, sendUpdates: 'all', emails: ['host@bulletproofautomations.com', 'ama.meet@gmail.com'] }],
    'one update, and Google sends the invitation (sendUpdates=all)')
  const row = await regRow('ama@example.com')
  assertEquals([row.invited_email, row.calendar_sync_failures, row.calendar_sync_error], ['ama.meet@gmail.com', 0, null])
  assert(/calendar-sync added \(ama\.meet@gmail\.com\)/.test(row.admin_notes))
  // Duplicates change nothing: the same webhook delivered again, and the dispatcher run again.
  await pay(r.json.reference, 35000)
  assertEquals((await dispatchNow()).json.report.calendar, { added: 0, removed: 0, failed: 0, blocked: 0 })
  assertEquals([gcal.patches.length, guests().length], [1, 2])
})

Deno.test('calendar: unpaid and not-yet-confirmed registrations are never invited', opts, async () => {
  await inviteSession()
  await reg({ email: 'unpaid@example.com', attend_email: 'unpaid.meet@gmail.com', expected_price: 350 })
  await dispatchNow()
  assertEquals([gcal.patches.length, guests()], [0, ['host@bulletproofautomations.com']])
})

Deno.test('calendar: a complimentary Intermediate graduate place is invited automatically', opts, async () => {
  await inviteSession()
  const t = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  const g = await reg({ email: 'abena@example.com', verification: t, expected_price: 0, attend_email: 'abena.meet@gmail.com' })
  assertEquals([g.json.state, g.json.price_tier], ['confirmed', 'graduate'])
  await dispatchNow()
  assert(guests().includes('abena.meet@gmail.com'))
  assertEquals((await regRow('abena@example.com')).invited_email, 'abena.meet@gmail.com')
})

Deno.test('calendar: a full refund removes the invitation, and Google tells the guest', opts, async () => {
  await inviteSession()
  const r = await paidTest('ama@example.com', 'ama.meet@gmail.com')
  await dispatchNow()
  await refund(r.json.reference, 35000)
  assertEquals((await dispatchNow()).json.report.calendar, { added: 0, removed: 1, failed: 0, blocked: 0 })
  assertEquals(guests(), ['host@bulletproofautomations.com'])
  assertEquals(gcal.patches.at(-1)!.sendUpdates, 'all', 'the removed guest receives the cancellation')
  const row = await regRow('ama@example.com')
  assert(row.invited_email === null && row.invite_removed_at)
})

Deno.test('calendar: a cancelled complimentary place is removed', opts, async () => {
  await inviteSession()
  const t = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  await reg({ email: 'abena@example.com', verification: t, expected_price: 0, attend_email: 'abena.meet@gmail.com' })
  await dispatchNow()
  assertEquals((await admit((await regRow('abena@example.com')).id, 'cancel')).json.ok, true)
  await dispatchNow()
  assertEquals(guests(), ['host@bulletproofautomations.com'])
})

Deno.test('calendar: an approved change of Google account swaps the guest in one update', opts, async () => {
  await inviteSession()
  await paidTest('ama@example.com', 'ama.meet@gmail.com')
  await dispatchNow()
  const id = (await regRow('ama@example.com')).id
  assertEquals((await admit(id, 'set_attend_email', 'ama.work@gmail.com')).json.ok, true)
  assertEquals((await dispatchNow()).json.report.calendar, { added: 1, removed: 1, failed: 0, blocked: 0 })
  assertEquals(guests(), ['host@bulletproofautomations.com', 'ama.work@gmail.com'])
  assertEquals(gcal.patches.length, 2)
  assertEquals((await regRow('ama@example.com')).invited_email, 'ama.work@gmail.com')
})

Deno.test('calendar: a graduate place whose entitlement lapses before the invitation goes out is never invited, and goes to the exception queue', opts, async () => {
  await inviteSession()
  const t = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  // A free registration runs the dispatcher straight away; register while Google is not yet
  // connected, so the lapse below happens before any invitation.
  await call(register, '/api/workshops/register', form({ testOptIn: true, email: 'abena@example.com', verification: t,
    expected_price: 0, attend_email: 'abena.meet@gmail.com' }), { ...ENV, GOOGLE_CALENDAR_REFRESH_TOKEN: undefined })
  assertEquals((await regRow('abena@example.com')).invited_email, null)
  await pg.exec(`update public.payment_plan_installments set status = 'sent' where installment_number = 2
    and enrollment_id = (select enrollment_id from public.credentials where credential_id = 'BPA-TRN-2026-GRAD02')`)
  assertEquals((await dispatchNow()).json.report.calendar.blocked, 1)
  assertEquals(gcal.patches.length, 0)
  const row = await regRow('abena@example.com')
  assertEquals([row.invited_email, row.calendar_sync_failures], [null, 5])
  assert(/no longer matches an active entitlement/.test(row.calendar_sync_error))
})

Deno.test('calendar: temporary Google errors retry on the next run; a missing event stops and waits for the admin', opts, async () => {
  await inviteSession()
  await paidTest('ama@example.com', 'ama.meet@gmail.com')
  // 503, then an etag race: counted, retried, then done.
  gcal.failNext.push(503)
  assertEquals((await dispatchNow()).json.report.calendar.failed, 1)
  assertEquals((await regRow('ama@example.com')).calendar_sync_failures, 1)
  await dispatchNow()
  assertEquals([(await regRow('ama@example.com')).invited_email, (await regRow('ama@example.com')).calendar_sync_failures], ['ama.meet@gmail.com', 0])

  // The event disappears: permanent, no more retries until the admin acts.
  await inviteSession()
  gcal.events.delete(EVENT)
  await paidTest('ama@example.com', 'ama.meet@gmail.com')
  await dispatchNow()
  let row = await regRow('ama@example.com')
  assertEquals(row.calendar_sync_failures, 5)
  assert(/event was not found/.test(row.calendar_sync_error))
  await dispatchNow()
  assertEquals((await regRow('ama@example.com')).calendar_sync_at, row.calendar_sync_at, 'not retried by itself')
  // The admin fixes the event and retries from the exception queue.
  gcal.events.set(EVENT, { etag: '"7"', attendees: [HOST] })
  assertEquals((await admit(row.id, 'retry_calendar')).json.ok, true)
  row = await regRow('ama@example.com')
  assertEquals([row.invited_email, row.calendar_sync_failures, row.calendar_sync_error], ['ama.meet@gmail.com', 0, null], 'retried at once')
  assert(/calendar-sync retry requested/.test(row.admin_notes))
})

Deno.test('calendar: a refused Google sign-in is recorded on each waiting registration and changes nothing', opts, async () => {
  await inviteSession()
  await paidTest('ama@example.com', 'ama.meet@gmail.com')
  gcal.tokenFails = true
  assertEquals((await dispatchNow()).json.report.calendar.failed, 1)
  const row = await regRow('ama@example.com')
  assert(row.invited_email === null && /Could not sign in to Google Calendar/.test(row.calendar_sync_error))
  assertEquals(gcal.patches.length, 0)
})

Deno.test('calendar: without Google settings nothing is called and the manual panel still works', opts, async () => {
  await inviteSession()
  await paidTest('ama@example.com', 'ama.meet@gmail.com')
  const off = { ...ENV, GOOGLE_CALENDAR_REFRESH_TOKEN: undefined }
  assertEquals((await dispatchNow(off)).json.report.calendar, { skipped: 'not_configured' })
  assertEquals(gcal.patches.length, 0)
  assertEquals((await admit((await regRow('ama@example.com')).id, 'mark_invited')).json.ok, true)
})

Deno.test('calendar: a test deployment never touches a live session\'s event, and a live one never touches a test session\'s', opts, async () => {
  await inviteSession({ is_test: false })
  await activate('BPA-TRN-2026-GRAD01')
  const r = await liveReg({ email: 'kofi@example.com', attend_email: 'kofi.meet@gmail.com', expected_price: 350 })
  await pay(r.json.reference, 35000)
  assertEquals((await regRow('kofi@example.com')).status, 'confirmed')
  await dispatchNow(ENV) // the Preview (test) deployment
  assertEquals(gcal.patches.length, 0)
  await dispatchNow(LIVE)
  assertEquals(guests(), ['host@bulletproofautomations.com', 'kofi.meet@gmail.com'])
})


// --- registration closes seven days (168 hours) before the start ------------------------------
const HOUR = 3600000
const startsIn = (ms: number) => new Date(Date.now() + ms).toISOString()

Deno.test('cutoff: open one minute before the cutoff; closed after it, at every price, on the server', opts, async () => {
  await reset({ ...RELEASE, starts_at: startsIn(168 * HOUR + 60000) }); await seedRecords()
  const before = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assertEquals(before.json.status, 'open')
  assertEquals(Date.parse(before.json.registration_closes_at), Date.parse(before.json.session.starts_at) - 168 * HOUR)
  assertEquals((await reg({ email: 'early@example.com', expected_price: 350 })).json.state, 'checkout')

  await reset({ ...RELEASE, starts_at: startsIn(168 * HOUR - 1000) }); await seedRecords()
  const after = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assertEquals([after.json.status, after.json.open], ['registration_closed', false])
  assertEquals((await reg({ email: 'late@example.com', expected_price: 350 })).json.code, 'closed', 'paid')
  const t = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  assertEquals(t, null, 'no certificate code is issued once registration has closed')
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations`))[0].n, 0, 'nothing recorded, no place held')
  assertEquals(paystack.initialized.length, 0)
})

Deno.test('cutoff: a checkout started before it and paid after it is confirmed, not refused', opts, async () => {
  await inviteSession({ starts_at: startsIn(168 * HOUR + 60000) })
  const r = await reg({ email: 'ama@example.com', attend_email: 'ama.meet@gmail.com', expected_price: 350 })
  assertEquals(r.json.state, 'checkout')
  // Time passes: the cutoff is now behind us while the customer is on Paystack.
  await pg.exec(`update public.workshop_sessions set starts_at = now() + interval '160 hours'`)
  assertEquals((await call(session, '/api/workshops/session?slug=automate-invoices', null)).json.status, 'registration_closed')
  await pay(r.json.reference, 35000) // the webhook's own RPC
  const row = await regRow('ama@example.com')
  assertEquals([row.status, row.payment_status, row.review_reason], ['confirmed', 'paid', null])
  const st = await call(status, '/api/workshops/status', { token: r.json.token, reference: r.json.reference })
  assertEquals(st.json.state, 'confirmed', 'the return page confirms the place')
  await dispatchNow()
  assert(guests().includes('ama.meet@gmail.com'), 'and the invitation goes out as normal')
})

Deno.test('cutoff: an unpaid registration cannot start a new checkout after it', opts, async () => {
  await reset({ ...RELEASE, starts_at: startsIn(168 * HOUR + 60000) }); await seedRecords()
  const first = await reg({ email: 'ama@example.com', expected_price: 350 })
  await pg.exec(`update public.workshop_sessions set starts_at = now() + interval '160 hours'`)
  const again = await reg({ email: 'ama@example.com', expected_price: 350, token: first.json.token })
  assertEquals(again.json.code, 'closed')
  assertEquals((await rows(`select count(*)::int n from public.workshop_payment_attempts`))[0].n, 1, 'no second charge started')
})

Deno.test('cutoff: rescheduling the session moves its cutoff with it', opts, async () => {
  await reset({ ...RELEASE, starts_at: startsIn(100 * HOUR) }); await seedRecords()
  assertEquals((await call(session, '/api/workshops/session?slug=automate-invoices', null)).json.status, 'registration_closed')
  await pg.exec(`update public.workshop_sessions set starts_at = now() + interval '20 days'`)
  assertEquals((await call(session, '/api/workshops/session?slug=automate-invoices', null)).json.status, 'open')
  assertEquals((await reg({ email: 'ama@example.com', expected_price: 350 })).json.state, 'checkout')
})

// --- waitlist (release 4): first in, first out, through the existing registration and checkout ----
const waitlistApi = await import('../functions/api/workshops/waitlist.js')
const join = (email: string, over: Row = {}) => call(waitlistApi.onRequestPost, '/api/workshops/waitlist',
  { action: 'join', slug: 'automate-invoices', full_name: 'Wait ' + email.split('@')[0], email,
    attend_email: email.replace('@', '.meet@'), ack_terms: true, ...over })
const entry = async (email: string) => (await rows(`select * from public.workshop_waitlist where email_normalized = $1`, [email]))[0]
const offerLink = (email: string) => {
  const m = [...mail].reverse().find((x) => x.to[0] === email && /A place is held for you/.test(x.subject))
  return m ? new URL(m.text.match(/Register: (\S+)/)![1]).searchParams.get('offer')! : null
}
const offerReg = (email: string, offer: string, over: Row = {}) =>
  reg({ email, attend_email: email.replace('@', '.meet@'), expected_price: 350, offer, ...over })
const used = async () => (await rows(`select public.workshop_seats_in_use(id) g, public.workshop_graduate_seats_in_use(id) r from public.workshop_sessions`))[0]
// Two open places and one reserved graduate place, both open places sold.
async function soldOut() {
  await inviteSession({ capacity: 2, reserved_graduate_seats: 1 })
  const a = await paidTest('paid1@example.com', 'paid1.meet@gmail.com')
  const b = await paidTest('paid2@example.com', 'paid2.meet@gmail.com')
  return [a, b]
}

Deno.test('waitlist: a sold-out session offers the waitlist; joining is free, FIFO, once per person, and confirmed by email', opts, async () => {
  await soldOut()
  const s = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assertEquals([s.json.status, s.json.waitlist_open], ['graduates_only', true], 'open places sold; reserved graduate place still free')
  assertEquals((await reg({ email: 'late@example.com', expected_price: 350 })).json.code, 'full')
  const before = paystack.initialized.length
  const one = await join('w1@example.com'), two = await join('w2@example.com'), three = await join('w3@example.com')
  assertEquals([one.json.position, two.json.position, three.json.position], [1, 2, 3])
  assertEquals(paystack.initialized.length, before, 'no Paystack call to join')
  assertEquals((await join('W1@example.com ')).json, { ok: true, outcome: 'already', position: 1 }, 'no duplicate entry')
  assertEquals((await rows(`select count(*)::int n from public.workshop_waitlist`))[0].n, 3)
  const confirmations = mail.filter((m) => /You're on the waitlist/.test(m.subject))
  assertEquals(confirmations.map((m) => m.to[0]), ['w1@example.com', 'w2@example.com', 'w3@example.com'])
  assert(confirmations[1].text.includes('You are number 2 in the queue') && !confirmations[1].text.includes('w1@example.com'), 'own position only')
  assertEquals((await join('paid1@example.com')).json.code, 'registered', 'already holding a place')
})

Deno.test('waitlist: a refund opens a place for the first in line only; the link fills in their details, holds the place, and their payment confirms it', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com'); await join('w2@example.com')
  await refund(a.json.reference, 35000)
  const run = await dispatchNow()
  assertEquals(run.json.report.waitlist.advanced.offered, 1)
  assertEquals([(await entry('w1@example.com')).status, (await entry('w2@example.com')).status], ['offered', 'waiting'])
  const e = await entry('w1@example.com')
  assertEquals(Date.parse(e.offer_expires_at) - Date.parse(e.offered_at), 24 * HOUR, '24 hours')
  // The held place is not available to anyone else, including the next in line.
  assertEquals((await reg({ email: 'late@example.com', expected_price: 350 })).json.code, 'full')
  const token = offerLink('w1@example.com')!
  assert(token && !e.offer_token_hash.includes(token), 'only the hash is stored')
  const pre = await call(waitlistApi.onRequestGet, '/api/workshops/waitlist?offer=' + token, null)
  assertEquals([pre.json.offer.email, pre.json.offer.full_name, pre.json.offer.attend_email], ['w1@example.com', 'Wait w1', 'w1.meet@example.com'])
  assertEquals((await call(waitlistApi.onRequestGet, '/api/workshops/waitlist?offer=' + 'X'.repeat(43), null)).status, 404)
  // The link is personal: someone else's email cannot use it.
  assertEquals((await offerReg('w2@example.com', token)).json.code, 'offer_not_valid')
  // Their own registration: the existing price, checkout and webhook.
  const r = await offerReg('w1@example.com', token)
  assertEquals([r.json.state, paystack.initialized.at(-1)!.amount], ['checkout', 35000])
  await pay(r.json.reference, 35000)
  assertEquals((await regRow('w1@example.com')).status, 'confirmed')
  await dispatchNow()
  assertEquals((await entry('w1@example.com')).status, 'converted')
  assert(guests().includes('w1.meet@example.com'), 'then the existing automatic invitation')
  assert(!guests().includes('w2.meet@example.com'), 'never anyone still waiting')
  assertEquals(await used(), { g: 2, r: 0 })
})

Deno.test('waitlist: an expired offer moves on to the next person; declining releases at once; payment retries stay within the window', opts, async () => {
  const [a, b] = await soldOut()
  await join('w1@example.com'); await join('w2@example.com'); await join('w3@example.com')
  await refund(a.json.reference, 35000)
  await dispatchNow()
  // w1 starts a checkout that fails, then retries inside the window: one place, no double charge.
  const t1 = offerLink('w1@example.com')!
  const first = await offerReg('w1@example.com', t1)
  const retry = await offerReg('w1@example.com', t1)
  assertEquals([first.json.state, retry.json.registration], ['checkout', 'existing'])
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations where email_normalized = 'w1@example.com'`))[0].n, 1)
  // The window passes without payment.
  await pg.exec(`update public.workshop_waitlist set offer_expires_at = now() - interval '1 minute' where email_normalized = 'w1@example.com'`)
  // Its checkouts lapse too (attempts are immutable: they are marked failed, as an abandoned checkout is).
  for (const a of await rows(`select reference from public.workshop_payment_attempts where registration_id = (select id from public.workshop_registrations where email_normalized = 'w1@example.com')`)) {
    await pg.query(`select public.workshop_attempt_init_failed($1, 'abandoned in test')`, [a.reference])
  }
  await dispatchNow()
  assertEquals([(await entry('w1@example.com')).status, (await entry('w2@example.com')).status], ['expired', 'offered'])
  assert(mail.some((m) => m.to[0] === 'w1@example.com' && /released/.test(m.subject)), 'told it was released')
  // w2 declines from the email link: the place goes to w3 straight away.
  const t2 = offerLink('w2@example.com')!
  assertEquals((await call(waitlistApi.onRequestPost, '/api/workshops/waitlist', { action: 'decline', offer: t2 })).json.declined, true)
  assertEquals([(await entry('w2@example.com')).status, (await entry('w3@example.com')).status], ['declined', 'offered'])
  assert(/declined/.test((await entry('w2@example.com')).audit))
  // A second place opens while w3's offer is live: nobody else is waiting, so it simply reopens.
  await refund(b.json.reference, 35000)
  await dispatchNow()
  assertEquals((await call(session, '/api/workshops/session?slug=automate-invoices', null)).json.status, 'open')
})

Deno.test('waitlist: places never oversell, even with offers, holds, refunds and registrations racing', opts, async () => {
  const [a] = await soldOut()
  for (const n of [1, 2, 3, 4]) await join('w' + n + '@example.com')
  await refund(a.json.reference, 35000)
  // The refund and four attempts to grab the place at once, then the dispatcher.
  const racing = await Promise.all([
    reg({ email: 'x1@example.com', expected_price: 350 }), reg({ email: 'x2@example.com', expected_price: 350 }),
    dispatchNow(), dispatchNow(), reg({ email: 'x3@example.com', expected_price: 350 })])
  assert(racing.slice(0, 2).concat([racing[4]]).every((r) => r.json.code === 'full'), 'nobody jumps the queue')
  const offers = await rows(`select email_normalized, status from public.workshop_waitlist order by created_at`)
  assertEquals(offers.filter((o) => o.status === 'offered').length, 1, 'one place, one offer: ' + JSON.stringify(offers))
  assertEquals((await used()).g, 2, 'capacity 2, never more')
  // Running the dispatcher again, and a duplicate webhook, change nothing.
  const sentBefore = mail.length
  await dispatchNow(); await dispatchNow()
  assertEquals(mail.length, sentBefore, 'no duplicate offer email')
  const t = offerLink('w1@example.com')!
  const r = await offerReg('w1@example.com', t)
  await pay(r.json.reference, 35000); await pay(r.json.reference, 35000)
  assertEquals((await regRow('w1@example.com')).payment_status, 'paid')
  assertEquals((await rows(`select count(*)::int n from public.workshop_payment_attempts where status = 'succeeded'
    and registration_id = (select id from public.workshop_registrations where email_normalized = 'w1@example.com')`))[0].n, 1)
  assertEquals((await used()).g, 2)
})

Deno.test('waitlist: reserved graduate places go only to verified graduates in their own queue', opts, async () => {
  await soldOut()
  // A graduate takes the only reserved place.
  const t0 = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  await reg({ email: 'abena@example.com', verification: t0, expected_price: 0, attend_email: 'abena.meet@gmail.com' })
  // An open-place waiter, then a verified graduate waiter.
  await join('w1@example.com')
  const t1 = await verifyCert('kwame@example.com', 'BPA-TRN-2026-GRAD01')
  const g = await join('kwame@example.com', { verification: t1 })
  assertEquals([(await entry('kwame@example.com')).seat_kind, g.json.position], ['graduate', 1])
  // The reserved place opens: it is offered to the graduate, never to the open-place waiter.
  await admit((await regRow('abena@example.com')).id, 'cancel')
  await dispatchNow()
  assertEquals([(await entry('kwame@example.com')).status, (await entry('w1@example.com')).status], ['offered', 'waiting'])
  // Using it still needs the graduate certificate, through the existing check.
  const token = offerLink('kwame@example.com')!
  assertEquals((await offerReg('kwame@example.com', token)).json.code, 'offer_not_valid', 'a standard registration cannot take a graduate place')
  const t2 = await verifyCert('kwame@example.com', 'BPA-TRN-2026-GRAD01')
  const r = await offerReg('kwame@example.com', token, { verification: t2, expected_price: 0 })
  assertEquals([r.json.state, r.json.price_tier], ['confirmed', 'graduate'])
  assertEquals(await used(), { g: 2, r: 1 })
})

Deno.test('waitlist: the seven-day cutoff closes it, ends open offers, and nothing is offered too close to it', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com'); await join('w2@example.com')
  // 169 hours to go: inside the last 2 hours before the cutoff, so no new offer.
  await pg.exec(`update public.workshop_sessions set starts_at = now() + interval '169 hours'`)
  await refund(a.json.reference, 35000)
  await dispatchNow()
  assertEquals((await entry('w1@example.com')).status, 'waiting', 'no offer that could not be used')
  // An offer made earlier never outlives the cutoff.
  await pg.exec(`update public.workshop_sessions set starts_at = now() + interval '180 hours'`)
  await dispatchNow()
  const e = await entry('w1@example.com')
  assertEquals(e.status, 'offered')
  assert(Date.parse(e.offer_expires_at) <= Date.now() + 12 * HOUR + 60000, 'expires at the cutoff, not after 24 hours')
  // The cutoff passes: the offer ends, the queue closes, and joining is refused.
  await pg.exec(`update public.workshop_sessions set starts_at = now() + interval '160 hours'`)
  await pg.exec(`update public.workshop_waitlist set offer_expires_at = now() - interval '1 minute' where status = 'offered'`)
  await dispatchNow()
  assertEquals([(await entry('w1@example.com')).status, (await entry('w2@example.com')).status], ['expired', 'closed'])
  assertEquals((await join('w9@example.com')).json.code, 'closed')
  assertEquals((await call(session, '/api/workshops/session?slug=automate-invoices', null)).json.status, 'registration_closed')
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations where status = 'confirmed'`))[0].n, 1, 'confirmed registrations kept')
})

Deno.test('waitlist: admin exceptions only: removal needs a reason and is recorded; nothing else moves the queue', opts, async () => {
  await soldOut()
  await join('w1@example.com'); await join('w2@example.com')
  const id = (await entry('w1@example.com')).id
  const noReason = await call(adminAction, '/api/admin/workshops', { action: 'waitlist_remove', waitlist_id: id, value: '' }, ENV, adminEnv)
  assertEquals(noReason.status, 409)
  const ok = await call(adminAction, '/api/admin/workshops', { action: 'waitlist_remove', waitlist_id: id, value: 'Asked to be taken off by phone' }, ENV, adminEnv)
  assertEquals(ok.json.ok, true)
  const e = await entry('w1@example.com')
  assert(e.status === 'removed' && /Asked to be taken off/.test(e.audit))
  assertEquals((await call(waitlistApi.onRequestPost, '/api/workshops/waitlist', { action: 'join', slug: 'automate-invoices', full_name: 'X', email: 'w3@example.com', ack_terms: true })).status, 400, 'a name is required')
})


// --- waitlist: payment in flight, late payments, queue-jumping, and the exact cutoff instant --------
const failAttempts = async (email: string) => {
  for (const a of await rows(`select reference from public.workshop_payment_attempts where registration_id =
      (select id from public.workshop_registrations where email_normalized = $1)`, [email])) {
    await pg.query(`select public.workshop_attempt_init_failed($1, 'checkout abandoned in test')`, [a.reference])
  }
}
const lapseOffer = (email: string) => pg.query(`update public.workshop_waitlist set offer_expires_at = now() - interval '1 minute'
  where email_normalized = $1`, [email])

Deno.test('waitlist: a payment in flight when the offer lapses still converts, and the place is offered to nobody else meanwhile', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com'); await join('w2@example.com')
  await refund(a.json.reference, 35000)
  await dispatchNow()
  const r = await offerReg('w1@example.com', offerLink('w1@example.com')!)
  assertEquals(r.json.state, 'checkout')
  await lapseOffer('w1@example.com') // the window ends while w1 is on Paystack
  await dispatchNow()
  assertEquals([(await entry('w1@example.com')).status, (await entry('w2@example.com')).status], ['offered', 'waiting'], 'held while the payment is in flight')
  assertEquals((await used()).g, 2)
  await pay(r.json.reference, 35000) // the webhook arrives late, inside the 30-minute hold
  await dispatchNow()
  assertEquals([(await regRow('w1@example.com')).status, (await entry('w1@example.com')).status, (await entry('w2@example.com')).status],
    ['confirmed', 'converted', 'waiting'])
  assertEquals((await used()).g, 2, 'never oversold')
})

Deno.test('waitlist: a payment arriving after the hold lapsed and the place was re-offered is held for review, never oversold or lost', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com'); await join('w2@example.com')
  await refund(a.json.reference, 35000)
  await dispatchNow()
  const r = await offerReg('w1@example.com', offerLink('w1@example.com')!)
  await lapseOffer('w1@example.com'); await failAttempts('w1@example.com') // window and hold both over
  await dispatchNow()
  assertEquals([(await entry('w1@example.com')).status, (await entry('w2@example.com')).status], ['expired', 'offered'])
  // w1's payment on a checkout started well before (its 30-minute hold long over) is verified
  // only now, for a place that is now w2's. Attempts are immutable, so the aged one is inserted
  // as it would exist, the same way the webhook suite builds a stale attempt.
  assert(r.json.reference)
  await pg.query(`insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, mode, created_at)
    values ((select id from public.workshop_registrations where email_normalized = 'w1@example.com'),
            'BPA-WTEST-2026-LATEPAYMNT', 35000, 'test', now() - interval '2 hours')`)
  await pay('BPA-WTEST-2026-LATEPAYMNT', 35000)
  const late = await regRow('w1@example.com')
  assertEquals([late.status, late.review_reason], ['payment_received_review', 'capacity'], 'an exception for refund, not a seat')
  assertEquals(Number(late.amount_paid_minor), 35000, 'the money is recorded, not lost')
  // Places actually given: confirmed registrations plus live offers stay within capacity (2).
  const given = (await rows(`select (select count(*)::int from public.workshop_registrations where status = 'confirmed' and price_tier <> 'graduate')
    + (select count(*)::int from public.workshop_waitlist where status = 'offered' and offer_expires_at > now()) n`))[0].n
  assertEquals(given, 2, 'not oversold')
  // Release 1 counts money held for review as occupying a place until the admin admits or refunds
  // it, so nothing further is offered meanwhile (conservative, by design).
  assertEquals((await used()).g, 3)
  await dispatchNow()
  assertEquals((await rows(`select count(*)::int n from public.workshop_waitlist where status = 'offered'`))[0].n, 1, 'no extra offer')
  assert(!guests().includes('w1.meet@example.com'), 'no meeting access')
})

Deno.test('waitlist: an expired offer, or an old unpaid registration, cannot start a new checkout while others wait', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com'); await join('w2@example.com')
  await refund(a.json.reference, 35000)
  await dispatchNow()
  const w1 = await offerReg('w1@example.com', offerLink('w1@example.com')!)
  await lapseOffer('w1@example.com'); await failAttempts('w1@example.com')
  await dispatchNow() // w2 now holds the place
  const before = paystack.initialized.length
  const again = await reg({ email: 'w1@example.com', attend_email: 'w1.meet@example.com', expected_price: 350, token: w1.json.token })
  assertEquals(again.json.code, 'full')
  assertEquals(paystack.initialized.length, before, 'Paystack is never called')
  // Even with the place momentarily free (w2 declines), w1 cannot take it while anyone waits.
  await join('w3@example.com')
  await call(waitlistApi.onRequestPost, '/api/workshops/waitlist', { action: 'decline', offer: offerLink('w2@example.com') })
  assertEquals((await reg({ email: 'w1@example.com', attend_email: 'w1.meet@example.com', expected_price: 350, token: w1.json.token })).json.code, 'full')
  assertEquals((await entry('w3@example.com')).status, 'offered', 'FIFO: the next in line gets it')
})

Deno.test('cutoff: closed at exactly 168 hours before the start, open a second before; recalculated on reschedule', opts, async () => {
  await reset({ ...RELEASE }); await seedRecords()
  const open = async (interval: string) => (await rows(`update public.workshop_sessions set starts_at = now() + interval '${interval}'
    returning public.workshop_session_open(workshop_sessions.*) o`))[0].o
  assertEquals(await open('168 hours 1 second'), true, 'one second before the cutoff')
  assertEquals(await open('168 hours'), false, 'at the cutoff')
  assertEquals(await open('167 hours 59 minutes 59 seconds'), false, 'one second after')
  assertEquals(await open('30 days'), true, 'rescheduled later: open again')
  // Workshop 01: Saturday 12 December 2026, 11:30 Accra (UTC+0), closes Saturday 5 December 2026, 11:30.
  const w = (await rows(`select ('2026-12-12 11:30:00+00'::timestamptz - interval '168 hours') at time zone 'Africa/Accra' c`))[0].c
  assertEquals(new Date(w).toISOString().slice(0, 16), '2026-12-05T11:30')
})

// --- late payment versus the waitlist: the payment-confirmation guard (release 4) ------------------
// x registers while a place is free and starts a checkout, then abandons it; the session sells out,
// someone joins the waitlist, and a place frees. x's payment for a checkout whose 30-minute hold
// lapsed long ago is verified now, before the dispatcher has offered that place.
async function lateCheckoutSetup() {
  await inviteSession({ capacity: 2, reserved_graduate_seats: 1 })
  await paidTest('paid1@example.com', 'paid1.meet@gmail.com')
  await reg({ email: 'x@example.com', attend_email: 'x.meet@gmail.com', expected_price: 350 })
  await failAttempts('x@example.com') // its live checkout ended
  // Its earlier checkout, started two hours ago (attempts are immutable, so inserted aged).
  await pg.query(`insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, mode, created_at)
    values ((select id from public.workshop_registrations where email_normalized = 'x@example.com'),
            'BPA-WTEST-2026-XLATEPAYMT', 35000, 'test', now() - interval '2 hours')`)
  const b = await paidTest('paid2@example.com', 'paid2.meet@gmail.com')
  await join('w1@example.com')
  await refund(b.json.reference, 35000) // a place frees; the dispatcher has NOT run yet
}

Deno.test('late payment: with someone waiting, a lapsed-hold payment is held for refund, not confirmed, even before the dispatcher runs', opts, async () => {
  await lateCheckoutSetup()
  assertEquals((await entry('w1@example.com')).status, 'waiting', 'dispatcher delayed: no offer yet')
  // The same webhook delivered twice at once, and the reconciliation path racing it.
  await Promise.all([pay('BPA-WTEST-2026-XLATEPAYMT', 35000), pay('BPA-WTEST-2026-XLATEPAYMT', 35000)])
  const x = await regRow('x@example.com')
  assertEquals([x.status, x.review_reason, Number(x.amount_paid_minor)], ['payment_received_review', 'capacity', 35000],
    'recorded for resolution; the money is not lost')
  assertEquals((await rows(`select count(*)::int n from public.workshop_payment_attempts where reference = 'BPA-WTEST-2026-XLATEPAYMT' and status = 'succeeded'`))[0].n, 1, 'applied once')
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations where status = 'confirmed'`))[0].n, 1, 'only paid1 holds a place')
  // The dispatcher finally runs. The held payment counts against capacity until resolved (owner
  // decision), so the place is not offered yet; nothing oversells and x gets no meeting access.
  await dispatchNow()
  assert(!guests().includes('x.meet@gmail.com'))
  // The admin refunds x: the place goes to w1, first in line.
  assertEquals((await admit(x.id, 'request_refund')).json.ok, true)
  await refund('BPA-WTEST-2026-XLATEPAYMT', 35000)
  await dispatchNow()
  assertEquals([(await regRow('x@example.com')).status, (await entry('w1@example.com')).status], ['refunded', 'offered'])
})

Deno.test('late payment: a payment inside its hold is a legitimate payment in flight and is confirmed even with people waiting', opts, async () => {
  await inviteSession({ capacity: 2, reserved_graduate_seats: 1 })
  await paidTest('paid1@example.com', 'paid1.meet@gmail.com')
  const x = await reg({ email: 'x@example.com', attend_email: 'x.meet@gmail.com', expected_price: 350 })
  assertEquals(x.json.state, 'checkout') // x's hold makes the session full
  await join('w1@example.com')
  assertEquals((await join('w1@example.com')).json.outcome, 'already')
  await pay(x.json.reference, 35000)
  assertEquals((await regRow('x@example.com')).status, 'confirmed', 'its place was rightfully held')
  await dispatchNow()
  assertEquals((await entry('w1@example.com')).status, 'waiting', 'no place to offer: still FIFO')
})

Deno.test('late payment: with nobody waiting and a place free, a lapsed-hold payment is still confirmed (unchanged behaviour)', opts, async () => {
  await inviteSession({ capacity: 2, reserved_graduate_seats: 1 })
  await paidTest('paid1@example.com', 'paid1.meet@gmail.com')
  await reg({ email: 'x@example.com', attend_email: 'x.meet@gmail.com', expected_price: 350 })
  await failAttempts('x@example.com')
  await pg.query(`insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, mode, created_at)
    values ((select id from public.workshop_registrations where email_normalized = 'x@example.com'),
            'BPA-WTEST-2026-XLATEPAYMT', 35000, 'test', now() - interval '2 hours')`)
  await pay('BPA-WTEST-2026-XLATEPAYMT', 35000)
  assertEquals((await regRow('x@example.com')).status, 'confirmed')
})

// --- Codex audit, 9 November 2026 ---------------------------------------------------------------
// Database races are also run on a real PostgreSQL server in tests/workshops-concurrency.test.ts.
const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => (resolve = r)); return { p, resolve } }
const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)) }
  return false
}

Deno.test("audit security: an email address alone cannot attach a status token to someone else's registration", opts, async () => {
  await reset()
  const owner = await call(register, '/api/workshops/register', form({ testOptIn: true }))
  assertEquals(owner.json.state, 'checkout')
  const tokens = async () => (await rows(`select count(*)::int n from public.workshop_status_tokens`))[0].n
  const before = { tokens: await tokens(), checkouts: paystack.initialized.length }
  // Someone else submits the form with the owner's email, with no token or a made-up one.
  for (const token of [undefined, 'B'.repeat(43)]) {
    const other = await call(register, '/api/workshops/register', form({ testOptIn: true, full_name: 'Not Ama', token }))
    assertEquals([other.status, other.json.code], [409, 'registered'])
    for (const k of ['token', 'state', 'price_ghs', 'price_tier', 'url', 'reference']) assertEquals(other.json[k], undefined, k + ' disclosed')
  }
  assertEquals(await tokens(), before.tokens, 'no token was attached to the registration')
  assertEquals(paystack.initialized.length, before.checkouts, 'no checkout was opened for it')
  // The owner's own browser still resumes.
  const own = await call(register, '/api/workshops/register', form({ testOptIn: true, token: owner.json.token }))
  assertEquals([own.json.registration, own.json.state], ['existing', 'checkout'])
})

Deno.test('audit 4: abandoned checkouts never starve a paid one queued behind them', opts, async () => {
  await reset()
  const refs: string[] = []
  for (let i = 0; i < 12; i++) refs.push((await call(register, '/api/workshops/register', form({ testOptIn: true, email: `p${i}@example.com` }))).json.reference)
  // All older than the 10-minute grace, oldest first. Only the newest was actually paid.
  const hasHold = (await rows(`select count(*)::int n from information_schema.columns
    where table_name = 'workshop_payment_attempts' and column_name = 'hold_until'`))[0].n > 0
  await pg.exec(`set session_replication_role = replica`)
  for (const [i, r] of refs.entries()) {
    await pg.query(`update public.workshop_payment_attempts set created_at = now() - make_interval(mins => $2) where reference = $1`, [r, 60 - i])
    if (hasHold) await pg.query(`update public.workshop_payment_attempts set hold_until = created_at + interval '30 minutes' where reference = $1`, [r])
  }
  await pg.exec(`set session_replication_role = origin`)
  const paid = refs[11]
  paystack.paid.set(paid, { status: 'success', reference: paid, amount: 15000, currency: 'GHS', domain: 'test', paid_at: new Date().toISOString() })
  await dispatchNow(); await dispatchNow()
  assertEquals((await rows(`select r.status from public.workshop_registrations r join public.workshop_payment_attempts a
    on a.registration_id = r.id where a.reference = $1`, [paid]))[0].status, 'confirmed', 'reconciled by the second run')
})

Deno.test('audit 5: two dispatcher runs at once send one offer email, and its link works', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com')
  await dispatchNow() // earlier confirmations and the joined email go out first, so both runs reach the waitlist together
  await refund(a.json.reference, 35000)
  mail.length = 0
  mailDelayMs = 150
  try { await Promise.all([dispatchNow(), dispatchNow()]) } finally { mailDelayMs = 0 }
  const offers = mail.filter((m) => m.to[0] === 'w1@example.com' && /A place is held for you/.test(m.subject))
  assertEquals(offers.length, 1, 'one offer email')
  const r = await offerReg('w1@example.com', offerLink('w1@example.com')!)
  assertEquals(r.json.state, 'checkout', 'the link in the email holds the place')
})

Deno.test('audit 6: overlapping calendar runs leave only the account the registration names on the event', opts, async () => {
  await inviteSession()
  await paidTest('ama@example.com', 'first.account@gmail.com')
  const id = (await regRow()).id
  const gateA = deferred(), gateB = deferred()
  gcal.gates = [gateA.p, gateB.p]; gcal.paused = 0
  // Run A plans to add the first account and is paused at Google.
  const runA = dispatchNow()
  assert(await until(() => gcal.paused === 1), 'run A reached Google')
  // An approved change of account is recorded before A has reported back.
  await pg.query(`update public.workshop_registrations set attend_email = 'second.account@gmail.com' where id = $1`, [id])
  // Run B starts; if it is given the registration, it too is paused at Google.
  let bDone = false
  const runB = dispatchNow().then((x) => { bDone = true; return x })
  await until(() => gcal.paused === 2 || bDone)
  gateA.resolve(); await runA // A adds the first account and records it
  gateB.resolve(); await runB // B, if it ran, adds the second and records over A
  gcal.gates = []
  await dispatchNow(); await dispatchNow()
  assertEquals(guests(), ['host@bulletproofautomations.com', 'second.account@gmail.com'])
  assertEquals((await regRow()).invited_email, 'second.account@gmail.com')
})

Deno.test('audit recovery: the admin can retry an email the dispatcher gave up on', opts, async () => {
  await reset({ price_ghs: 0 })
  await call(register, '/api/workshops/register', form())
  const id = (await regRow()).id
  await pg.query(`update public.workshop_notifications set status = 'failed', attempts = 5, error = 'mail-503' where registration_id = $1`, [id])
  mail.length = 0
  await dispatchNow()
  assertEquals(mail.length, 0, 'exhausted: the dispatcher no longer tries it')
  const res = await adminPost({ action: 'retry_email', registration_id: id })
  assertEquals([res.status, res.json.ok], [200, true])
  await dispatchNow()
  assertEquals(mail.map((m) => m.subject), ["You're registered: Automate your invoices"])
  assertEquals((await rows(`select status from public.workshop_notifications where registration_id = $1`, [id]))[0].status, 'sent')
  assert(/email retry requested/.test((await regRow()).admin_notes))
  // Nothing left to retry: refused, nothing changed.
  assertEquals((await adminPost({ action: 'retry_email', registration_id: id })).status, 409)
})

// --- Codex audit 2, 9 November 2026 (B and C) -------------------------------------------------

Deno.test('audit 2B: a paid checkout older than 48 hours, or whose initialize failed, is still reconciled', opts, async () => {
  await reset()
  const old = (await call(register, '/api/workshops/register', form({ testOptIn: true, email: 'old@example.com' }))).json.reference
  const lost = (await call(register, '/api/workshops/register', form({ testOptIn: true, email: 'lost@example.com' }))).json.reference
  // One sat through a long dispatcher outage; the other's initialize answer was lost.
  await pg.exec(`set session_replication_role = replica`)
  await pg.query(`update public.workshop_payment_attempts set created_at = now() - interval '72 hours' where reference = $1`, [old])
  await pg.query(`update public.workshop_payment_attempts set created_at = now() - interval '20 minutes' where reference = $1`, [lost])
  await pg.exec(`set session_replication_role = origin`)
  await pg.query(`select public.workshop_attempt_init_failed($1, 'initialize timed out in test')`, [lost])
  for (const r of [old, lost]) {
    paystack.paid.set(r, { status: 'success', reference: r, amount: 15000, currency: 'GHS', domain: 'test', paid_at: new Date().toISOString() })
  }
  await dispatchNow()
  const st = async (r: string) => (await rows(`select r.status from public.workshop_registrations r join public.workshop_payment_attempts a
    on a.registration_id = r.id where a.reference = $1`, [r]))[0].status
  assertEquals([await st(old), await st(lost)], ['confirmed', 'confirmed'])
})

Deno.test('audit 2C: an offer email sent but not recorded is sent again with the same, still-working link', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com')
  await dispatchNow()
  await refund(a.json.reference, 35000)
  mail.length = 0
  // Hostinger accepts the offer email; recording that it went out fails.
  DB.fail.add('rpc/workshop_waitlist_mail_done')
  try { await dispatchNow() } finally { DB.fail.delete('rpc/workshop_waitlist_mail_done') }
  const first = offerLink('w1@example.com')
  assert(first, 'the offer email went out')
  // The claim lapses, and a later run sends the offer again.
  await pg.exec(`update public.workshop_waitlist set mail_claimed_at = now() - interval '11 minutes' where email_normalized = 'w1@example.com'`)
  await dispatchNow()
  const offers = mail.filter((m) => m.to[0] === 'w1@example.com' && /A place is held for you/.test(m.subject))
  assertEquals(offers.length, 2, 'sent again, because the first was not recorded')
  assertEquals(offerLink('w1@example.com'), first, 'the same link')
  const r = await offerReg('w1@example.com', first!)
  assertEquals(r.json.state, 'checkout', 'the link in the first email still holds the place')
})

Deno.test('audit 2D: an account Google accepted but the database never recorded is removed after a refund', opts, async () => {
  await inviteSession()
  const r = await paidTest('ama@example.com', 'ama.meet@gmail.com')
  // Google adds the account; recording that it did fails.
  DB.fail.add('rpc/workshop_calendar_record')
  try { await dispatchNow() } finally { DB.fail.delete('rpc/workshop_calendar_record') }
  assertEquals(guests(), ['host@bulletproofautomations.com', 'ama.meet@gmail.com'])
  assertEquals((await regRow()).invited_email, null, 'not recorded')
  // The registration is refunded before any later run, and the run's claim lapses.
  await refund(r.json.reference, 35000)
  await pg.exec(`update public.workshop_registrations set calendar_claimed_at = now() - interval '11 minutes'`)
  await dispatchNow()
  assertEquals(guests(), ['host@bulletproofautomations.com'], 'removed; the host is left alone')
  assertEquals((await regRow()).calendar_managed_emails, [])
})

Deno.test('audit 2D: an unrecorded add is confirmed, not duplicated, when the registration still holds it', opts, async () => {
  await inviteSession()
  await paidTest('ama@example.com', 'ama.meet@gmail.com')
  DB.fail.add('rpc/workshop_calendar_record')
  try { await dispatchNow() } finally { DB.fail.delete('rpc/workshop_calendar_record') }
  await pg.exec(`update public.workshop_registrations set calendar_claimed_at = now() - interval '11 minutes'`)
  const patches = gcal.patches.length
  await dispatchNow()
  assertEquals(guests(), ['host@bulletproofautomations.com', 'ama.meet@gmail.com'])
  assertEquals(gcal.patches.length, patches, 'already on the event: nothing sent again')
  assertEquals((await regRow()).invited_email, 'ama.meet@gmail.com')
})

Deno.test('audit 2E: a lapsed offer link no longer proves ownership of the registration it made', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com')
  await refund(a.json.reference, 35000)
  await dispatchNow()
  const link = offerLink('w1@example.com')!
  await offerReg('w1@example.com', link)
  // While the offer is open, the link resumes the registration on another device.
  assertEquals((await offerReg('w1@example.com', link)).json.registration, 'existing')
  await lapseOffer('w1@example.com')
  const late = await offerReg('w1@example.com', link)
  assertEquals([late.status, late.json.code], [409, 'registered'], 'nothing attached, nothing returned')
  assertEquals(late.json.token, undefined)
})

// --- Codex audit 2, 9 November 2026 (F) ------------------------------------------------------

Deno.test('audit 2F: an email stranded "sending" after its fifth attempt is reported and can be retried', opts, async () => {
  await reset({ price_ghs: 0 })
  await call(register, '/api/workshops/register', form())
  const id = (await regRow()).id
  // The fifth send's result was never recorded: 'sending', no attempts left, claim long gone.
  await pg.query(`update public.workshop_notifications set status = 'sending', attempts = 5,
    claimed_at = now() - interval '11 minutes' where registration_id = $1`, [id])
  mail.length = 0
  const before = await dispatchNow()
  assertEquals(mail.length, 0, 'the dispatcher never claims it again')
  assertEquals(before.json.ok, false)
  assert(before.json.report.health.includes('emails_need_retry'), JSON.stringify(before.json.report.health))
  assertEquals([(await adminPost({ action: 'retry_email', registration_id: id })).status], [200])
  const after = await dispatchNow()
  assertEquals(mail.map((m) => m.subject), ["You're registered: Automate your invoices"])
  assertEquals(after.json.report.health, [])
})

Deno.test('audit 2F: an upcoming invitation-only session with no Google connection is reported', opts, async () => {
  await inviteSession()
  await paidTest('ama@example.com', 'ama.meet@gmail.com')
  const out = await dispatchNow({ ...ENV, GOOGLE_CALENDAR_REFRESH_TOKEN: undefined })
  assertEquals(out.json.ok, false)
  assert(out.json.report.health.includes('calendar_not_configured'), JSON.stringify(out.json.report.health))
})

Deno.test('audit 2F: a waitlist email sent but not recorded makes the run unhealthy', opts, async () => {
  const [a] = await soldOut()
  await join('w1@example.com')
  await dispatchNow()
  await refund(a.json.reference, 35000)
  DB.fail.add('rpc/workshop_waitlist_mail_done')
  let out
  try { out = await dispatchNow() } finally { DB.fail.delete('rpc/workshop_waitlist_mail_done') }
  assert(out.json.report.health.includes('waitlist_email'), JSON.stringify(out.json.report.health))
})

Deno.test('audit 2 (item 9): reserved graduate places taken while open places remain: graduates can queue for them', opts, async () => {
  await reset({ ...RELEASE, capacity: 10, reserved_graduate_seats: 1 }); await seedRecords()
  const tg = await verifyCert('kwame@example.com', 'BPA-TRN-2026-GRAD01')
  assertEquals((await reg({ email: 'kwame@example.com', verification: tg, expected_price: 0 })).json.state, 'confirmed')
  const s = await call(session, '/api/workshops/session?slug=automate-invoices', null)
  assertEquals([s.json.status, s.json.open, s.json.graduate_places_open, s.json.graduate_waitlist_open], ['open', true, false, true])
  const ta = await verifyCert('abena@example.com', 'BPA-TRN-2026-GRAD02')
  assertEquals((await reg({ email: 'abena@example.com', verification: ta, expected_price: 0 })).json.code, 'full', 'the reserved place is used')
  const joined = await join('abena@example.com', { verification: ta })
  assertEquals([joined.json.ok, joined.json.kind ?? (await entry('abena@example.com')).seat_kind], [true, 'graduate'])
  // Capacity and entitlement unchanged: the open places still sell at the standard fee.
  assertEquals((await reg({ email: 'kofi@example.com', expected_price: 350 })).json.ok, true)
})
