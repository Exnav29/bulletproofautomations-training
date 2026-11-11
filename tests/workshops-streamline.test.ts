/**
 * Release 7 (streamlined workshop administration), end to end on production's schema
 * (PGlite) with stand-ins for Google Calendar and OpenRouter:
 *   - series defaults fill a new workshop; a sent value wins; Workshop 01 is untouched;
 *   - Duplicate copies content and settings as a draft with no date, event or meeting;
 *   - Schedule creates one Calendar event with a Meet link and locked-down guests, then
 *     opens registration; a retry never makes a second event; a Google failure leaves
 *     the workshop a draft with a Retry;
 *   - a date change moves the event and emails guests; Workshop 01's own event is kept;
 *   - Generate draft content picks a free model, falls back past a bad draft, saves nothing.
 *
 *   deno test --node-modules-dir=none --allow-net --allow-read --allow-env tests/workshops-streamline.test.ts
 */
import { assert, assertEquals } from 'https://deno.land/std@0.168.0/testing/asserts.ts'
import { loadDatabase, serveDatabase } from './helpers/postgrest.ts'

type Row = Record<string, any>
const u = (p: string) => new URL(p, import.meta.url)
const MIGRATIONS = ['20261103120000_workshops', '20261109120000_workshop_admission_benefits', '20261110120000_workshop_calendar_sync',
  '20261111120000_workshop_waitlist', '20261112120000_workshop_audit_corrections']
const pg = await loadDatabase([u('./fixtures/payment-ledger.sql'), u('./fixtures/supabase-stubs.sql'), u('./fixtures/graduate-records.sql'),
  ...MIGRATIONS.map((m) => u(`../supabase/migrations/${m}.sql`))])
// Workshop 01 as production has it: published, with the owner's own Calendar event.
await pg.exec(`insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs, capacity, status,
  admission, calendar_event_id, reserved_graduate_seats, foundations_discount_pct, graduate_free, referral_discount_ghs, referral_commission_ghs)
  values ('what-to-charge-for-automation', 'workshop', 'You know automation. Do you know what to charge?', now() + interval '30 days', 180,
  'live online', 350, 25, 'published', 'invite', 'ownersevent0001', 5, 20, true, 50, 50)`)
for (const m of ['20261113120000_workshop_admin_studio', '20261113120100_workshop_content_seed']) {
  await pg.exec(await Deno.readTextFile(u(`../supabase/migrations/${m}.sql`)))
}
const before = (await pg.query<Row>(`select * from public.workshop_sessions where slug = 'what-to-charge-for-automation'`)).rows[0]
await pg.exec(await Deno.readTextFile(u('../supabase/migrations/20261114120000_workshop_admin_streamline.sql')))
const DB = serveDatabase(pg, 54353)

const adminAction = (await import('../functions/api/admin/workshops.js')).onRequestPost
const pages = await import('../functions/workshops/[[path]].js')
const ai = await import('../functions/api/_ai_draft.js')

