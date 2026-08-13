/* POST /api/enroll — register for the cohort, and start payment if payment is
 * switched on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MOVED OFF THE BROWSER
 * ---------------------------------------------------------------------------
 *
 * Until now the enrollment form inserted straight into Supabase with the anon
 * key, and no money moved. That was sound while payment was arranged by hand.
 * It stops being sound the moment a transaction is initialized, for one
 * reason: whatever amount is sent to Paystack is the amount charged. A price
 * table in assets/js/shell.js is a price table the visitor can edit, so the
 * devtools console becomes a discount code. The amount is now decided here,
 * from the table in _paystack.js, and the browser sends only which option was
 * chosen.
 *
 * Minting our own reference is the second reason. A hosted payment page mints
 * its own, which left the webhook joining payments to enrollments on email —
 * the only key the two systems happened to share, and one that fails on a typo
 * or a second address. Initializing server-side lets us set the reference
 * ourselves, so the join is exact and the mode invariant in _paystack.js
 * becomes enforceable.
 *
 * ---------------------------------------------------------------------------
 * THIS ENDPOINT MUST NEVER LOSE AN ENROLLMENT
 * ---------------------------------------------------------------------------
 *
 * The cohort caps at 25 and enrollment closes on 8 September 2026. Every
 * failure path here therefore ends with the enrollment recorded and the
 * visitor told they are on the list, never with a dead button:
 *
 *   Paystack not configured   -> row written, "reserve" returned
 *   Paystack refuses or times -> row written, "reserve" returned
 *   this Function not deployed-> the page falls back to the old direct anon
 *                                insert (see assets/js/shell.js)
 *
 * "reserve" is not a degraded state invented for this change. It is exactly
 * the flow that ran in production before Paystack existed, and #enroll-done on
 * the BCAB page is already written for it.
 */

import { json, refuse, readJson, str } from "./_shared.js";
import {
  OPTIONS,
  EXPERIENCE_LEVELS,
  COHORT,
  POLICY_VERSION,
  paystackMode,
  mintReference,
  amountDue,
  initializeTransaction
} from "./_paystack.js";

/* PostgREST with the service key.
 *
 * /api/verify deliberately touches no table — its whole surface is one RPC,
 * because a readable view granted to anon can be dumped. This endpoint is the
 * opposite case: it writes a row nobody is allowed to read back, so the
 * service key is bypassing RLS to do the one thing RLS is configured to
 * forbid the browser. Nothing here ever returns a row to the caller. */
function db(env, path, init) {
  return fetch(env.SUPABASE_URL + "/rest/v1/" + path, Object.assign({}, init, {
    headers: Object.assign({
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json"
    }, (init && init.headers) || {})
  }));
}

