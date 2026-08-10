# Project Brief — Bulletproof Automations Training Site Rebuild

Prepared as a handoff from planning work completed August 2026. This document carries the
decisions already made so they do not have to be re-litigated. Where something is undecided,
it says so explicitly under "Open decisions".

---

## 1. The business

**Bulletproof Automations** — automation consultancy, Accra, Ghana. Founder: **Johnathan Lightfoot**.
Training arm currently at `training.bulletproofautomations.com`.

The training programme exists for three reasons, in this order:
1. Build a credible certification standard for automation engineering.
2. Create a hiring and builder-pool pipeline for Bulletproof Automations.
3. Generate revenue from paid cohorts.

Bulletproof Automations **uses the BCAB credential as its own minimum hiring standard** for
automation roles. This is a deliberate credibility signal and is published — with the
non-guarantee wording in the framework, Section 7.

---

## 2. Audience

The first cohort was **25 learners, all Ghanaian**. Assume that profile continues:

- Working professionals and aspiring freelancers, not students of computer science.
- Mostly phone-first browsing; some on constrained bandwidth.
- Payment via **mobile money (MoMo)** is normal and expected; card-only will lose conversions.
- **WhatsApp** outperforms email forms for pre-purchase questions.
- Pricing must be denominated in **GHS**. As of August 2026, roughly GHS 11.6 to USD 1.
  Do not price against US cohort-course benchmarks.

---

## 3. The pathway

Renamed from "n8n Automation Builder Training Pathway" to **Bulletproof Automation Builder
Pathway**. The subject is **automation engineering**; n8n is the platform competence is
demonstrated on. This protects the credential if the tooling landscape shifts.

| Stage | Credential | Type | Status |
|---|---|---|---|
| 1 | Bulletproof Automation Foundations Certificate | Certificate of completion | Active — first cohort finishes Aug 2026 |
| 2 | Bulletproof Certified Automation Builder (BCAB) | Professional certification | Launching — **this is what needs to sell now** |
| 3 | Bulletproof Certified Automation Engineer (BCAE) | Professional certification | Defined, not launched. Named on site, not sold. |

**The old five-rung ladder on the live site is obsolete.** It currently shows Beginner (8wk free)
→ Intermediate (4wk paid) → Advanced (2wk) → Use Case (1 session) → Builder Pool Review.
Replace with the three stages above plus the builder pool as a separate outcome, not a rung.

---

## 4. Stage 1 — Foundations (content exists in full)

- 8 weeks, free, Saturdays, live online, hands-on build-along.
- Ran 11 July – 29 August 2026. Next cohort dates undecided.
- Class sequence: Getting Started · Triggers and Data · Connecting Apps · Working with APIs ·
  Logic & Branching · Error Handling · AI-Powered Automation · Capstone.
- Every class produces portfolio proof: exported workflow JSON, screenshots, written notes.
- Awarded on: attendance minimum + weekly portfolio artifacts + capstone with a verbal walkthrough.
  **No exam.** No direct-entry route — you cannot complete training you did not take.
- Full teaching guide exists as a separate document (8 detailed session plans, rubric, appendices).

Marketing role: free top-of-funnel, and the route that **waives the BCAB entry assessment**.
"Complete the free Foundations cohort and skip the assessment" is a strong pathway line.

---

## 5. Stage 2 — BCAB (the priority)

### The training cohort
- **5 weeks**, one competency per week.
- **2.5-hour sessions** (was 90 min in Foundations; deliberately longer because intermediate
  work needs learner-driven build and debug time, not more lecture).
- Include a real mid-session break around the 70-minute mark.
- Cohort cap **25 seats, fixed** (confirmed 9 August 2026). Stated plainly on the page; **no
  seat counter** showing remaining availability.
  - Note: earlier planning proposed 12–15 on the grounds that intermediate debugging is
    individual. 25 is the confirmed decision. The trade-off to manage is Week 4's diagnostic
    lab, where per-learner assessor attention is thinnest.
- Weekly structure shifts from "follow me" to "here is the requirement, you decide" —
  learners no longer all build identical workflows.
