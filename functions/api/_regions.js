/* Regional pricing: the country map, the per-tier price table, and tier resolution.
 *
 * Not routed — files under functions/ beginning with an underscore never become
 * endpoints.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROLLING PRINCIPLE
 * ---------------------------------------------------------------------------
 *
 * Region is decided ONCE, here, server-side, and the same decision drives both
 * what is displayed and what is charged.
 *
 * This is the direct descendant of the reasoning in _paystack.js: the price
 * table moved off assets/js/shell.js because whatever amount reaches Paystack
 * is the amount charged, and a price the browser supplies is a price the
 * browser can edit. A REGION the browser supplies is a discount code by
 * another name, so resolveTier() reads Cloudflare's own header and never a
 * field from the request body.
 *
 * The visitor can still correct a wrong detection — people travel, use VPNs,
 * and live in one country while earning in another — but a correction that
 * LOWERS the price does not reach checkout. See the `lowered` flag below and
 * the branch in enroll.js.
 *
 * ---------------------------------------------------------------------------
 * PRICING_REGIONS IS THE KILL SWITCH
 * ---------------------------------------------------------------------------
 *
 *   unset  -> every visitor is tier 1 (Ghana), displayed and charged, exactly
 *             as production ran before this file existed. This is the safe
 *             default and what ships until the switch is deliberately thrown.
 *   set    -> tiers active.
 *
 * Same shape as PAYSTACK_SECRET_KEY, and for the same reasons: merging changes
 * nothing a visitor sees, each piece can be verified against a deployed but
 * inert system, and rollback is deleting one variable and redeploying. No
 * revert, no database change, no Paystack change.
 *
 * Policy, reasoning and the generated country map: docs/pricing-policy.md
 */

/* ---------------------------------------------------------------------------
 * RATES
 * ---------------------------------------------------------------------------
 *
 * ONLY ONE OF THESE AFFECTS MONEY.
 *
 * RATE_GHS_PER_USD decides what is charged, because tiers 2-4 are anchored in
 * USD and Paystack settles in GHS. It has to be right.
 *
 * DISPLAY_RATES only change what a figure READS AS. The charge is always the
 * GHS amount, the page says so on the same line, and the visitor's bank does
 * its own conversion at its own rate — so a stale EUR rate is a cosmetic error
 * while a stale GHS/USD rate is a mispriced sale. Do not let the two drift
 * into looking equally important.
 *
 * Recomputed at review, never per request. A live FX call would put an
 * external dependency and a new failure mode directly in the pricing path,
 * and a price that moves between page load and checkout is worse than one
 * that is slightly stale. */
export const RATE_GHS_PER_USD = 11.65;

export const DISPLAY_RATES = {
  USD: 1,
  EUR: 0.865,
  GBP: 0.74
};

export const RATES_REVIEWED_ON = "2026-08-15";

/* ---------------------------------------------------------------------------
 * THE TIERS
 * ---------------------------------------------------------------------------
 *
 * Six base values per tier. Everything else on every page is DERIVED from
 * these — see figures() below.
 *
 * Deriving rather than enumerating is not tidiness. The BCAB page line-items
 * the bundle arithmetic on screen (750 + 450 - 150 = 1,050), so a tier whose
 * total was supplied independently of its components can publish arithmetic
 * that does not add up. Deriving makes that impossible rather than making it
 * a review task somebody has to remember.
 *
 * Ghana is anchored in GHS natively, because a local price should track the
 * local currency. Tiers 2-4 are anchored in USD, because they are priced
 * against foreign purchasing power — held as fixed GHS constants, any cedi
 * movement would silently reprice the programme in USD terms with nobody
 * touching the site.
 *
 * Rounding is done in the ANCHOR currency, which is also the display currency,
 * because that is the number a human reads. A tier 4 buyer sees $1,000; the
 * GHS it converts to (11,650) appears only in the charge disclosure. */
