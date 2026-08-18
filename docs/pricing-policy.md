# Pricing policy — regional access pricing

**Status:** decided in outline, **not yet live.** Tier values are still placeholders and
`PRICING_REGIONS` is unset, so every visitor currently sees and is charged Ghana pricing.

Owner: Johnathan Lightfoot · Drafted 15 August 2026.

This document is the authority for *why* the tiers exist and *which country sits in which*. The
authority for the amounts themselves is `functions/api/_regions.js`, which is the only place a price
is decided.

---

## 1. The framing

**Regional access pricing.** Not "foreigners pay more."

Ghana pricing is set for Ghana-based learners and reflects local earning conditions. Every other
region is matched to its own local professional market. Nobody is surcharged; one group is
deliberately subsidised, and that subsidy is aimed rather than universal.

Public wording, beside the pricing block:

> Pricing is regional. Ghana rates are set for Ghana-based learners and reflect local earning
> conditions. Visitors outside Ghana are shown the rate for their region.

That is the whole public explanation. The map, the anchors and the rates live here, not on the sales
page.

---

## 2. Why

**Displacement — the primary justification.** The founding cohort caps at **25 seats** and closes
**8 September 2026**. A seat is a scarce allocation, not an infinitely reproducible digital good.
Someone in a high-income market paying GHS 750 does not merely receive a discount; they consume a
subsidised seat allocated to a Ghanaian learner. This argument is what makes the policy defensible
rather than merely commercial.

**Positioning — secondary.** A full professional training-and-assessment path priced at what reads as
a dinner-and-taxi amount in the US or EU is read as low-end rather than accessible, regardless of the
rigour of the standard behind it.

---

## 3. The rule

Four rules, one external source.

| Tier | Name | Rule |
|---|---|---|
| 1 | Ghana access | `GH` |
| 2 | Regional Africa | In Africa, and **not** World Bank high-income |
| 3 | Global emerging market | Not in Africa, and **not** World Bank high-income |
| 4 | International professional | **World Bank high-income**, anywhere |

**Source:** World Bank country and lending groups, **fiscal year 2027** classification, based on 2025
GNI per capita by the Atlas method. High income is **GNI per capita above USD 14,375**; 87 economies
qualify. Reissued each July, which is this map's review trigger.

**Ghana is a named carve-out, not an income judgment.** Ghana is itself lower-middle-income and would
otherwise fall in tier 2. Tier 1 exists because this programme was built for and with a Ghanaian
community — a commitment, not an economic classification. Saying so plainly is more honest than
inventing an economic rationale for it.

**Unmapped countries fall to tier 4.** An unmapped country paying the Ghana rate is silent arbitrage;
one paying the international rate is visible and correctable with the country selector. The map
therefore enumerates tiers 2 and 3 exhaustively and lets tier 4 be the fall-through.

---

## 4. The map

Generated from the FY2027 classification above. **ISO 3166-1 alpha-2 codes**, matching what
Cloudflare supplies in `request.cf.country`.

### Tier 1 — Ghana access

```
GH
```

### Tier 2 — Regional Africa

Every African economy except Ghana (tier 1) and Seychelles, which is the **only** African economy in
the FY2027 high-income list and therefore falls to tier 4.

```
DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET
GA GM GN GW KE LS LR LY MG MW ML MR MU MA MZ NA NE NG RW ST
SN SL SO ZA SS SD TZ TG TN UG ZM ZW
```

52 economies.

### Tier 3 — Global emerging market

Non-African economies below the high-income threshold.

```
Asia:      AF AM AZ BD BT KH CN GE IN ID IR IQ JO KZ KG LA LB MY MV MN
           MM NP KP PK PS PH LK SY TJ TH TL TR TM UZ VN YE
Europe:    AL BY BA XK MD ME MK RS UA
Americas:  AR BZ BO BR CO CU DM DO EC SV GD GT HT HN JM MX NI PY PE LC
           VC SR VE
Oceania:   FJ KI MH FM PG WS SB TO TV VU
```

78 economies.

### Tier 4 — International professional

Everything else, as the fall-through. Includes all 87 FY2027 high-income economies.

**Results that will surprise people, and are correct under the rule:** Russia, Bulgaria, Croatia,
Romania, Chile, Costa Rica, Panama, Uruguay, Guyana, Trinidad and Tobago, and Seychelles are all
high-income and therefore tier 4. Türkiye, China, Malaysia, Brazil, Mexico and South Africa are not,
and sit in tiers 2–3.

---

## 5. Verification before this goes live

The lists above were assembled from two sources of differing strength, and the difference matters:

- **The income classification is fetched from the World Bank** and is the part the rule actually
  turns on.
- **African membership and the ISO alpha-2 codes are standard reference data applied by hand.**

