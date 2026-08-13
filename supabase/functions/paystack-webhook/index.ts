/**
 * paystack-webhook — the only thing allowed to say that money arrived.
 *
 * Paystack calls this directly, server to server. The visitor's browser is
 * never involved and is never trusted: /thank-you receives the customer back
 * with ?reference= in the URL, and that query string is typed by whoever holds
 * the browser. If payment status were written from it, anyone could mark
 * themselves paid by editing a URL.
 *
 * What makes this trustworthy instead is the x-paystack-signature header: an
 * HMAC-SHA512 of the exact raw request body, keyed with the Paystack secret
 * key. Only Paystack and this function know that key. A body that does not
 * verify is recorded and then ignored.
 *
 * Deploy to the CURRENT training project (not the old one):
 *   supabase functions deploy paystack-webhook --project-ref <ref> --no-verify-jwt
 *
 * --no-verify-jwt matters: Paystack does not send a Supabase JWT, so the
 * platform's own auth gate must be off. This function's auth is the signature.
 *
 * Secrets (Supabase dashboard -> Edge Functions -> Secrets, never in the repo):
 *   PAYSTACK_SECRET_KEY        sk_live_… — the live key
 *   PAYSTACK_TEST_SECRET_KEY   sk_test_… — optional, see below
 *   PROJECT_URL                https://<ref>.supabase.co
 *   SERVICE_ROLE_KEY           bypasses RLS; required to write the roll
 *
 * ---------------------------------------------------------------------------
 * WHY TWO KEYS
 * ---------------------------------------------------------------------------
 *
 * Paystack keeps test and live entirely separate: separate keys, separate
 * webhook URLs, separate dashboards. Both webhook URLs can be pointed at THIS
 * function, which is what lets the whole payment path be exercised while the
 * business activation request is still pending — a test charge signs with the
 * test key, a live one with the live key, and each is verified against its own.
 *
 * Setting PAYSTACK_TEST_SECRET_KEY is therefore how you turn testing on, and
 * removing it is how you turn it off. Neither affects live payments.
 *
 * ---------------------------------------------------------------------------
 * THE MODE INVARIANT — the thing that makes testing safe
 * ---------------------------------------------------------------------------
 *
 * A verified signature proves Paystack sent the event. It does NOT prove money
 * moved: a test charge is signed just as properly as a live one. Crediting a
 * real seat with a test payment would be indistinguishable, on the roll, from
 * being paid.
 *
 * So references carry their mode in the prefix — BPA-CAB- for live, BPA-TEST-
 * for test, minted in functions/api/_paystack.js — and an event is applied only
 * when the reference's mode matches data.domain. A test charge can only ever
 * settle a test enrollment. Both are still recorded either way.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const PAYSTACK_SECRET_KEY = Deno.env.get('PAYSTACK_SECRET_KEY')
const PAYSTACK_TEST_SECRET_KEY = Deno.env.get('PAYSTACK_TEST_SECRET_KEY')
const PROJECT_URL = Deno.env.get('PROJECT_URL')
const SERVICE_ROLE_KEY = Deno.env.get('SERVICE_ROLE_KEY')

/** live | test, from the prefix we minted the reference with. */
function referenceMode(reference: unknown): 'live' | 'test' | null {
  if (typeof reference !== 'string') return null
  if (reference.startsWith('BPA-CAB-')) return 'live'
  if (reference.startsWith('BPA-TEST-')) return 'test'
  // Not ours: a hosted payment page, or a charge raised from the dashboard.
  return null
}

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