export const TIERS = {
  ghana: {
    name: "Ghana",
    anchor: "GHS",
    base: {
      cohort: 750,
      assessment: 450,
      bundleDiscount: 150,
      readiness: 150,
      retakeFirst: 300,
      retakeSubsequent: 400
    },
    /* What future cohorts pay. This is what makes "Founding Cohort Rate" mean
       something rather than being a label, and the brief is explicit about why
       it is published: it stops the founding price becoming the permanent
       baseline. A range is allowed here and a single figure elsewhere, because
       Ghana's was published as a range before this file existed. */
    standard: { cohort: [1000, 1200], bundle: [1500, 1750], readiness: 200 },
    /* Instalments are Ghana only, and this is a delivery fact rather than a
       pricing decision: instalments after the first are arranged through the
       Slack community and paid by MoMo, and there is no automated instalment
       billing. Someone in Germany cannot complete the plan, so offering it to
       them would take a first payment against a balance they have no way to
       settle. enroll.js refuses payment_plan on any other tier. */
    instalments: { cohort_only: 400, cohort_and_assessment: 400 },
    /* MoMo first, per the brief's hard requirement. Narrowing this list cannot
       enable a channel the Paystack account does not hold — the dashboard is
       the definitive control; this only restricts what is offered. */
    channels: ["mobile_money", "card"]
  },

  africa: {
    name: "Regional Africa",
    anchor: "USD",
    base: {
      cohort: 130,
      assessment: 75,
      bundleDiscount: 25,
      readiness: 25,
      retakeFirst: 50,
      retakeSubsequent: 70
    },
    standard: { cohort: 180, bundle: 250, readiness: 35 },
    instalments: null,
    channels: ["card"]
  },

  emerging: {
    name: "Global emerging market",
    anchor: "USD",
    base: {
      cohort: 300,
      assessment: 180,
      bundleDiscount: 60,
      readiness: 60,
      retakeFirst: 120,
      retakeSubsequent: 160
    },
    standard: { cohort: 420, bundle: 580, readiness: 85 },
    instalments: null,
    channels: ["card"]
  },

  international: {
    name: "International professional",
    anchor: "USD",
    base: {
      cohort: 750,
      assessment: 350,
      bundleDiscount: 100,
      readiness: 130,
      retakeFirst: 250,
      retakeSubsequent: 350
    },
    standard: { cohort: 1050, bundle: 1400, readiness: 185 },
    instalments: null,
    channels: ["card"]
  }
};

/* Cheapest first. Used for one thing only: deciding whether a visitor's
   declared country LOWERS their tier, which is the case that must not reach
   checkout. */
export const TIER_ORDER = ["ghana", "africa", "emerging", "international"];

export const DEFAULT_TIER = "international";

/* ---------------------------------------------------------------------------
 * THE COUNTRY MAP
 * ---------------------------------------------------------------------------
 *
 * Generated from the World Bank country and lending groups, FY2027
 * classification (2025 GNI per capita, Atlas method; high income is above
 * USD 14,375). Four rules:
 *
 *   tier 1  GH
 *   tier 2  in Africa, and NOT high income
 *   tier 3  not in Africa, and NOT high income
 *   tier 4  high income, anywhere  -- and everything unmapped
 *
 * TIERS 2 AND 3 ARE ENUMERATED EXHAUSTIVELY AND TIER 4 IS THE FALL-THROUGH.
 * That is deliberate and it is the safe direction: a country missing from this
 * map is quoted the highest price, which is visible and which the country
 * selector can correct. The opposite default would make every gap in the map a
 * silent discount.
 *
 * Reissued each July, which is this map's review trigger.
 * Full list and reasoning: docs/pricing-policy.md */

/* Every African economy except Ghana (tier 1) and Seychelles, which is the
   only African economy in the FY2027 high-income list. */
const AFRICA_NOT_HIGH_INCOME =
  "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET " +
  "GA GM GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST " +
  "SN SL SO ZA SS SD TZ TG TN UG ZM ZW";

/* Non-African economies below the high-income threshold. */
const EMERGING_NOT_HIGH_INCOME =
  // Asia
  "AF AM AZ BD BT KH CN GE IN ID IR IQ JO KZ KG LA LB MY MV MN " +
  "MM NP KP PK PS PH LK SY TJ TH TL TR TM UZ VN YE " +
  // Europe
  "AL BY BA XK MD ME MK RS UA " +
  // Americas
  "AR BZ BO BR CO CU DM DO EC SV GD GT HT HN JM MX NI PY PE LC " +
  "VC SR VE " +
  // Oceania
  "FJ KI MH FM PG WS SB TO TV VU";

