/**
 * workshop-paystack-webhook: the webhook of the SEPARATE Paystack business
 * "Bulletproof Automations Webinars". New and self-contained. The training
 * webhook (paystack-webhook, production v9) is not changed and never sees a
 * webinar charge, because webinar checkouts are created with this business's
 * keys and Paystack sends each business's events only to its own webhook URL.
 *
 * What it can touch: workshop_payment_events (its own ledger) and, through the
 * workshop_apply_charge / workshop_apply_refund RPCs, workshop_* tables only.
 * It has no code path to enrollments, payment_plan_installments, payment_events
 * or anything belonging to Bulletproof Scheduling.
 *
 * Deploy (owner approval required):
 *   supabase functions deploy workshop-paystack-webhook --project-ref <ref> --no-verify-jwt
 * --no-verify-jwt is required: Paystack sends no Supabase JWT; the HMAC is the auth.
 *
 * Secrets (Supabase, Edge Function secrets; set by the owner):
 *   WORKSHOP_PAYSTACK_SECRET_KEY       sk_live_…  of the WEBINAR business
 *   WORKSHOP_PAYSTACK_TEST_SECRET_KEY  sk_test_…  of the WEBINAR business
 *   PROJECT_URL, SERVICE_ROLE_KEY      already set for the training webhook
 *
 * Guard: if either webinar key equals the training business's PAYSTACK_SECRET_KEY
 * or PAYSTACK_TEST_SECRET_KEY (also visible as project secrets), it refuses to
 * run. Equal keys would mean one Paystack business, i.e. the separation this
 * function exists for would not be real.
 */

const LIVE_KEY = Deno.env.get('WORKSHOP_PAYSTACK_SECRET_KEY') ?? ''
const TEST_KEY = Deno.env.get('WORKSHOP_PAYSTACK_TEST_SECRET_KEY') ?? ''
const TRAINING_KEYS = [Deno.env.get('PAYSTACK_SECRET_KEY'), Deno.env.get('PAYSTACK_TEST_SECRET_KEY')].filter(Boolean)
const PROJECT_URL = Deno.env.get('PROJECT_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY')

export function keysProblem(live: string, test: string, training: (string | undefined)[]): string | null {
  if (live && !live.startsWith('sk_live_')) return 'WORKSHOP_PAYSTACK_SECRET_KEY is not a live secret key'
  if (test && !test.startsWith('sk_test_')) return 'WORKSHOP_PAYSTACK_TEST_SECRET_KEY is not a test secret key'
  if (!live && !test) return 'no webinar Paystack key configured'
  if ([live, test].some((k) => k && training.includes(k))) return 'a webinar key equals a training key: not a separate Paystack business'
  return null
}
const CONFIG_PROBLEM = keysProblem(LIVE_KEY, TEST_KEY, TRAINING_KEYS)

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const db = (path: string, init: RequestInit = {}) =>
  fetch(`${PROJECT_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })

async function hmac(raw: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
const first = (...v: unknown[]) => (v.find((x) => typeof x === 'string' && x) as string | undefined) ?? null

/** live | test from a webinar reference; null for anything else. */
function referenceMode(ref: unknown): 'live' | 'test' | null {
  if (typeof ref !== 'string') return null
  if (ref.startsWith('BPA-WEB-')) return 'live'
  if (ref.startsWith('BPA-WTEST-')) return 'test'
  return null
}

async function note(id: string, matched: boolean, text: string): Promise<Response | null> {
  const r = await db(`workshop_payment_events?id=eq.${id}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ matched, match_note: text }),
  })
  return r.ok ? null : json({ ok: false, error: 'event-note-failed' }, 503)
}