function looksLikeEmail(value) {
  // Deliberately loose. The authoritative check is that Paystack's receipt
  // reaches them; rejecting valid addresses to look rigorous costs enrollments.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export async function onRequest({ request, env }) {
  /* GET reports which mode the account is in, and nothing else.
   *
   * The page uses it for one purpose: showing the test-mode banner only when
   * the server confirms it is holding test keys, rather than trusting
   * ?paystack=test in the address bar. That matters because the banner must be
   * impossible to summon once the live key is in — a visitor who can make a
   * real checkout claim to be a test is a visitor who can dispute a real
   * charge.
   *
   * Three values, none of them a secret: off, test, live. It is the same
   * reasoning as the not_configured response in _shared.js — nobody can
   * exploit "this site is not switched on", and hiding it wastes an
   * afternoon. */
  if (request.method === "GET") {
    const url = new URL(request.url);
    const reference = url.searchParams.get("reference") || url.searchParams.get("trxref") || "";

    /* Without a reference this is the mode probe described above, unchanged.
     *
     * WITH one, it also reports which offering that reference was minted for,
     * so /thank-you can tell somebody who booked a readiness review what
     * happens next instead of the cohort's dates. Before this, every visitor
     * read the cohort sequence — a Path B candidate was told they had bought a
     * five-week programme they had not bought.
     *
     * The page could have carried the offering in the callback URL instead,
     * which would have been three lines and no endpoint. This is the version
     * that is still right in six months: it survives the link being shared or
     * bookmarked, and it does not ask the page to trust a query string, which
     * is the one thing /thank-you has always refused to do.
     *
     * ONE FIELD, AND NOT A SENSITIVE ONE. `chosen_option` is which of three
     * published prices somebody picked. No name, no email, no amount, no
     * payment status — payment status in particular stays out, because this
     * response is reachable by anyone holding the reference and the
     * authoritative record is the webhook's. The reference itself is ten
     * random Crockford characters, so it is not enumerable. */
    let option = null;

    if (
      reference &&
      /^[A-Za-z0-9._-]{6,64}$/.test(reference) &&
      env.SUPABASE_URL &&
      env.SUPABASE_SERVICE_ROLE_KEY
    ) {
      try {
        const res = await db(
          env,
          "enrollments?select=chosen_option&paystack_reference=eq." +
            encodeURIComponent(reference) +
            "&limit=1"
        );
        if (res.ok) {
          const rows = await res.json();
          /* Checked against the price table rather than returned as stored, so
             a value that somehow got into the column cannot be echoed back to
             a browser. */
          if (Array.isArray(rows) && rows.length && OPTIONS[rows[0].chosen_option]) {
            option = rows[0].chosen_option;
          }
        }
      } catch (err) {
        /* A lookup that fails leaves option null, and the page keeps showing
           the neutral copy. Losing the tailored wording is a worse page; it is
           not a wrong one. */
      }
    }

    /* `option` appears only when one was asked for. Without a reference this
       response is byte-for-byte the mode probe it has always been, which keeps
       the contract in the comment above true rather than nearly true. */
    const payload = { ok: true, paystack: paystackMode(env) };
    if (reference) payload.option = option;
    return json(payload);
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }

  const body = await readJson(request, 4096);
  if (!body) return refuse("bad-body");

  /* Honeypot. A real person never sees the field, so anything in it is a bot.
     It is told the reservation worked — a bot that receives an error learns to
     retry, and one that receives success learns nothing. Checked before
     validation so a bot cannot distinguish itself by which error it gets. */
  if (str(body.company_website, 200)) {
    return json({ ok: true, mode: "reserve" });
  }

  const full_name = str(body.full_name, 120);
  const email = str(body.email, 160).toLowerCase();
  const whatsapp = str(body.whatsapp, 40);
  const city = str(body.city, 80);
  const experience_level = str(body.experience_level, 40);
  const option = str(body.chosen_option, 40);
  const instalments = body.payment_plan === true;

  if (!full_name || full_name.length < 2) return refuse("name-missing");
  if (!looksLikeEmail(email)) return refuse("email-invalid");
  if (!whatsapp || whatsapp.replace(/\D/g, "").length < 7) return refuse("whatsapp-invalid");
  if (!city) return refuse("city-missing");
  if (EXPERIENCE_LEVELS.indexOf(experience_level) === -1) return refuse("experience-level-invalid");
  if (!Object.prototype.hasOwnProperty.call(OPTIONS, option)) return refuse("option-invalid");

  /* Both acknowledgements are required to submit, and both are required here
     too. The page enforcing them is not the same as the record showing they
     were given: the value of these is the defensibility argument, and a
     defence that rests on markup nobody kept is not a defence. */
  if (body.ack_refund !== true || body.ack_certification !== true) {
    return refuse("acknowledgements-missing");
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return refuse("supabase-not-configured", 503);
  }

  const mode = paystackMode(env);

  /* A test key alone must not send anybody to a checkout — see the long note in
     _paystack.js. The opt-in is set by the page only when it was loaded with
     ?paystack=test, so a visitor who has not deliberately asked for the test
     flow gets the reservation flow they would have got yesterday. */
  const testing = mode === "test" && body.testOptIn === true;
  const charging = mode === "live" || testing;

  const price = OPTIONS[option];
  const due = amountDue(option, instalments);
  const reference = charging ? mintReference(mode) : null;

  const row = {
    full_name: full_name,
    email: email,
    whatsapp: whatsapp,
    city: city,
    experience_level: experience_level,
    chosen_option: option,
    // Server-decided, from the table in _paystack.js. The full commitment goes
    // in the row even when only the first instalment is being taken now, so
    // /admin's outstanding figure is right from the first payment.
    amount_ghs: price.total,
    payment_plan: instalments,
    cohort: COHORT,
    consent_given: body.consent_given === true,
    ack_refund: true,
    ack_certification: true,
    acks_policy_version: POLICY_VERSION,
    // Constrained to website | showcase | whatsapp | referral.
    source: "website",
    // 'reserved' is the table default and means "on the list, nothing owed to
    // a processor yet". Once we are about to hand them to Paystack,
    // 'payment_pending' is the honest value.
    payment_status: charging ? "payment_pending" : "reserved",
    paystack_reference: reference,
    // Test rows are real rows in the real table, so they must announce
    // themselves. /admin filters on this marker, and everything carrying it
    // should be deleted before the live key goes in.
    notes: testing ? "[TEST] Paystack test-mode transaction. Delete before launch." : null
  };

  if (instalments) row.first_instalment_ghs = price.firstInstalment;

  /* Prefer: return=representation is safe here and refused for the browser.
     anon has no SELECT policy, so the old client-side insert had to send
     return=minimal; the service key has no such limit, and we need the id to
     put in Paystack's metadata. */
  let insert = await db(env, "enrollments", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });

  let enrollment = null;

  if (insert.status === 409) {
    /* Unique on (cohort, email) and (cohort, whatsapp).
     *
     * Before payment existed, a conflict meant one thing: you already
     * reserved, so say so. With a checkout in the flow it usually means
     * something else entirely — somebody reached Paystack, abandoned it, and
     * came back to try again. Telling that person "you already have a place"
     * would leave them unable to pay for the place they are trying to buy, on
     * the page whose whole job is to sell it. */
    const resumed = await resume(env, email, whatsapp);
    if (!resumed) return refuse("conflict-without-row", 409);

    if (resumed.payment_status === "paid") {
      return json({ ok: false, code: "already_paid" }, 409);
    }
    if (resumed.payment_status === "partially_paid") {
      // Instalments after the first are arranged over Slack and paid by MoMo,
      // per the brief. There is nothing for a checkout to do here.
      return json({ ok: false, code: "instalment_outstanding" }, 409);
    }
    if (resumed.payment_status === "cancelled") {
      return json({ ok: false, code: "cancelled" }, 409);
    }

    enrollment = resumed;

    if (charging) {
      // A fresh reference per attempt. Reusing one Paystack has already seen
      // in an abandoned session is the reliable way to get a duplicate-
      // reference error at the worst possible moment.
      await db(env, "enrollments?id=eq." + encodeURIComponent(resumed.id), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          paystack_reference: reference,
          payment_status: "payment_pending",
          updated_at: new Date().toISOString()
        })
      });
    }
  } else if (!insert.ok) {
    const detail = (await insert.text()).slice(0, 300);
    console.log("enroll-insert-failed:", insert.status, detail);
    return refuse("insert-" + insert.status, 502);
  } else {
    const rows = await insert.json();
    enrollment = Array.isArray(rows) ? rows[0] : rows;
  }

  if (!charging) {
    return json({ ok: true, mode: "reserve", paystack: mode });
  }

  const origin = new URL(request.url).origin;
  const started = await initializeTransaction(env, {
    email: email,
    amountGhs: due,
    reference: reference,
    callbackUrl: origin + "/thank-you",
    enrollmentId: enrollment && enrollment.id,
    option: option,
    instalments: instalments,
    fullName: full_name,
    whatsapp: whatsapp
  });

  if (!started.ok) {
    /* The enrollment is already written, so this is a payment failure, not an
       enrollment failure, and it must not read as one. Fall back to the
       reservation wording: they are on the list and we will reach them on
       WhatsApp, which is true and is what would have happened anyway. */
    console.log("enroll-initialize-failed:", started.reason);
    await db(env, "enrollments?id=eq." + encodeURIComponent(enrollment.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        payment_status: "reserved",
        notes: (row.notes ? row.notes + " " : "") + "Checkout could not be started: " + started.reason,
        updated_at: new Date().toISOString()
      })
    });
    return json({ ok: true, mode: "reserve", paystack: mode, checkout: "unavailable" });
  }

  return json({
    ok: true,
    mode: "checkout",
    url: started.url,
    reference: reference,
    // The page shows an unmissable test banner on this. A test checkout that
    // looks like a real one is the single worst outcome available here.
    test: mode === "test"
  });
}

/* The row behind a 409. Email first, because that is the conflict people
   actually hit; the WhatsApp index catches the case of one person using two
   addresses, and is worth the second round trip only when the first misses. */
async function resume(env, email, whatsapp) {
  const select = "select=id,payment_status,amount_ghs,amount_paid_ghs&cohort=eq." +
    encodeURIComponent(COHORT) + "&limit=1";

  let res = await db(env, "enrollments?" + select + "&email=eq." + encodeURIComponent(email));
  let rows = res.ok ? await res.json() : [];
  if (Array.isArray(rows) && rows.length) return rows[0];

  res = await db(env, "enrollments?" + select + "&whatsapp=eq." + encodeURIComponent(whatsapp));
  rows = res.ok ? await res.json() : [];
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