export const COUNTRY_TIER = (() => {
  const map = { GH: "ghana" };
  for (const code of AFRICA_NOT_HIGH_INCOME.split(/\s+/)) map[code] = "africa";
  for (const code of EMERGING_NOT_HIGH_INCOME.split(/\s+/)) map[code] = "emerging";
  return map;
})();

/* ---------------------------------------------------------------------------
 * DISPLAY CURRENCY
 * ---------------------------------------------------------------------------
 *
 * Three at launch, with USD as the fallback for everything else INCLUDING all
 * of tiers 2 and 3. Adding NGN, KES or ZAR later is an entry in this table,
 * not a code change.
 *
 * Montenegro and Kosovo use the euro but sit in tier 3, so they are absent
 * here and fall back to USD, matching the launch decision. Bulgaria is
 * deliberately absent pending confirmation of its euro adoption date — a
 * figure labelled in the wrong currency is worse than one labelled USD. */
const EUR_COUNTRIES =
  "AT BE HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES AD MC SM VA";

const GBP_COUNTRIES = "GB IM JE GG";

export const DISPLAY_CURRENCY = (() => {
  const map = {};
  for (const code of EUR_COUNTRIES.split(/\s+/)) map[code] = "EUR";
  for (const code of GBP_COUNTRIES.split(/\s+/)) map[code] = "GBP";
  return map;
})();

/* ---------------------------------------------------------------------------
 * DERIVATION
 * --------------------------------------------------------------------------- */

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* Anchor currency -> GHS, which is the only currency Paystack is ever asked
   for. Identity for Ghana, whose anchor already is GHS. */
export function toGhs(tierName, amount) {
  const tier = TIERS[tierName];
  if (!tier) return null;
  return tier.anchor === "GHS" ? round2(amount) : round2(amount * RATE_GHS_PER_USD);
}

/* Every figure the site publishes for a tier, in that tier's ANCHOR currency.
 *
 * Ten figures, of which four are derived. The two derivations are the ones the
 * pages show working on screen:
 *   bundle       = cohort + assessment - bundleDiscount
 *   pathBBalance = assessment - readiness   (the readiness fee is credited)
 */
export function figures(tierName) {
  const tier = TIERS[tierName];
  if (!tier) return null;
  const b = tier.base;

  return {
    currency: tier.anchor,
    cohort: b.cohort,
    assessment: b.assessment,
    bundleDiscount: b.bundleDiscount,
    bundle: b.cohort + b.assessment - b.bundleDiscount,
    readiness: b.readiness,
    pathBBalance: b.assessment - b.readiness,
    retakeFirst: b.retakeFirst,
    retakeSubsequent: b.retakeSubsequent
  };
}

/* The charge table, in GHS, keyed exactly as OPTIONS in _paystack.js.
 *
 * Same shape the rest of the payment path already expects, so a tier is a
 * different set of numbers rather than a different code path. Labels stay in
 * _paystack.js because they do not vary by region. */
export function chargeOptions(tierName) {
  const tier = TIERS[tierName];
  const f = figures(tierName);
  if (!tier || !f) return null;

  const inst = tier.instalments;

  return {
    cohort_only: {
      total: toGhs(tierName, f.cohort),
      firstInstalment: inst ? toGhs(tierName, inst.cohort_only) : null
    },
    cohort_and_assessment: {
      total: toGhs(tierName, f.bundle),
      firstInstalment: inst ? toGhs(tierName, inst.cohort_and_assessment) : null
    },
    path_b_readiness: {
      // Paid in one go on every tier: an instalment plan on a readiness review
      // is not a plan.
      total: toGhs(tierName, f.readiness),
      firstInstalment: toGhs(tierName, f.readiness)
    }
  };
}

/* ---------------------------------------------------------------------------
 * DISPLAY
 * ---------------------------------------------------------------------------
 *
 * What the middleware substitutes into the pages. Separate from chargeOptions()
 * on purpose: one of these decides what leaves somebody's account and the other
 * decides what a figure reads as, and collapsing them into one function is how
 * a display rounding eventually becomes a charge. */

const CURRENCY_PREFIX = { GHS: "GHS ", USD: "$", EUR: "€", GBP: "£" };

/* Whole units. Every published figure is a whole number in its display
   currency by construction — the tier tables hold round numbers and the
   derivations are addition — so there are no minor units to show. */
