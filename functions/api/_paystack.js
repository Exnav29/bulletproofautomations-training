/* Paystack: the price table, mode detection, and reference minting.
 *
 * Not routed — files under functions/ beginning with an underscore never
 * become endpoints.
 *
 * ---------------------------------------------------------------------------
 * THE KEY IS THE MODE SWITCH
 * ---------------------------------------------------------------------------
 *
 * There is no PAYSTACK_MODE variable, deliberately. Paystack secret keys are
 * prefixed sk_test_ and sk_live_, so the key already states which environment
 * it belongs to, and a separate flag could only ever disagree with it. Pasting
 * the live key into the Cloudflare Pages project is the entire activation
 * step: no code, markup or price changes.
 *
 *   no key      -> "off"   the reservation flow, exactly as it worked before
 *                          Paystack existed. This is what production runs
 *                          today, and it is the safe default: a missing
 *                          variable degrades to "we will contact you", never
 *                          to a broken checkout.
 *   sk_test_...  -> "test"  checkout is offered ONLY to a request carrying an
 *                          explicit test opt-in. See the note below.
 *   sk_live_...  -> "live"  checkout for everyone.
 *
 * ---------------------------------------------------------------------------
 * WHY TEST MODE IS OPT-IN RATHER THAN AUTOMATIC
 * ---------------------------------------------------------------------------
 *
 * The window this was built for is precisely the dangerous one: the business
 * activation request is pending, so the account holds test keys while the site
 * is publicly reachable. A visitor sent to a test checkout sees a real-looking
 * Paystack page, completes it, and believes they have paid. Nothing arrives,
 * and the first anyone knows is a dispute.
 *
 * So a test key alone is not sufficient to charge anybody. The request must
 * also carry testOptIn, which the page sets only when it was loaded with
 * ?paystack=test. Everyone else gets the reservation flow. The invariant worth
 * keeping: NOBODY reaches a Paystack checkout by accident while the keys are
 * test keys.
 */

/* The price table is authoritative HERE and nowhere else.
 *
 * It used to live in assets/js/shell.js, which meant the browser decided what
 * it owed. With a hosted payment page that was survivable, because the page
 * carried its own fixed price. Initializing a transaction server-side does not
 * survive it: whatever amount is posted is the amount charged, so a devtools
 * console would be a discount code.
 *
 * The figures on the BCAB page are display copy of these. Change both, and
 * change docs/project-brief.md section 6 with them. */
export const OPTIONS = {
  cohort_only: {
    total: 750,
    firstInstalment: 400,
    label: "Intermediate cohort"
  },
  cohort_and_assessment: {
    total: 1050,
    firstInstalment: 400,
    label: "Intermediate cohort + BCAB assessment"
  },
  path_b_readiness: {
    // Paid in one go regardless: an instalment plan on GHS 150 is not a plan.
    total: 150,
    firstInstalment: 150,
    label: "Path B readiness review"
  }
};

/* The CHECK vocabularies on the live table, mirrored so a bad value is refused
   here rather than surfacing as a 23514 while a real person is trying to
   enroll. Verified against the database on 10 August 2026 and recorded in
   supabase-enrollments.sql. */
export const EXPERIENCE_LEVELS = ["foundations_graduate", "experienced_builder", "beginner"];

export const COHORT = "intermediate_2026_09";

/* Which policy wording was on screen when they ticked the boxes. Bump this in
   the same change that publishes a new policy. Kept identical to the value in
   assets/js/shell.js. */
export const POLICY_VERSION = "2026-08-10";

export function paystackMode(env) {
  const key = (env && env.PAYSTACK_SECRET_KEY) || "";
  if (key.indexOf("sk_live_") === 0) return "live";
  if (key.indexOf("sk_test_") === 0) return "test";
  return "off";
}

/* Crockford base32 — no I, L, O or U, so a reference read down a phone line or
   copied off a screenshot cannot be misheard. Same alphabet as the credential
   IDs, for one habit rather than two. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/* Paystack permits alphanumerics and -, . and = in a reference, and requires it
   to be unique across the account.
 *
 * The mode is encoded in the prefix on purpose. It is what lets the webhook
 * refuse to apply a test payment to a real enrollment: a charge whose domain is
 * "test" can only ever match a BPA-TEST- reference, and one whose domain is
 * "live" can only ever match a BPA-CAB- reference. That invariant is enforced in
 * supabase/functions/paystack-webhook/index.ts and is the reason the payment
 * path can be exercised end to end today without any risk of crediting a real
 * seat with money that never moved. */