/* ---------- Google Calendar stand-in ---------- */
const events = new Map<string, Row>()
const calls: { method: string; path: string; query: string; body: Row | null }[] = []
let googleDown = false
function googleCalendar(url: URL, method: string, body: Row | null): Response {
  calls.push({ method, path: url.pathname, query: url.search, body })
  if (googleDown) return new Response('{"error":"backendError"}', { status: 503 })
  const parts = url.pathname.split('/events')
  const id = parts[1] ? decodeURIComponent(parts[1].slice(1)) : ''
  if (method === 'POST' && !id) {
    if (events.has(body!.id)) return new Response('{"error":{"code":409}}', { status: 409 })
    const ev: Row = { ...body, status: 'confirmed', etag: '"1"', hangoutLink: 'https://meet.google.com/' + body!.id.slice(3, 6) + '-wxyz-' + body!.id.slice(6, 9) }
    delete ev.conferenceData
    events.set(body!.id, ev); return Response.json(ev)
  }
  const ev = events.get(id)
  if (!ev) return new Response('{"error":{"code":404}}', { status: 404 })
  if (method === 'GET') return Response.json(ev)
  if (method === 'PATCH') { Object.assign(ev, body); ev.etag = '"' + (Number(String(ev.etag).replace(/"/g, '')) + 1) + '"'; return Response.json(ev) }
  return new Response('no', { status: 405 })
}
// The owner's hand-made event for Workshop 01.
events.set('ownersevent0001', { id: 'ownersevent0001', summary: "Johnathan's own title", description: 'Owner wording', status: 'confirmed',
  start: { dateTime: before.starts_at }, attendees: [{ email: 'guest@example.com' }], hangoutLink: 'https://meet.google.com/own-ersm-eet' })

/* ---------- OpenRouter stand-in ---------- */
const MODELS = [
  { id: 'tiny/model-1.5b:free', created: 1790000000, context_length: 64000, pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs', 'response_format'], top_provider: { max_completion_tokens: 8000 } },
  { id: 'good/writer-70b:free', created: 1790000000, context_length: 128000, pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs', 'response_format'], top_provider: { max_completion_tokens: 16000 } },
  { id: 'flaky/thinker-120b:free', created: 1795000000, context_length: 256000, pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs', 'response_format'], top_provider: { max_completion_tokens: 32000 } },
  { id: 'paid/expensive', created: 1795000000, context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] },
  { id: 'audio/music:free', created: 1795000000, context_length: 200000, pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] }, supported_parameters: [] },
  { id: 'openrouter/free', created: 1780000000, context_length: 200000, pricing: { prompt: '0', completion: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['structured_outputs'] }
]
const DRAFT = {
  summary: 'Learn to find the businesses that need your automation skills and can pay for them, then shortlist the first ten.',
  description: 'Choose who to sell automation to.', directory_line: 'Pick the clients worth your time.', audience: 'Automation practitioners without steady clients',
  why: ['Most builders try to sell to everyone.'], outcomes: ['Define a target client', 'Find ten prospects', 'Rank them by need'],
  leave_with: ['A shortlist of ten prospects'], run_of_show: [{ at: '0:00', title: 'Welcome', detail: 'Goals' }, { at: '1:00', title: 'Break', detail: '' },
    { at: '1:15', title: 'Shortlist clinic', detail: 'Build yours' }],
  faq: [{ q: 'Do I need clients already?', a: 'No.' }, { q: 'Is it recorded?', a: 'No.' }, { q: 'Is this a certification?', a: 'No, it is training.' }],
  good_fit: 'You build automations.', not_fit: 'You have not built one yet.', bring: 'A laptop.', problem: 'Selling to everyone.', series_fit: 'Comes after pricing.'
}
const asked: Row[] = []
function openRouter(url: URL, body: Row | null, headers: Row): Response {
  if (url.pathname === '/api/v1/models') return Response.json({ data: MODELS })
  if (url.pathname === '/api/v1/chat/completions') {
    asked.push({ model: body!.model, auth: headers.Authorization, format: body!.response_format?.type, prompt: body!.messages[1].content })
    if (body!.model === 'flaky/thinker-120b:free') return Response.json({ model: body!.model, choices: [{ message: { content: '{"summary":"too short"}' } }] })
    return Response.json({ model: body!.model, choices: [{ message: { content: '```json\n' + JSON.stringify(DRAFT) + '\n```' } }] })
  }
  return new Response('no', { status: 404 })
}

const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  let body: any = null
  try { body = init?.body ? JSON.parse(String(init.body)) : null } catch (_) { body = null }
  if (url.host === 'oauth2.googleapis.com') return Response.json({ access_token: 'google-access' })
  if (url.host === 'www.googleapis.com') return googleCalendar(url, init?.method || 'GET', body)
  if (url.host === 'openrouter.ai') return openRouter(url, body, (init?.headers || {}) as Row)
  if (url.pathname === '/auth/v1/user') {
    const auth = (init?.headers as Row)?.Authorization
    return auth === 'Bearer admin-jwt' ? Response.json({ email: 'johnathan@bulletproofautomations.com' }) : new Response('no', { status: 401 })
  }
  return realFetch(input, init)
}

const SHELL = '<!DOCTYPE html><html lang="en"><head><title>__WS_TITLE__</title><meta name="description" content="__WS_DESCRIPTION__">' +
  '<link rel="canonical" href="__WS_CANONICAL__"></head><body><!-- ws-body --></body></html>'
const ASSETS = { fetch: async (req: Request) => {
  const p = new URL(req.url).pathname
  if (p === '/workshops/_shell.html') return new Response(SHELL)
  if (p === '/404.html') return new Response('<p>not found</p>')
  return new Response('missing', { status: 404 })
} }
const ENV: Row = { SUPABASE_URL: DB.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role-for-tests', ASSETS,
  GOOGLE_CALENDAR_CLIENT_ID: 'cid', GOOGLE_CALENDAR_CLIENT_SECRET: 'csecret', GOOGLE_CALENDAR_REFRESH_TOKEN: 'refresh', OPENROUTER_API_KEY: 'or-key' }

async function call(fn: Function, path: string, body: Row | null, env: Row = ENV, headers: Row = {}) {
  const request = new Request('https://training.example' + path, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined
  })
  const res: Response = await fn({ request, env, waitUntil: () => {} })
  const text = await res.text()
  let json: Row = {}
  try { json = JSON.parse(text) } catch (_) { json = { raw: text } }
  return { status: res.status, json, text }
}
const admin = (body: Row, env: Row = ENV) => call(adminAction, '/api/admin/workshops', body, env, { Authorization: 'Bearer admin-jwt' })
const page = (path: string) => call(pages.onRequestGet, path, null)
const rows = async (sql: string, v: unknown[] = []) => (await pg.query<Row>(sql, v)).rows
const one = async (slug: string) => (await rows(`select * from public.workshop_sessions where slug = $1`, [slug]))[0]
const opts = { sanitizeOps: false, sanitizeResources: false }
const day = (n: number, time = '11:30') => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10) + 'T' + time + ':00Z'

Deno.test('the migration keeps Workshop 01 exactly as it was, and gives the series its defaults', opts, async () => {
  const w = await one('what-to-charge-for-automation')
  for (const k of ['slug', 'status', 'price_ghs', 'capacity', 'reserved_graduate_seats', 'foundations_discount_pct', 'graduate_free',
    'admission', 'calendar_event_id', 'starts_at', 'referral_discount_ghs', 'referral_commission_ghs', 'content', 'join_instructions']) {
    assertEquals(JSON.stringify(w[k]), JSON.stringify(before[k]), k)
  }
  assertEquals([w.calendar_status, w.calendar_managed, w.meet_link], ['ready', false, null], 'the owner\'s event is kept as theirs')
  const ser = (await rows(`select defaults from public.workshop_series where slug = 'get-paid-for-automation'`))[0]
  assertEquals([ser.defaults.price_ghs, ser.defaults.capacity, ser.defaults.reserved_graduate_seats, ser.defaults.admission, ser.defaults.start_time],
    [350, 25, 5, 'invite', '11:30'])
})

Deno.test('a new workshop in the series takes the series defaults; a value sent wins', opts, async () => {
  const made = await admin({ action: 'session_save', session: { title: 'Price your retainers', series_slug: 'get-paid-for-automation', price_ghs: 400 } })
  assertEquals(made.status, 200)
  const w = await one('price-your-retainers')
  assertEquals([Number(w.price_ghs), w.capacity, w.reserved_graduate_seats, w.foundations_discount_pct, w.graduate_free, w.admission, w.duration_minutes, w.status],
    [400, 25, 5, 20, true, 'invite', 180, 'draft'])
  // Changing a default changes no existing workshop.
  const saved = await admin({ action: 'series_save', series: { slug: 'get-paid-for-automation', name: 'Get Paid for Automation', presenter: 'Bulletproof Automations',
    defaults: { price_ghs: 500, capacity: 20, start_time: '10:00', admission: 'invite', bogus: 'x' } } })
  assertEquals(saved.status, 200)
  assertEquals(Number((await one('what-to-charge-for-automation')).price_ghs), 350)
  assertEquals(Number((await one('price-your-retainers')).price_ghs), 400)
  const ser = (await rows(`select defaults from public.workshop_series where slug = 'get-paid-for-automation'`))[0].defaults
  assertEquals(ser, { price_ghs: 500, capacity: 20, start_time: '10:00', admission: 'invite' }, 'only known keys are kept')
  // Put the series back as it was.
  await admin({ action: 'series_save', series: { slug: 'get-paid-for-automation', name: 'Get Paid for Automation', presenter: 'Bulletproof Automations',
    defaults: { kind: 'workshop', duration_minutes: 180, start_time: '11:30', format: 'live online', price_ghs: 350, capacity: 25,
      reserved_graduate_seats: 5, foundations_discount_pct: 20, graduate_free: true, admission: 'invite' } } })
})

Deno.test('Duplicate copies content and settings into a draft with no date, registrations, event or meeting', opts, async () => {
  const w1 = await one('what-to-charge-for-automation')
  await pg.exec(`update public.workshop_sessions set content = '{"summary":"Stop guessing what to charge.","outcomes":["Cost a project"],
    "faq":[{"q":"Recorded?","a":"No."}],"run_of_show":[{"at":"0:00","title":"Welcome","detail":""}]}'::jsonb,
    join_instructions = 'Join: https://meet.google.com/own-ersm-eet' where id = '${w1.id}'`)
  const copy = await admin({ action: 'session_copy', session_id: w1.id })
  assertEquals(copy.status, 200)
  const c = (await rows(`select * from public.workshop_sessions where id = $1`, [copy.json.id]))[0]
  assertEquals(c.slug, 'what-to-charge-for-automation-copy')
  assertEquals([c.status, c.starts_at, c.calendar_event_id, c.meet_link, c.join_instructions, c.announce, c.series_number],
    ['draft', null, null, null, null, false, null])
  assertEquals(c.content.outcomes, ['Cost a project'])
  assertEquals([Number(c.price_ghs), c.capacity, c.reserved_graduate_seats, c.admission], [350, 25, 5, 'invite'])
  assertEquals((await rows(`select count(*)::int n from public.workshop_registrations where session_id = $1`, [c.id]))[0].n, 0)
  const again = await admin({ action: 'session_copy', session_id: w1.id })
  assertEquals((await rows(`select slug from public.workshop_sessions where id = $1`, [again.json.id]))[0].slug, 'what-to-charge-for-automation-copy-2')
  // The original is untouched.
  assertEquals((await one('what-to-charge-for-automation')).calendar_event_id, 'ownersevent0001')
})

Deno.test('Schedule: one Calendar event with a Meet link and locked-down guests, then registration opens', opts, async () => {
  const w2 = await one('who-should-you-sell-to')
  await pg.exec(`update public.workshop_sessions set content = content || '{"summary":"Find the businesses that need your skills and can pay for them."}'::jsonb where id = '${w2.id}'`)
  calls.length = 0
  const res = await admin({ action: 'session_schedule', session_id: w2.id, session: { starts_at: day(40) } })
  assertEquals(res.status, 200, JSON.stringify(res.json))
  assertEquals(res.json.status, 'published')
  const w = await one('who-should-you-sell-to')
  const id = 'bpa' + w.id.replace(/-/g, '')
  assertEquals([w.status, w.calendar_event_id, w.calendar_managed, w.calendar_status], ['published', id, true, 'ready'])
  assert(/^https:\/\/meet\.google\.com\//.test(w.meet_link))
  const ev = events.get(id)!
  assertEquals([ev.guestsCanInviteOthers, ev.guestsCanSeeOtherGuests, ev.guestsCanModify], [false, false, false])
  assertEquals(ev.start.timeZone, 'Africa/Accra')
  assertEquals(new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime(), 180 * 60000)
  const create = calls.find((c) => c.method === 'POST')!
  assert(create.query.includes('conferenceDataVersion=1'))
  assertEquals(create.body!.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet')
  // The Meet link is private: never on the public page.
  const p = await page('/workshops/who-should-you-sell-to')
  assertEquals(p.status, 200)
  assert(!p.text.includes('meet.google.com'), 'meet link on a public page')
})

Deno.test('a retried schedule never makes a second event; a lost record is recovered from Google', opts, async () => {
  const w3 = await one('where-are-the-clients')
  await pg.exec(`update public.workshop_sessions set content = content || '{"summary":"Practical ways to find businesses that need automation."}'::jsonb where id = '${w3.id}'`)
  const id = 'bpa' + w3.id.replace(/-/g, '')
  // An earlier attempt reached Google but its answer was lost: the event exists, the row does not know.
  events.set(id, { id, status: 'confirmed', hangoutLink: 'https://meet.google.com/abc-defg-hij', summary: 'x' })
  const before = events.size
  const res = await admin({ action: 'session_schedule', session_id: w3.id, session: { starts_at: day(50) } })
  assertEquals(res.status, 200, JSON.stringify(res.json))
  assertEquals(events.size, before, 'no second event')
  const w = await one('where-are-the-clients')
  assertEquals([w.calendar_event_id, w.meet_link, w.status], [id, 'https://meet.google.com/abc-defg-hij', 'published'])
})

Deno.test('Google down: the workshop stays a draft with a clear error and Retry; Retry then completes it', opts, async () => {
  const w4 = await one('discover-what-clients-need')
  await pg.exec(`update public.workshop_sessions set content = content || '{"summary":"Ask the questions that reveal problems worth paying to solve."}'::jsonb where id = '${w4.id}'`)
  googleDown = true
  const res = await admin({ action: 'session_schedule', session_id: w4.id, session: { starts_at: day(60) } })
  googleDown = false
  assertEquals(res.status, 409)
  assertEquals(res.json.retry, true)
  assert(/couldn't be created/.test(res.json.error) && /still a draft/.test(res.json.error), res.json.error)
  let w = await one('discover-what-clients-need')
  assertEquals([w.status, w.calendar_event_id, w.calendar_status], ['draft', null, 'failed'])
  assertEquals((await page('/workshops/discover-what-clients-need')).text.includes('data-ws-form'), false)
  // Plain "Open registration" is refused too until the event exists.
  googleDown = true
  const pub = await admin({ action: 'session_publish', session_id: w4.id })
  googleDown = false
  assertEquals(pub.status, 409)
  assertEquals((await one('discover-what-clients-need')).status, 'draft')
  // Retry creates the event; scheduling again then opens registration.
  const retry = await admin({ action: 'calendar_retry', session_id: w4.id })
  assertEquals([retry.status, retry.json.calendar], [200, 'created'])
  const done = await admin({ action: 'session_schedule', session_id: w4.id, session: { starts_at: day(60) } })
  assertEquals(done.status, 200)
  w = await one('discover-what-clients-need')
  assertEquals([w.status, w.calendar_status], ['published', 'ready'])
})

Deno.test('a date change moves the event and emails guests; Workshop 01 keeps its own event and wording', opts, async () => {
  const w1 = await one('what-to-charge-for-automation')
  calls.length = 0
  const res = await admin({ action: 'session_save', session_id: w1.id, session: { starts_at: day(31, '12:00') } })
  assertEquals(res.status, 200, JSON.stringify(res.json))
  assertEquals(res.json.calendar, 'moved')
  assertEquals(calls.filter((c) => c.method === 'POST').length, 0, 'no new event')
  const patch = calls.find((c) => c.method === 'PATCH')!
  assert(patch.path.endsWith('/events/ownersevent0001'))
  assert(patch.query.includes('sendUpdates=all'), 'guests are emailed')
  assertEquals(patch.body!.summary, undefined, 'the owner\'s title is not rewritten')
  const ev = events.get('ownersevent0001')!
  assertEquals([ev.summary, ev.attendees.length, new Date(ev.start.dateTime).toISOString()], ["Johnathan's own title", 1, day(31, '12:00').replace('Z', '.000Z')])
  assertEquals((await one('what-to-charge-for-automation')).calendar_status, 'ready')
  // A title change alone does not touch the owner's event.
  calls.length = 0
  await admin({ action: 'session_save', session_id: w1.id, session: { title: 'You know automation. Do you know what to charge?' } })
  assertEquals(calls.length, 0)
})

Deno.test('a failed move is saved, reported, blocks reopening, and Retry fixes it', opts, async () => {
  const w2 = await one('who-should-you-sell-to')
  googleDown = true
  const res = await admin({ action: 'session_save', session_id: w2.id, session: { starts_at: day(41) } })
  googleDown = false
  assertEquals(res.status, 200)
  assertEquals(res.json.calendar, 'failed')
  assert(/Needs you/.test(res.json.warning), res.json.warning)
  assertEquals((await one('who-should-you-sell-to')).calendar_status, 'needs_update')
  // Close, then reopening is refused while the event is out of step.
  await admin({ action: 'session_close', session_id: w2.id })
  googleDown = true
  assertEquals((await admin({ action: 'session_publish', session_id: w2.id })).status, 409)
  googleDown = false
  const retry = await admin({ action: 'calendar_retry', session_id: w2.id })
  assertEquals([retry.status, retry.json.calendar], [200, 'moved'])
  const ev = events.get('bpa' + w2.id.replace(/-/g, ''))!
  assertEquals(new Date(ev.start.dateTime).toISOString(), day(41).replace('Z', '.000Z'))
  assertEquals((await admin({ action: 'session_publish', session_id: w2.id })).status, 200)
})

Deno.test('a duplicate gets its own event when scheduled, never the original\'s meeting', opts, async () => {
  const c = await one('what-to-charge-for-automation-copy')
  const res = await admin({ action: 'session_schedule', session_id: c.id, session: { starts_at: day(70), title: 'Pricing, second run' } })
  assertEquals(res.status, 200, JSON.stringify(res.json))
  const w = (await rows(`select * from public.workshop_sessions where id = $1`, [c.id]))[0]
  assert(w.calendar_event_id !== 'ownersevent0001' && w.calendar_event_id === 'bpa' + c.id.replace(/-/g, ''))
  assert(w.meet_link !== 'https://meet.google.com/own-ersm-eet')
})

Deno.test('Generate draft content: free models only, best first, past a bad draft, nothing saved', opts, async () => {
  const ranked = ai.rankFreeModels(MODELS, Date.parse('2026-11-11T00:00:00Z')).map((m: Row) => m.id)
  assertEquals(ranked.includes('paid/expensive') || ranked.includes('audio/music:free'), false, 'paid and audio models are never used')
  assertEquals(ranked.at(-1), 'openrouter/free')
  assert(ranked.indexOf('tiny/model-1.5b:free') > ranked.indexOf('good/writer-70b:free'), 'tiny models come last')
  ai.resetModelCache()
  const w5 = await one('scope-it-before-you-quote-it')
  const contentBefore = JSON.stringify(w5.content)
  asked.length = 0
  const res = await admin({ action: 'content_draft', title: w5.title, brief: 'Agree what you are building before you agree what it costs.',
    series_slug: 'get-paid-for-automation', series_number: 5, duration_minutes: 180 })
  assertEquals(res.status, 200, JSON.stringify(res.json))
  assertEquals(asked[0].model, 'flaky/thinker-120b:free')
  assertEquals(res.json.model, 'good/writer-70b:free', 'the incomplete draft was passed over')
  assertEquals(asked[0].auth, 'Bearer or-key')
  assertEquals(asked[0].format, 'json_schema')
  assert(asked[0].prompt.includes('Stop guessing what to charge.'), 'Workshop 01 is the model page')
  assertEquals(res.json.content.outcomes.length, 3)
  assertEquals(res.json.content.instructor, 'johnathan')
  assertEquals(JSON.stringify((await one('scope-it-before-you-quote-it')).content), contentBefore, 'nothing saved')
  // No key: a sentence saying what to set, no call made.
  asked.length = 0
  const nokey = await admin({ action: 'content_draft', title: 'X workshop', brief: 'Something worth ten characters.' }, { ...ENV, OPENROUTER_API_KEY: '' })
  assertEquals(nokey.status, 502)
  assert(/OPENROUTER_API_KEY/.test(nokey.json.error))
  assertEquals(asked.length, 0)
})

Deno.test('the release 7 rollback restores release 6 and the release applies again', opts, async () => {
  await pg.exec(await Deno.readTextFile(u('../supabase/migrations/rollback/20261114120000_workshop_admin_streamline_down.sql')))
  assertEquals((await rows(`select count(*)::int n from information_schema.columns where table_name = 'workshop_sessions' and column_name in ('meet_link','calendar_status')`))[0].n, 0)
  assertEquals((await one('who-should-you-sell-to')).calendar_event_id, 'bpa' + (await one('who-should-you-sell-to')).id.replace(/-/g, ''), 'event IDs stay')
  await pg.exec(await Deno.readTextFile(u('../supabase/migrations/20261114120000_workshop_admin_streamline.sql')))
  assertEquals((await one('who-should-you-sell-to')).calendar_status, 'ready')
})