/** HMAC-SHA512 of the raw body, hex encoded, under one specific key. */
async function sign(raw: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Length-independent comparison, so a mismatch leaks nothing through timing. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  // The body must be read as raw text. Parsing and re-serialising would change
  // key order and whitespace, and the signature is over the exact bytes sent.
  const raw = await req.text()

  /* Try each configured key and remember which one matched.
   *
   * Both are tried in full rather than short-circuiting on the live key,
   * because which key verified is the answer to "was this real money" and the
   * cost is one extra HMAC over a body of a few hundred bytes. Every key is
   * attempted even after a match for the same reason the comparison is
   * length-independent: the work should not depend on the secret. */
  let valid = false
  let signedBy: 'live' | 'test' | null = null
  try {
    const header = req.headers.get('x-paystack-signature') || ''
    if (header.length > 0) {
      const candidates: Array<['live' | 'test', string | undefined]> = [
        ['live', PAYSTACK_SECRET_KEY],
        ['test', PAYSTACK_TEST_SECRET_KEY],
      ]
      for (const [mode, secret] of candidates) {
        if (!secret) continue
        if (sameSecret(await sign(raw, secret), header) && !valid) {
          valid = true
          signedBy = mode
        }
      }
    }
  } catch (_) {
    valid = false
    signedBy = null
  }

  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw)
  } catch (_) {
    return new Response('Bad JSON', { status: 400 })
  }

  const data = (body.data || {}) as Record<string, any>
  const email: string | null = data?.customer?.email ?? null
  // Paystack sends minor units. GHS 750.00 arrives as 75000 pesewas.
  const amountGhs = typeof data?.amount === 'number' ? data.amount / 100 : null

  // Log first, always — including events that fail verification. An attacker
  // probing the endpoint is exactly the thing you want a record of, and an
  // event that cannot be matched must never be silently dropped.
  const insert = await db('payment_events?on_conflict=provider,event,reference', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({
      provider: 'paystack',
      event: body.event ?? null,
      reference: data?.reference ?? null,
      email,
      amount_ghs: amountGhs,
      status: data?.status ?? null,
      paid_at: data?.paid_at ?? data?.paidAt ?? null,
      signature_valid: valid,
      raw: body,
    }),
  })

  /* A write that FAILED and an event we have ALREADY SEEN are opposite claims,
   * and they used to leave by the same door: both produced an empty `inserted`,
   * and both answered 200.
   *
   * Paystack retries only on a non-2xx. So a Supabase outage during a real
   * charge.success was answered "thank you, duplicate", Paystack marked the
   * event delivered and stopped trying, and the payment was never applied and
   * never retried — money taken, seat not recorded, no second chance.
   *
   * Same shape as the /verify bug where a service failure rendered as "no
   * credential matches": a failure must never be reported as a normal negative
   * result. There it cost credibility; here it costs a seat. */
  if (!insert.ok) {
    const detail = await insert.text().catch(() => '')
    console.error('payment_events insert failed', insert.status, detail.slice(0, 300))
    return new Response(JSON.stringify({ ok: false, error: 'log-write-failed' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let inserted: any[] = []
  try {
    const parsed = await insert.json()
    inserted = Array.isArray(parsed) ? parsed : []
  } catch (_err) {
    console.error('payment_events insert returned an unreadable body')
    return new Response(JSON.stringify({ ok: false, error: 'log-write-unreadable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let eventRow: Record<string, any>

  if (inserted.length === 0) {
    /* on_conflict=ignore-duplicates returns nothing for an event already in the
     * table. Usually that is a replay of one we finished applying — but it is
     * also exactly what a RETRY looks like after an earlier attempt logged the
     * event and then died before the money moved. Those need opposite handling,
     * and `matched` is the evidence for which one happened.
     *
     * Without this branch the 503s added above would be theatre: Paystack would
     * retry, the retry would hit the duplicate guard, and the payment would be
     * dropped on the second pass instead of the first. */
    const prior = await db(
      `payment_events?select=id,matched&provider=eq.paystack` +
        `&event=eq.${encodeURIComponent(String(body.event ?? ''))}` +
        `&reference=eq.${encodeURIComponent(String(data?.reference ?? ''))}&limit=1`,
    )
    const priorRows = prior.ok ? await prior.json().catch(() => null) : null

    if (priorRows === null) {
      console.error('could not read back the duplicate event')
      return new Response(JSON.stringify({ ok: false, error: 'log-read-failed' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    /* Already applied, or not ours to apply. Stop here — applying a second time
     * would add the money twice, which is the failure the dedupe key exists to
     * prevent. */
    if (!Array.isArray(priorRows) || priorRows.length === 0 || priorRows[0].matched === true) {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Logged, never applied. Carry on and apply it now.
    eventRow = priorRows[0]
  } else {
    eventRow = inserted[0]
  }

  // Everything below moves money, so it happens only for a verified successful
  // charge. An unverified body is already recorded above and goes no further.
  if (!valid || body.event !== 'charge.success' || !email) {
    return new Response(JSON.stringify({ ok: true, applied: false, signature_valid: valid }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /* THE MODE INVARIANT. See the header.
   *
   * data.domain is Paystack's own statement of which environment the charge
   * happened in, and the reference prefix is ours. They must agree, and both
   * must agree with the key that verified the signature. Any disagreement is
   * recorded and applied to nothing — it means either a test charge reaching
   * for a real enrollment, or a configuration mistake, and there is no reading
   * of it under which crediting a seat is correct. */
  const domain: string | null = typeof data?.domain === 'string' ? data.domain : null
  const refMode = referenceMode(data?.reference)

  if (domain && signedBy && domain !== signedBy) {
    await db(`payment_events?id=eq.${eventRow.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        matched: false,
        match_note: `Refused: domain ${domain} but signed with the ${signedBy} key`,
      }),
    })
    return new Response(JSON.stringify({ ok: true, applied: false, matched: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (refMode && domain && refMode !== domain) {
    await db(`payment_events?id=eq.${eventRow.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        matched: false,
        match_note: `Refused: ${refMode} reference on a ${domain} charge`,
      }),
    })
    return new Response(JSON.stringify({ ok: true, applied: false, matched: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /* A test charge with no BPA-TEST- reference did not come from this site's
     enrollment form — it was raised from the dashboard, or by an old hosted
     page. Log it and stop. Falling through to the email join would let a test
     charge settle a real person's seat, which is the exact failure the
     invariant exists to prevent. */
  if (domain === 'test' && refMode !== 'test') {
    await db(`payment_events?id=eq.${eventRow.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        matched: false,
        match_note: 'Test-mode charge with no test reference; not applied',
      }),
    })
    return new Response(JSON.stringify({ ok: true, applied: false, matched: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /* Match on OUR reference first.
   *
   * /api/enroll mints the reference before handing the browser to Paystack and
   * stores it on the row, so this join is exact. Email is kept as a fallback
   * for live charges only, because it is what a Paystack-hosted page or a
   * dashboard-raised charge leaves behind — but it is genuinely worse: it
   * fails on a typo, and it picks the wrong row when one person enrolls from
   * two addresses. */
  let rows: any[] = []
  let matchedOn = 'reference'
  let lookupFailed = false

  if (typeof data?.reference === 'string' && data.reference) {
    const byRef = await db(
      `enrollments?select=id,amount_ghs,amount_paid_ghs,payment_status` +
        `&paystack_reference=eq.${encodeURIComponent(data.reference)}&limit=1`,
    )
    if (!byRef.ok) lookupFailed = true
    else rows = await byRef.json().catch(() => [])
  }

  if (!lookupFailed && (!Array.isArray(rows) || rows.length === 0) && domain !== 'test') {
    matchedOn = 'email'
    const found = await db(
      `enrollments?select=id,amount_ghs,amount_paid_ghs,payment_status` +
        `&email=eq.${encodeURIComponent(email)}` +
        `&payment_status=neq.cancelled&order=created_at.desc&limit=1`,
    )
    if (!found.ok) lookupFailed = true
    else rows = await found.json().catch(() => [])
  }

  /* A query that could not run and a query that found nothing are, again, not
   * the same claim. Writing "No enrollment matched this reference or email"
   * because the database was unreachable would strand a real payment as
   * unmatched for ever, with no retry coming to correct it. */
  if (lookupFailed) {
    console.error('enrollment lookup failed for reference', data?.reference)
    return new Response(JSON.stringify({ ok: false, error: 'enrollment-lookup-failed' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    // Unmatched, not lost. It sits in payment_events for reconciliation, which
    // is exactly the case a dispute turns into.
    await db(`payment_events?id=eq.${eventRow.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        matched: false,
        match_note: 'No enrollment matched this reference or email',
      }),
    })
    return new Response(JSON.stringify({ ok: true, applied: false, matched: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const enrollment = rows[0]
  // Added, not overwritten: the instalment plan is GHS 400 then 350, and a
  // second payment must accumulate rather than replace the first.
  const paid = Number(enrollment.amount_paid_ghs || 0) + Number(amountGhs || 0)
  const due = Number(enrollment.amount_ghs || 0)
  const status = due > 0 && paid + 0.001 >= due ? 'paid' : paid > 0 ? 'partially_paid' : enrollment.payment_status

  const applied = await db(`enrollments?id=eq.${enrollment.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      amount_paid_ghs: paid,
      payment_status: status,
      paystack_reference: data?.reference ?? null,
      paystack_payment_date: data?.paid_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  })

  /* The money write, and the worst of the three to misreport: the response said
   * applied:true and Paystack never came back. Nothing has been applied if this
   * failed, so a 503 is safe — the retry finds the event logged-but-unmatched
   * and drives it again. */
  if (!applied.ok) {
    const detail = await applied.text().catch(() => '')
    console.error('enrollment update failed', applied.status, detail.slice(0, 300))
    return new Response(JSON.stringify({ ok: false, error: 'enrollment-update-failed' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const noted = await db(`payment_events?id=eq.${eventRow.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      matched: true,
      enrollment_id: enrollment.id,
      match_note: `Matched on ${matchedOn}${domain === 'test' ? ' (TEST)' : ''}; ${paid} of ${due} GHS paid`,
    }),
  })

  /* Deliberately NOT fatal, and the one place in this function where a failed
   * write still answers 200. The money is already applied; a retry would find
   * the event still unmatched and add the amount a second time. Losing the
   * ledger note is recoverable by hand from the /admin payments view. Losing
   * the money is not. */
  if (!noted.ok) {
    console.error('applied payment but could not mark event', eventRow.id, 'as matched')
  }

  return new Response(JSON.stringify({ ok: true, applied: true, payment_status: status }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
