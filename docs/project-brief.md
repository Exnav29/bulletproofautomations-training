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
- Cohort cap **12–15**. Smaller than Foundations because intermediate debugging is individual.
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

## 6. Pricing (decided in principle, exact numbers open)

- Founding cohort: roughly **GHS 800–1,200**. List price rising to **GHS 1,500–2,000** for cohort two.
- Foundations graduates get a meaningful discount, time-limited.
- Two-instalment payment plan.
- Small non-refundable assessment/readiness fee for Path B, credited against tuition on acceptance.
- 2–3 scholarship seats to protect the access mission.
- Validate against local Accra professional-training comparables before publishing.

Rationale: the entire warm market is 25 people who have never paid anything. Cohort one's goal
is a full room and testimonials, not revenue. Raising the price later with evidence is easy;
recovering from a half-empty first cohort is not.

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

- Exact Intermediate cohort start date, session time, and enrollment deadline.
- Exact prices (founding, list, alumni discount, assessment fee).
- Payment processor and MoMo integration path.
- Where the credential verification page lives and its data source.
- Second assessor (required by the framework's conflict-of-interest controls).
- Scenario bank: two practical scenarios and two seeded troubleshooting workflows before launch.
- Whether Foundations runs again, and when.
- Legal review of the hiring-standard wording.
- Next Foundations cohort dates.

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