export async function handle(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  if (CONFIG_PROBLEM) {
    console.error('workshop webhook misconfigured:', CONFIG_PROBLEM)
    return json({ ok: false, error: 'not-configured' }, 503)
  }
  const raw = await req.text()

  let valid = false
  let signedBy: 'live' | 'test' | null = null
  const header = req.headers.get('x-paystack-signature') || ''
  for (const [mode, secret] of [['live', LIVE_KEY], ['test', TEST_KEY]] as const) {
    if (secret && header && same(await hmac(raw, secret), header) && !valid) { valid = true; signedBy = mode }
  }

  let body: Record<string, any>
  try { body = JSON.parse(raw) } catch (_) { return new Response('Bad JSON', { status: 400 }) }
  const data = (body.data || {}) as Record<string, any>
  const isCharge = body.event === 'charge.success'
  const isRefund = body.event === 'refund.processed'
  const reference = isRefund ? first(data.transaction_reference, data.transaction?.reference, data.reference) : first(data.reference)
  // Refunds are keyed per refund, so two partial refunds are two rows and a replay is one.
  const refundId = isRefund ? first(data.id != null ? String(data.id) : null, data.refund_reference) : null
  const stored = isRefund && reference ? `${reference}:refund${refundId ? ':' + refundId : ''}` : reference

  // Log first, always, including events that fail verification.
  const ins = await db('workshop_payment_events?on_conflict=event,reference', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({
      event: body.event ?? null, reference: stored, email: data.customer?.email ?? null,
      amount_minor: typeof data.amount === 'number' ? Math.round(data.amount) : null,
      currency: data.currency ?? null, status: data.status ?? null, domain: data.domain ?? null,
      paid_at: data.paid_at ?? data.paidAt ?? null, signature_valid: valid, raw: body,
    }),
  })
  if (!ins.ok) return json({ ok: false, error: 'log-write-failed' }, 503)
  const inserted = await ins.json().catch(() => null)
  if (!Array.isArray(inserted)) return json({ ok: false, error: 'log-write-unreadable' }, 503)
  let eventRow = inserted[0]
  if (!eventRow) {
    // Seen before: a replay of an applied event stops; a retry of one never applied continues.
    const prior = await db(`workshop_payment_events?select=id,matched&event=eq.${encodeURIComponent(String(body.event ?? ''))}` +
      `&reference=eq.${encodeURIComponent(String(stored ?? ''))}&limit=1`)
    const rows = prior.ok ? await prior.json().catch(() => null) : null
    if (!Array.isArray(rows)) return json({ ok: false, error: 'log-read-failed' }, 503)
    if (!rows.length || rows[0].matched === true) return json({ ok: true, duplicate: true })
    eventRow = rows[0]
  }

  if (!valid || (!isCharge && !isRefund)) return json({ ok: true, applied: false, signature_valid: valid })

  const domain = typeof data.domain === 'string' ? data.domain : null
  if (domain && signedBy && domain !== signedBy) {
    return (await note(eventRow.id, false, `Refused: ${domain} event signed with the ${signedBy} key`)) ?? json({ ok: true, applied: false })
  }
  const refMode = referenceMode(reference)
  // Only references this site minted for webinars are ever applied. Anything
  // else on this business (a dashboard charge, a misrouted event) is recorded
  // and left for a person; it can never reach an enrollment because no code
  // here can write one.
  if (!refMode) {
    return (await note(eventRow.id, false, 'Not a webinar reference; recorded only')) ?? json({ ok: true, applied: false })
  }
  if (domain && refMode !== domain) {
    return (await note(eventRow.id, false, `Refused: ${refMode} webinar reference on a ${domain} event`)) ?? json({ ok: true, applied: false })
  }

  const amountMinor = typeof data.amount === 'number' ? Math.round(data.amount) : null
  const rpc = isRefund ? 'workshop_apply_refund' : 'workshop_apply_charge'
  const args = isRefund
    ? { p_reference: reference, p_amount_minor: amountMinor, p_domain: domain ?? signedBy, p_payment_event_id: eventRow.id }
    : { p_reference: reference, p_amount_minor: amountMinor, p_currency: data.currency ?? null, p_domain: domain ?? signedBy,
        p_paid_at: data.paid_at ?? data.paidAt ?? null, p_via: 'webhook', p_payment_event_id: eventRow.id }
  let res: Response
  try { res = await db(`rpc/${rpc}`, { method: 'POST', body: JSON.stringify(args) }) } catch (_) {
    return json({ ok: false, error: 'apply-failed' }, 503)
  }
  // One transaction that also writes the ledger note: on failure nothing moved
  // and Paystack's retry applies it exactly once.
  if (!res.ok) return json({ ok: false, error: 'apply-failed' }, 503)
  const out = await res.json().catch(() => null)
  const outcome = out && typeof out.outcome === 'string' ? out.outcome : 'unknown'
  return json({ ok: true, applied: ['confirmed', 'review', 'duplicate_payment', 'mismatch', 'applied'].includes(outcome), outcome })
}

if (import.meta.main) Deno.serve(handle)