export function mintReference(mode) {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let tail = "";
  // 256 is exactly 8 x 32, so the modulo is uniform and costs no bias.
  for (let i = 0; i < bytes.length; i++) tail += ALPHABET[bytes[i] % 32];
  const prefix = mode === "live" ? "BPA-CAB-" : "BPA-TEST-";
  return prefix + new Date().getUTCFullYear() + "-" + tail;
}

export function referenceMode(reference) {
  if (typeof reference !== "string") return null;
  if (reference.indexOf("BPA-CAB-") === 0) return "live";
  if (reference.indexOf("BPA-TEST-") === 0) return "test";
  // A reference we did not mint — a hosted payment page, or the dashboard.
  return null;
}

/* What this person owes right now: the whole thing, or the first instalment.
   The remainder is arranged over Slack and paid by MoMo, per the brief — there
   is no automated instalment billing, so nothing here schedules anything. */
export function amountDue(option, instalments) {
  const price = OPTIONS[option];
  if (!price) return null;
  return instalments ? price.firstInstalment : price.total;
}

/* Initialize a transaction and hand back the URL to send the browser to.
 *
 * Paystack works in MINOR units. GHS 750.00 is 75000 pesewas, and getting this
 * wrong in the safe direction is a hundredfold undercharge. The webhook divides
 * by 100 on the way back, so the two conversions sit within sight of each
 * other's comments. */
export async function initializeTransaction(env, options) {
  const secret = env.PAYSTACK_SECRET_KEY;
  if (!secret) return { ok: false, reason: "paystack-not-configured" };

  /* The API host is overridable ONLY under a test key.
   *
   * This exists so the checkout path can be driven against a local stand-in
   * rather than shipped on the strength of having read it, which is how the
   * two /verify bugs that reached a real person got through. The guard is the
   * important half: a live key ignores the override completely and always
   * talks to api.paystack.co, so no configuration mistake and no compromised
   * variable can point real payments at another host. Under a test key there
   * is no money to misdirect. */
  const base =
    paystackMode(env) === "test" && typeof env.PAYSTACK_API_BASE === "string" && env.PAYSTACK_API_BASE
      ? env.PAYSTACK_API_BASE.replace(/\/+$/, "")
      : "https://api.paystack.co";

  const body = {
    email: options.email,
    amount: Math.round(options.amountGhs * 100),
    currency: "GHS",
    reference: options.reference,
    // Where Paystack returns the browser afterwards. /thank-you displays the
    // reference from this URL and writes nothing, because a query string is
    // typed by whoever holds the browser.
    callback_url: options.callbackUrl,
    // MoMo first. The brief makes mobile money a hard requirement rather than a
    // fallback, and naming the channels also stops the checkout offering ones
    // this account cannot settle. Note that the definitive control over what
    // appears is the Paystack dashboard's channel settings; this narrows that
    // set, it does not widen it.
    channels: ["mobile_money", "card"],
    metadata: {
      enrollment_id: options.enrollmentId,
      chosen_option: options.option,
      cohort: COHORT,
      payment_plan: options.instalments ? "instalments" : "full",
      // Shown against the transaction in the Paystack dashboard, which is where
      // reconciliation actually happens when somebody calls about a payment.
      // Worth the four lines.
      custom_fields: [
        { display_name: "Full name", variable_name: "full_name", value: options.fullName },
        { display_name: "WhatsApp", variable_name: "whatsapp", value: options.whatsapp },
        { display_name: "Enrolling in", variable_name: "enrolling_in", value: (OPTIONS[options.option] || {}).label || options.option },
        { display_name: "Cohort", variable_name: "cohort", value: COHORT }
      ]
    }
  };

  let res;
  try {
    res = await fetch(base + "/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + secret,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return { ok: false, reason: "paystack-unreachable" };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, reason: "paystack-bad-json-" + res.status };
  }

  if (!res.ok || !data || data.status !== true || !data.data || !data.data.authorization_url) {
    return {
      ok: false,
      reason: "paystack-" + res.status + ": " + String((data && data.message) || "").slice(0, 200)
    };
  }

  return { ok: true, url: data.data.authorization_url, reference: data.data.reference };
}