export function formatMoney(amount, currency) {
  const n = Math.round(amount);
  const grouped = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (CURRENCY_PREFIX[currency] || currency + " ") + grouped;
}

/* Every published figure for this tier, already formatted, plus the GHS charge
 * line for the tiers that need one.
 *
 * The keys match the data-price attributes in the markup, so the middleware is
 * a lookup rather than a set of special cases. */
export function displayFigures(tierName, country) {
  const f = figures(tierName);
  if (!f) return null;

  const display = displayCurrencyFor(country, tierName);

  /* Anchor -> display currency. Derived from the ANCHOR in one hop rather than
     via GHS: two conversions compound their rounding, and the anchor is the
     number the price was actually set in. */
  const rate = tierName === "ghana" ? 1 : (DISPLAY_RATES[display] || 1);

  /* ROUND FIRST, THEN DERIVE. This order is load-bearing.
   *
   * figures() derives the bundle and the Path B balance in the ANCHOR currency,
   * where the arithmetic is exact. Converting each of those results into a
   * display currency and rounding them independently reintroduces exactly the
   * problem deriving was meant to remove: the BCAB page shows
   * cohort + assessment - discount = total on screen, and independent rounding
   * makes that sum visibly wrong.
   *
   * Measured, not theorised: at the EUR rate, africa displayed
   * 130 + 65 - 22 = 156 where the parts sum to 155, and emerging was off by one
   * in the other direction. Three of ten tier/currency combinations were wrong.
   *
   * So the components are rounded into display units first, and the totals are
   * derived FROM THE ROUNDED COMPONENTS. The displayed sum is then correct by
   * construction in any currency, at any rate.
   *
   * This changes only what is displayed. The CHARGE is unaffected: it comes
   * from chargeOptions(), which converts the anchor figure straight to GHS and
   * never passes through a display currency. A displayed figure is explicitly
   * approximate — the page says the charge is in cedis and that the visitor's
   * bank converts at its own rate — so internal consistency on screen is worth
   * more than matching a conversion nobody can check. */
  const unit = (amount) => Math.round(amount * rate);

  const cohortU = unit(f.cohort);
  const assessmentU = unit(f.assessment);
  const discountU = unit(f.bundleDiscount);
  const readinessU = unit(f.readiness);
  const bundleU = cohortU + assessmentU - discountU;
  const balanceU = assessmentU - readinessU;

  const show = (amount) => formatMoney(amount * rate, display);
  const showUnit = (whole) => formatMoney(whole, display);

  /* Standard rates are what future cohorts pay, and they carry the whole
     meaning of "Founding Cohort Rate". Ghana publishes ranges and the other
     tiers single figures, so both shapes are accepted rather than forcing one
     into the other — an en dash, not a hyphen, because it is a numeric range. */
  const std = TIERS[tierName].standard || {};
  const showStandard = (value) =>
    Array.isArray(value)
      ? show(value[0]) + "–" + formatMoney(value[1] * rate, display).replace(CURRENCY_PREFIX[display] || "", "")
      : show(value);

  const out = {
    "cohort.total": showUnit(cohortU),
    "assessment.fee": showUnit(assessmentU),
    "bundle.discount": showUnit(discountU),
    // Derived from the rounded components above, never converted separately.
    "bundle.total": showUnit(bundleU),
    "readiness.total": showUnit(readinessU),
    "readiness.balance": showUnit(balanceU),
    "retake.first": show(f.retakeFirst),
    "retake.subsequent": show(f.retakeSubsequent),
    "standard.cohort": showStandard(std.cohort),
    "standard.bundle": showStandard(std.bundle),
    "standard.readiness": showStandard(std.readiness)
  };

  /* THE CHARGE DISCLOSURE.
   *
   * Only for tiers that are not charged in the currency they are displayed in.
   * Paystack settles GHS and adds an international fee, and the card issuer
   * applies its own spread, so the statement will not match the displayed
   * figure exactly. Somebody shown a local figure as though it were the charge
   * who then sees a different number on their statement has a complaint —
   * naming GHS in the same breath is what makes showing a local figure safe.
   *
   * Ghana gets no disclosure at all, because for Ghana there is nothing to
   * disclose: the figure shown is the figure charged. */
  if (tierName !== "ghana") {
    out["charge.bundle"] = formatMoney(toGhs(tierName, f.bundle), "GHS");
    out["charge.cohort"] = formatMoney(toGhs(tierName, f.cohort), "GHS");
    out["charge.readiness"] = formatMoney(toGhs(tierName, f.readiness), "GHS");
  }

  return { currency: display, figures: out, needsChargeLine: tierName !== "ghana" };
}