- One project runs across all five weeks and grows weekly. **No final-week capstone crunch.**

Week themes:
1. **Complex Data** — nested objects, arrays, multi-item, missing fields, Split/Aggregate/Merge,
   when the Code node earns its place, pinned data as a testing tool.
2. **Real API Integration** — POST/PATCH/DELETE, auth patterns, pagination, rate limits,
   status-code literacy. Learners get an unfamiliar API and its docs, no walkthrough.
3. **Workflow Architecture** — sub-workflows, reusable components, naming, config vs hard-coded,
   state and persistence, deduplication, **idempotency** (taught question-first: "what happens
   if this fires twice?" then named).
4. **Troubleshooting & Reliability** — the centrepiece. Silent, partial, and wrong-but-valid
   failures. Observability, run IDs, dead-letter patterns, recovery workflows. Includes a
   **diagnostic lab: a broken workflow the learner did not build.**
5. **Production AI & Automation Design** — where AI should and should not decide, structured
   output, validation, confidence and fallback, human-in-the-loop, agent vs workflow judgment.

   ## 6. Pricing — confirmed for founding cohort

Start date: 12 September 2026
Sessions: Saturdays, **11:30 AM – 2:00 PM GMT** (confirmed 9 August 2026)
Cohort cap: **25 seats**
Certification assessment window: **begins 1 November 2026**
Enrollment deadline: **Tuesday 8 September 2026** (four days before the cohort starts; set after the
5 September showcase so that event's conversion window is protected, and two days before the
proof-of-setup task is due)

| Offering | Founding price | Standard price |
|---|---|---|
| 5-Week Intermediate Cohort | GHS 750 | GHS 1,000–1,200 |
| BCAB Certification Assessment | GHS 450 | GHS 600–750 |
| Intermediate + first BCAB attempt (bundle) | GHS 1,050 | GHS 1,500–1,750 |
| Path B Readiness Assessment | GHS 150 | GHS 200 |
| BCAB Retake (first) | GHS 300 | — |
| BCAB Retake (subsequent) | GHS 400 | — |

### Checkout display for bundle
Training and certification are line-itemed separately even in the bundle:
  Intermediate Cohort Training — GHS 750
  BCAB Certification Assessment — GHS 450
  Pathway Bundle — (GHS 150)
  Total — GHS 1,050

### Payment provider — confirmed 9 August 2026

**Paystack.** Settles in GHS and supports Ghanaian mobile money natively, so MoMo is delivered
through the processor rather than around it. MoMo is presented ahead of card in the payment UI.

Integration shape for launch: hosted Paystack Payment Pages (recommended — no keys and no card
handling in a static frontend, no server required, repriceable without a deploy). The enrollment
form writes to Supabase first with a generated reference and status `started`, so a record
exists even for people who abandon checkout, then hands off to Paystack.

### Payment plans — confirmed 9 August 2026
- Intermediate only: GHS 400 at enrollment + GHS 350 before Week 3
- Full bundle: GHS 400 + GHS 350 + GHS 300
- **The first instalment is paid through Paystack at enrollment.**
- **Remaining instalments are handled case by case.** Learners contact Johnathan through the
  dedicated Bulletproof Automations Slack instance to arrange and deliver subsequent payments
  via MoMo. **There is no automated instalment billing.**
- Wording to use on the enrollment page and in the pricing section, verbatim:
  *"First payment via Paystack. Remaining instalments arranged through our Slack community
  via MoMo."*
- Payments do not extend beyond the five-week programme
- Full payment required before the certification assessment
- Missed instalment: access pauses until payment is made

### Path B flow
Readiness Review GHS 150 → credited against assessment if they proceed →
candidate pays remaining GHS 300 to sit the assessment.

### Founding cohort label
Use "Founding Cohort Rate" explicitly. Note that future cohorts are priced
at the standard programme rate. This prevents GHS 750 becoming permanently
anchored as the baseline.

### Language rules for pricing
NEVER write "Get BCAB Certified — GHS 1,050". That implies purchase buys
certification. ALWAYS write "Intermediate + BCAB Assessment — GHS 1,050".
They are buying training and an assessment opportunity. The credential is earned.

### Technical stack decisions (already made)
- **Supabase** is the main database — chosen because it also teaches credentialed auth
  (anon vs service_role key), a real REST API with pagination for the Week 2 exercise, and an
  external dependency that can actually fail for Week 4.
  - **Free-tier projects pause after 7 days of inactivity** and classes are exactly 7 days apart.
    Mitigation: mid-week homework each week, plus a scheduled keep-alive workflow built in Week 1.
  - Free tier has zero backup retention.
- **n8n Data Tables** used alongside Supabase for internal workflow state — dedupe markers,
  config tables, run logs, dead-letter rows. The choice between the two is itself a teaching topic.
  - Caveat: the Code node cannot access Data Tables programmatically.
  - CSV import/export makes it ideal for seeding identical diagnostic-lab data with no credentials.
- Webhooks must be reachable from the internet by Week 2 — localhost is not enough.
  Decide between n8n Cloud, a shared VPS, or a tunnel; it becomes an enrollment prerequisite.
- A **setup clinic runs before Week 1**, recorded, with a written guide and a small
  **proof-of-setup task due 48 hours before the cohort starts** (create a Supabase table, insert
  a row, call the REST endpoint, screenshot the JSON).

### The certification (separate from the cohort)
Completing the cohort **qualifies a learner to attempt the assessment**. It does not award
the credential. Four components:

| Part | Component | Weight | Notes |
|---|---|---|---|
| 1 | Knowledge & Scenario Judgment | 20% | Judgment scenarios, not definitions |
| 2 | Practical Build Challenge | 35% | Unseen requirement, no node instructions. **Min 70%** |
| 3 | Troubleshooting Challenge | 30% | Live, supervised, defect count undisclosed. **Min 70%** |
| 4 | Architecture Walkthrough | 15% | Also serves as authorship verification |

Overall provisional threshold **75%**, no domain below **50%**. Parts 2 and 3 minimums are
**non-compensatory** — strong theory cannot offset weak hands-on ability.

Seven competency domains: Data Engineering · Integrations & APIs · Workflow Architecture ·
Logic & State · Reliability · Troubleshooting · AI Automation.

Three outcomes: **Certified** · **Assessment Not Yet Passed** · **Remediation Required**.
The term "failed candidate" is not used.

Critical safety failures trigger remediation regardless of score (exposed credentials,
sensitive data to an AI provider, unsafe production-like data handling, silently discarding
failed records, unvalidated AI driving a critical action).

**Two entry routes.** Path A: Foundations Certificate → cohort → assessment. Path B:
experienced practitioner → readiness assessment → assessment, **without buying the training**.
Path B is essential to the credential's independence and must be visible on the site.

Thresholds are **provisional** and will be calibrated after cohort one. This is stated publicly —
standard-setting after piloting is normal practice and reads as rigour, not weakness.

---

## 7. What the site must do

### Problems with the current site
- Sells an obsolete five-rung ladder that no longer matches the product.
- Certification is entirely absent — it reads as one more n8n course.
- "Certificate of Completion" language applied to everything, blurring Stage 1 and Stage 2.
- Naming implies n8n affiliation.
- Three "Coming Soon" cards on the homepage that signal an unfinished site.
- Waitlists and interest lists instead of actual enrollment.
- **No instructor bio, no photo, no proof, no testimonials, no student work anywhere.**
- Pathway buried below a workshop on the homepage.

### What actually creates the premium/credible feel
Evidence, not styling. In priority order:
1. **The published standard** as a downloadable PDF on its own page — nobody else in this
   market publishes an assessment standard with domains, weights, and thresholds.
2. **The instructor** — bio, photo, background, why he is qualified to set this standard.
3. **Proof from cohort one** — capstone screenshots, portfolio links, named testimonials with faces.
4. **Specificity** — exact dates, times, cap, price, deadline. Vagueness reads as amateur.
5. **A credential verification page** — even a simple lookup by credential ID.

### Proposed site map
- `/` — Home. Pathway-centred umbrella. Hero for Bulletproof Automations Training as a whole,
  with clear routes into each offering.
- `/pathway` — The three stages explained, and how progression works.
- `/foundations` — Stage 1 cohort page, with signup.
- `/certified-automation-builder` — Stage 2 cohort + certification. **Highest priority page.**
- `/standard` — The competency framework, with PDF download.
- `/verify` — Credential verification lookup.
- `/about` — Johnathan and Bulletproof Automations.
- `/builder-pool` — Hiring standard and builder pool, with non-guarantee wording.
- `/workshops` — Price by Value and other standalone workshops (secondary now, not the headline).

Every course page needs: hard facts block (dates, time, format, cap, price, deadline),
what it covers, who it is not for, proof, and a real signup with a payment path.

---

## 8. Content that already exists

- **Foundations teaching guide** — complete, 8 detailed session plans with demos, common
  mistakes, portfolio checklists, rubric, and appendices. Source of truth for `/foundations` copy.
- **Competency framework v2** — the certification standard. See `@docs/competency-framework.md`.
  Source of truth for `/standard`, and for all weights, thresholds, and legal wording.
- **Intermediate week themes** — Section 5 above. Not yet written into full session guides.

---

## 9. Open decisions — do not invent these

Resolved on 9 August 2026 — see Section 12 for the confirmed values: Intermediate session time ·
cohort cap · certification assessment window · payment processor · instalment handling · seat
counter · second assessor · fonts · shared markup · interim homepage.

**Still open. Use visible bracketed placeholders; do not invent any of these.**

- ~~Enrollment deadline~~ — confirmed 9 August 2026: **Tuesday 8 September 2026**, four days before the cohort starts.
- Paystack account status: live or test mode; MoMo channels enabled (MTN, Telecel/Vodafone Cash,
  AirtelTigo); public key; callback URL.
- Instructor photo, bio, and which vendor certifications to list on `/about`.
- Refund and cancellation policy.
- Missed-session policy (recorded? make-up?).
- Foundations attendance minimum, as a number.
- Foundations cohort cap.
- Credential ID scheme and the `/verify` data source.
- Whether Foundations certificates are issued with credential IDs from launch.
- Cohort 1 proof — capstone screenshots, portfolio links, named testimonials with consent.
  The 5 September showcase is where this gets collected.
- BCAE copy on `/pathway` beyond its name, its type, and its reserved scope.
- Company detail for `/about` beyond "automation consultancy, Accra".
- Contact email to publish — confirm `training@bulletproofautomations.com`.
- Public WhatsApp number.
- **Price by Value workshop** — still running and moving to `/workshops/price-by-value`, or
  retired?
- Slack invite mechanism: is there a join link to publish, or are learners invited after payment?
  The instalment path now names the Slack instance publicly.
- Standard PDF for `/standard`: generated from `competency-framework.md`, or exported from the
  `.docx`? And by whom.
- Framework placeholders that appear verbatim on `/standard`: issue date, "assessed against
  n8n [VERSION]", next review date, and the two revision-history dates.
- Legal review of the hiring-standard wording (framework Section 7).
- Scenario bank: two practical scenarios and two seeded troubleshooting workflows before launch.
- Whether Foundations runs again, and when. Next Foundations cohort dates.
- Brand assets: logo or wordmark file, colour direction.
- Analytics — any? Cloudflare Web Analytics is the zero-JS-cost option.
- Where enrollment data goes. `waitlist_signups` is waitlist-framed, defaulted to
  `workshop_slug: 'price-by-value'`, and read by the `daily-digest` edge function.
  Recommendation is a new `enrollments` table, leaving the existing one and its digest alone.

---

## 10. Things that were considered and rejected

- **A 40-question timed entry exam as the BCAB gate.** Rejected: an unproctored MCQ is
  trivially defeated by an LLM, and it tests recall rather than building. Kept only as an
  advisory self-assessment. The real gate is a portfolio submission plus a live conversation.
- **Making Stage 1 a certification.** Rejected: it records completion of training, and should
  say so honestly. Making it failable would also have required a direct-entry route, which is
  incoherent for a completion certificate.
- **A final-week capstone build.** Rejected: it produced a crunch in Foundations. The
  Intermediate project grows across all five weeks instead.
- **USD pricing.** Rejected once the audience was confirmed as entirely Ghanaian.
- **Launching Stage 3.** Defined for pathway clarity, but issuing it before its standard exists
  would devalue Stages 1 and 2.

  ## 11. Foundations cohort — current state and page spec

### Current status
Cohort 1 ends 5 September 2026 with a public showcase.
Cohort 2 dates: TBD. Not announced yet.

### Showcase details (use verbatim on the page)
Event: n8n Foundations — Cohort 1 Showcase
Date: Saturday, 5 September 2026
Time: 11:30 AM – 1:00 PM GMT
Format: Online, free, open to the public
Luma link: https://luma.com/n8n-hj3o

Showcase pitch copy (use this exactly — do not rewrite it):

"Builders don't W8.

Eight weeks ago, a group of people right here in this community had never
built a single n8n workflow. Not one.

They didn't wait until they had a certificate. Didn't wait until they felt
qualified. Didn't wait for someone else to fix the thing that was frustrating
them at work. They picked a problem and built the automation themselves.

On Saturday 5 September they're showing you what they made.

Live demos. Real workflows solving real problems. And the honest version of
how they got there, including the parts that were harder than expected.

Here's the thing to pay attention to while you watch. Every person demoing
was exactly where you are eight weeks ago. That's the whole point of the
showcase.

If you've been telling yourself you'll get into automation once you have more
time, more experience, or a better reason, come and watch what eight weeks
actually produces. Then decide whether you want to be on that stage next time.

The next Beginner Cohort is coming. This is your look at what you'd walk
away with."

### Page state logic
The Foundations page must handle three states. The current state is State 2.

State 1 — Open for enrollment
  Show: dates, signup, full course page
  CTA: "Enroll — it's free"

State 2 — Cohort in progress (CURRENT STATE)
  Banner/tag: "Cohort in progress — enrollment closed"
  Show: showcase invite above the fold with Luma link
  Show: full course page below (curriculum, outcomes, portfolio
        proof, what you'll build each week) so visitors understand
        what they'd be signing up for next time
  CTA: "Watch the showcase — Saturday 5 September, free"
        secondary CTA: "Notify me when the next cohort opens"
        (simple email capture, no waitlist framing)

State 3 — Between cohorts
  Banner: "Next cohort dates coming soon"
  Show: showcase recap (testimonials, capstone screenshots) above
        the fold once available
  Show: full course page
  CTA: "Notify me when enrollment opens"

### Foundations course content (source of truth: docs/[teaching-guide])
Pull the curriculum detail from the instructor guide, not from memory.
Eight sessions: Getting Started · Triggers and Data · Connecting Apps ·
Working with APIs · Logic & Branching · Error Handling ·
AI-Powered Automation · Capstone.

Each session entry on the page should show:
  - Session name and number
  - What you build that week (the hands-on project)
  - What you can do after it (the skill, in plain language)
  - Portfolio artifact produced

Do not publish instructor notes, demo scripts, or deliberate-mistake
sequences from the guide. Page copy only.

### What the Foundations page is selling
Not the credential — that's Stage 2. Foundations sells:
  1. The showcase invite (right now)
  2. The next cohort spot (coming soon)
  3. The pathway — completing Foundations waives the BCAB entry
     assessment, which is a concrete financial and practical benefit
     worth naming explicitly on the page.

---

## 12. Confirmed decisions — site rebuild (9 August 2026)

Approved on 9 August 2026. These supersede any conflicting statement earlier in this brief and
the "Proposed site map" in Section 7.

### 12.1 Confirmed facts

| Item | Confirmed value |
|---|---|
| BCAB session time | Saturdays, **11:30 AM – 2:00 PM GMT** (2.5 hours) |
| BCAB cohort cap | **25 seats, fixed.** Stated plainly. **No seat counter** showing remaining availability |
| BCAB assessment window | **Begins 1 November 2026** |
| Payment provider | **Paystack** — MoMo shown ahead of card |
| Instalments | First instalment via Paystack at enrollment; remaining instalments arranged case by case through the Bulletproof Automations Slack instance and paid via MoMo. No automated instalment billing. Full payment before the certification assessment |
| Second assessor | **Publish the framework as written.** A second assessor will be identified before 1 November 2026 |
| Fonts | **Self-hosted `woff2`.** No Google Fonts CDN, no system font stack |
| Shared markup | Build-time includes added to `scripts/build.js`. Partials live in `partials/`, kept out of the copy allowlist |
| Homepage during Tier 1 | Minimal interim `/` until the full homepage is built in Tier 3 |

### 12.2 Approved site map

Status: **NOW** = build in this rebuild · **NAMED** = referenced, no page · **CARRIED** = exists,
outside the rebuild's scope.

| Slug | Purpose | Status |
|---|---|---|
| `/` | Umbrella page for the whole pathway | NOW (built last) |
| `/certified-automation-builder` | BCAB credential, the cohort that prepares you for it, and enrollment | NOW (built first) |
| `/standard` | The published competency framework, with PDF download | NOW |
| `/foundations` | Stage 1 certificate, showcase invite, full course detail | NOW |
| `/pathway` | The three stages and the two entry routes. The only page where BCAE is named | NOW |
| `/about` | Johnathan Lightfoot and Bulletproof Automations | NOW |
| `/verify` | Credential verification lookup | NOW |
| `/builder-pool` | Hiring standard, with the non-guarantee wording verbatim | NOW |
| `/workshops` | Index of standalone workshops. Secondary, not a headline | NOW |
| `/workshops/price-by-value` | Price by Value workshop, relocated | NOW (gated — still open) |
| `/thank-you` | Post-submission confirmation, rewritten from its waitlist framing | NOW |
| `/privacy` | How enrollment and notify-me data is handled | NOW (before forms go live) |
| BCAE | **No page.** Named on `/pathway` only — no date, no signup, no email capture | NAMED |
| `/nfc`, `/nfc/resources` | Personal NFC card pages. Not in nav, own design | CARRIED |
| `/admin` | Private dashboard. Repoint at the new enrollment table | CARRIED |

Deliberately absent: no `/enroll` route (enrollment is `#enroll` on the BCAB page), no separate
BCAB certification/training split, no `/contact` page, no blog, no coming-soon cards.

Redirects to add via a Cloudflare Pages `_redirects` file:
`/n8n-foundations` → `/foundations` · `/n8n-automation-builder-pathway` → `/pathway` ·
`/price-by-value` → `/workshops/price-by-value`

### 12.3 Design direction

Structural reference: **Microsoft Learn and Cisco's training and certification site.** The
load-bearing idea taken from both — the credential is the object, and training is one route to
it. The site must read as a certification body, not a course catalogue.

The pathway ladder is signposted site-wide by five mechanisms, not parked on one page:
a persistent pathway rail beneath the header; a stage badge in every hero; a "where this sits in
the pathway" block on every credential and course page; a pathway column in the footer; and
breadcrumbs.

Visual direction comes from the `frontend-design` skill. Hard constraints: works at 360px,
accessible by default (visible keyboard focus, sufficient contrast, semantic headings),
`prefers-reduced-motion` respected. No prior design from the current site carries forward.

### 12.4 Build order

**Tier 1 — the sellable unit.** Global shell · `/certified-automation-builder` · `/standard` ·
`/thank-you` · interim `/` · enrollment plumbing (new `enrollments` table, Paystack hand-off).

**Tier 2 — before the 5 September showcase.** `/foundations` (State 2) · `/pathway` · `/about`.

**Tier 3 — after enrollment closes.** Full `/` · `/verify` · `/builder-pool` · `/workshops` ·
`/privacy`.

Driven by the commercial deadline: the BCAB founding cohort starts 12 September 2026 and the
Foundations Cohort 1 showcase is 5 September 2026.