Before `PRICING_REGIONS` is switched on, reconcile the tier 2 and tier 3 lists against the World
Bank's published classification file directly, country by country. A country wrongly placed in tier 4
is a visible overcharge a visitor can correct; one wrongly placed in tier 2 is silent and permanent.

Territories deliberately left unmapped, and therefore tier 4: Réunion, Mayotte, Western Sahara,
Saint Helena. The French overseas departments use the euro and sit inside the EU, so tier 4 is the
right answer for them anyway.

---

## 6. Which country counts

**Where you live or work** — not passport, not nationality, not citizenship. Use that phrasing in
public copy; "country of residence" is legalistic and invites a legalistic argument back.

### The country selector

Detection is by Cloudflare, and detection is not proof. People travel, use VPNs, and live in one
country while earning from another. A selector sits beside the pricing block so anyone can correct
the assumption.

| Correction | Behaviour |
|---|---|
| Same tier, or **raises** it | Proceeds to checkout normally |
| **Lowers** the tier | Place reserved, **no payment taken**, held for review |

A lowered correction is never charged and never silently accepted. The visitor is told:
*"We need to confirm your regional rate before payment — we will be in touch within 24 hours."*
Every seat already passes a human confirmation on WhatsApp within 24 hours, so this adds a check to a
step that exists rather than inventing a process.

**No threat wording is published.** Not "enrollments may be cancelled or repriced." Challenging
someone after they have paid is a worse operational moment than one sentence before they pay, and the
hold makes the threat unnecessary. Deliberate sponsorship and hardship pricing remain available and
are Johnathan's decision alone — the point of holding rather than blocking is to keep that possible.

**Unresolvable detection** — Cloudflare returns `XX` for unknown or `T1` for Tor — shows the selector
with no price and a calm prompt: *"Select your country to see the correct regional rate."* Never an
error state, never an apology for the site's own machinery.

---

## 7. The one exception to location — Foundations cohort 1

A **Foundations cohort 1** graduate keeps the Ghana rate wherever they now live.
**This applies to Foundations cohort 1 (11 July – 29 August 2026) and to no subsequent cohort.**

Cohort 1 were the people who took the programme when there was no credential, no standard published
to them in advance, and no evidence it would lead anywhere. The access rate was built for exactly
them. The limit is recorded here with the exception itself so that a founding commitment cannot
become a permanent parallel pricing scheme by inertia.

**How it is checked.** A checkbox on the enrollment form, recorded on the row. A claim from outside
Ghana is a downward tier move and takes the path in §6: reserved, no payment taken, verified by hand.

**Verification is against the cohort roll, not against issued credentials.** Cohort 1 finishes
29 August, the showcase is 5 September and BCAB enrollment closes 8 September, so graduates will be
claiming this in the same week their certificates are issued.

---

## 8. Currency

Three currencies are in play and their roles must not blur.

| Role | Currency | Notes |
|---|---|---|
| **Anchor** | USD | Internal only, never displayed. What tiers 2–4 are actually priced in |
| **Charge** | GHS | What Paystack is asked for. The only exact figure |
| **Display** | Local | Derived from the USD anchor in one hop — deriving from GHS would compound rounding |

**Ghana is untouched:** GHS natively, no conversion, no second figure, no disclaimer.

**Why the anchor is USD.** Tiers 2–4 are priced against foreign purchasing power. Held as fixed GHS
constants, any cedi movement would silently reprice the programme in USD terms without anyone
touching the site.

**Rate: 11.65 GHS/USD.** Reviewed **15 August 2026**. **The GHS figures are constants recomputed at
review, not per request** — a price that moves between page load and checkout is worse than a
slightly stale one, and a live FX call would put an external dependency in the pricing path.

**Display currencies at launch: USD, EUR, GBP.** Everything else, including all of tiers 2 and 3,
falls back to USD. Adding NGN, KES or ZAR later is a table entry, not a code change.

**Only one rate affects money.** The GHS/USD rate decides what is charged, so it is the one that has
to be right. The EUR and GBP rates — 0.865 and 0.740, same review date — are **display only**: they
change what a figure reads as, never what leaves an account. That is why the disclosure line says
"approximately" and names GHS as the charge. A stale display rate is a cosmetic error; a stale
GHS/USD rate is a mispriced sale.

**The charge disclosure is one line, and it is load-bearing:**

> €520 · charged in Ghana cedis as GHS 6,058. Your bank converts at its own rate.

Paystack settles GHS and adds a 1.95% international fee, and the card issuer applies its own spread,
so a statement will not match the displayed local figure exactly. Someone shown €520 as though it
were the charge who then sees €537 has a complaint. Naming GHS as the charge in the same breath is
what makes showing a local figure safe at all.

---

## 9. Rates — approved 15 August 2026