export function instalmentsAllowed(tierName) {
  const tier = TIERS[tierName];
  return !!(tier && tier.instalments);
}

export function channelsFor(tierName) {
  const tier = TIERS[tierName];
  return (tier && tier.channels) || ["card"];
}

/* ---------------------------------------------------------------------------
 * RESOLUTION
 * --------------------------------------------------------------------------- */

export function regionsEnabled(env) {
  return !!(env && env.PRICING_REGIONS);
}

function normaliseCountry(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  /* XX is Cloudflare's "unknown", T1 is Tor. Neither is a country and neither
     may be guessed at: assuming tier 4 overcharges a Ghanaian on an odd
     network, and assuming Ghana hands out the subsidised rate to anyone who
     can reach a Tor exit. Both silent failures are worse than one honest
     question, so these resolve to null and the page asks. */
  if (code === "XX" || code === "T1") return null;
  return code;
}

export function tierForCountry(country) {
  if (!country) return null;
  return COUNTRY_TIER[country] || DEFAULT_TIER;
}

export function displayCurrencyFor(country, tierName) {
  if (tierName === "ghana") return "GHS";
  return (country && DISPLAY_CURRENCY[country]) || "USD";
}

/* Which tier this request is priced at, and everything the caller needs to
 * decide whether it may proceed to payment.
 *
 * Returns:
 *   tier        the tier name to price and charge at
 *   detected    what Cloudflare said, or null if unusable
 *   declared    what the visitor selected, or null
 *   resolved    false when no country could be established at all. The page
 *               must then show the selector WITHOUT a price rather than guess
 *   lowered     true when the declared country is cheaper than the detected
 *               one. enroll.js reserves rather than charging on this
 *
 * env is needed for the kill switch and the dev override, so this takes it
 * rather than reading a global. */
export function resolveTier(request, env, declaredCountry) {
  /* The kill switch short-circuits everything. With PRICING_REGIONS unset this
     function is indistinguishable from the behaviour before it existed. */
  if (!regionsEnabled(env)) {
    return {
      tier: "ghana",
      detected: null,
      declared: null,
      resolved: true,
      lowered: false,
      enabled: false
    };
  }

  /* The override exists so this logic could be driven against something rather
     than shipped on the strength of having been read — request.cf is
     unreliable under `wrangler pages dev`. It is honoured ONLY when the
     Paystack key is not a live key, exactly mirroring the guard on
     PAYSTACK_API_BASE in _paystack.js: under a live key there is real money to
     misprice, so no configuration mistake and no compromised variable can
     move a visitor between tiers. */
  const live = typeof env.PAYSTACK_SECRET_KEY === "string" &&
    env.PAYSTACK_SECRET_KEY.indexOf("sk_live_") === 0;

  const override = !live ? normaliseCountry(env.PRICING_COUNTRY_OVERRIDE) : null;
  const detected = override || normaliseCountry(request && request.cf && request.cf.country);
  const declared = normaliseCountry(declaredCountry);

  const detectedTier = tierForCountry(detected);
  const declaredTier = tierForCountry(declared);

  /* Neither a usable detection nor a declaration: the caller shows the
     selector and no price. */
  if (!detectedTier && !declaredTier) {
    return {
      tier: DEFAULT_TIER,
      detected: null,
      declared: null,
      resolved: false,
      lowered: false,
      enabled: true
    };
  }

  /* A declaration always wins for what is DISPLAYED and CHARGED — otherwise
     the selector would be decorative. What it does not do is buy a cheaper
     price unchallenged: `lowered` is what stops that, one layer up. */
  const tier = declaredTier || detectedTier;

  const lowered = !!(
    declaredTier &&
    detectedTier &&
    TIER_ORDER.indexOf(declaredTier) < TIER_ORDER.indexOf(detectedTier)
  );

  return {
    tier: tier,
    detected: detected,
    declared: declared,
    resolved: true,
    lowered: lowered,
    enabled: true
  };
}