Six base values per tier. Tier 1 is native GHS; tiers 2–4 are anchored in USD. `_regions.js`
**derives** the bundle total (`cohort + assessment − bundleDiscount`) and the Path B balance
(`assessment − readiness`), so a tier cannot publish arithmetic that fails to add up on screen.

| Base value | Ghana (GHS) | Regional Africa | Emerging | International |
|---|---|---|---|---|
| Cohort only | 750 | $130 | $300 | $750 |
| Assessment fee | 450 | $75 | $180 | $350 |
| Bundle discount | 150 | $25 | $60 | $100 |
| **Bundle total** *(derived)* | **1,050** | **$180** | **$420** | **$1,000** |
| Path B readiness | 150 | $25 | $60 | $130 |
| **Path B balance** *(derived)* | **300** | **$50** | **$120** | **$220** |
| Retake — first | 300 | $50 | $120 | $250 |
| Retake — subsequent | 400 | $70 | $160 | $350 |

**Rounding is in USD, not GHS**, because USD is both the anchor and what a tier 4 visitor reads. A
tier 4 buyer sees **$1,000**; the GHS figure it converts to (11,650) appears only in the charge
disclosure line. Round numbers belong in the currency people actually read.

### Standard rates — what future cohorts pay

Approved 15 August 2026. These carry the whole meaning of "Founding Cohort Rate": without a published
standard beside it, the founding price simply becomes the permanent baseline, which is the outcome
`docs/project-brief.md` explicitly set out to avoid.

| Standard rate | Ghana (GHS) | Regional Africa | Emerging | International |
|---|---|---|---|---|
| Cohort only | 1,000–1,200 | $180 | $420 | $1,050 |
| Bundle | 1,500–1,750 | $250 | $580 | $1,400 |
| Path B readiness | 200 | $35 | $85 | $185 |

Ghana publishes ranges and the other tiers single figures; both shapes are supported rather than
forcing one into the other, because Ghana's ranges were published before this policy existed.

**Every founding rate sits 25–30% below its standard rate**, verified rather than asserted — the
check runs across all four tiers and fails if any founding price ever reaches or exceeds its own
standard. That consistency is what makes the discount legible as one policy rather than four
unrelated decisions.

**Set the line items first and let the bundle fall out.** Deciding a bundle total and back-solving its
components forces awkward component prices, and the page line-items them on screen where each has to
look defensible standing alone.

**Founding rates outside Ghana** are a discount off that tier's standard rate, using the same founding
discount Ghana already publishes — 750 against 1,000–1,200 and 1,050 against 1,500–1,750, roughly
25–40% off.

**Tier 4 sits at the deeper end of that band for cohort one, and the reason is published.** Cohort one
has no published outcomes, no second assessor, and two credential holders who are both the founder;
the thresholds are explicitly provisional. Pricing below the standard rate *because* the proof does
not exist yet is the same move `/standard` makes about provisional thresholds and `/verify` makes
about having nothing to verify. The rate rises to standard for cohort two.

**Instalments are Ghana only.** Instalments after the first are arranged through Slack and paid by
MoMo and there is no automated instalment billing, so a learner outside Ghana cannot complete the
plan. Tiers 2–4 are full payment; `/api/enroll` refuses an instalment request on a non-Ghana tier
rather than taking a first payment that can never be finished.

---

## 10. Open, and outside what the site can settle

- **EU/UK VAT and consumer withdrawal rights on digital services sold to consumers.** Selling into
  the EU, UK and US is international commerce, not a site setting, and it compounds the existing
  US-company/Ghanaian-processor question in `docs/build-status.md`. **Needs an accountant or an
  attorney familiar with cross-border trade before `PRICING_REGIONS` is switched on.**
- **Payability is not the same as pricing.** The map assigns a price to every country; it does not
  claim a payment can be taken from every country. Card networks and Paystack will not process for
  several economies in tiers 3 and 4 — Iran, North Korea, Syria, Cuba and Russia among them. The map
  should not be read as an offer to transact where transacting is not permitted.
- **Session time for tier 4.** Saturdays 11:30–14:00 GMT is 07:30 Eastern and 04:30 Pacific. State it
  on the page rather than letting someone discover it after paying.
- **Demand is unmeasured.** There is no country field on the enrollment form today and `city` is free
  text, so there is no evidence about international traffic either way. The tiers are built inert and
  switched on with one variable precisely so this can be wrong cheaply.

---

## 11. Review cadence

| Item | Trigger |
|---|---|
| Country map | World Bank reclassification, published each **July** |
| FX rate and GHS constants | `[REVIEW CADENCE]` — set one; quarterly is the obvious default |
| Founding vs standard rates | End of the founding cohort |
| Cohort 1 alumni exception | **Expires with cohort 1.** Does not carry to cohort 2 |
