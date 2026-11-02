# Product requirements: Webinars & workshops on Bulletproof Automations Training

**Status:** Product direction confirmed; implementation NOT started  
**Date:** 2 November 2026  
**Product:** https://training.bulletproofautomations.com  
**Owner:** Bulletproof Automations  
**Implementation:** Claude Code, in a separate feature PR after reviewing this PRD

## 1. Decision in one paragraph

Add webinars and standalone interactive workshops as another way to register for learning on the EXISTING training website. Reuse the existing Cloudflare Pages site, Supabase project, form patterns, Paystack checkout, enrollment administration, confirmation conventions, and shared styling. Do not build a new application, introduce an LMS/event SaaS, or use `book.bulletproofautomations.com` (which is the dedicated one-to-one consultation scheduler). Make the smallest safe adaptation of cohort sign-up. The current cohort enrollment schema and payment handling are cohort-specific, so avoid pretending that a new radio option alone is safe.

**North star:** An existing learner should feel they registered for another Bulletproof training opportunity, not used a new product.

## 2. Context: code already in the repository

Read these *before implementing*, and inspect current code/live schemas rather than treating older documents as authoritative:

- `CLAUDE.md`: terminology, visual constraints, implementation guardrails.
- `README.md`, `scripts/build.js`, `partials/header.html`, `partials/footer.html`, `partials/head.html`, `assets/css/site.css`: site shell and deployed allowlist.
- `certified-automation-builder/index.html` and `assets/js/shell.js`: current cohort form, feedback states and client-side behavior.
- `functions/api/enroll.js`, `functions/api/_paystack.js`, `functions/api/_regions.js`: trusted registration and pricing logic.
- `supabase-enrollments.sql`, `supabase-payment-plans.sql`: documented cohort constraints (documentation, **not** migrations).
- `supabase/functions/paystack-webhook/index.ts`, `supabase/deployed/paystack-webhook-v9/index.ts`, `docs/paystack-webhook-deployment.md`, `tests/paystack-webhook.test.ts`: shared payment receiver, deployed-version drift and payment regression tests.
- `admin/index.html`, `assets/js/admin.js`, `docs/admin-operations-console.md`: existing authenticated admin workspaces.
- **Related existing work:** Draft PR #54, `ops/graduate-webinar-entitlements-20261031`, contains `docs/graduate-webinar-entitlements.md` and a migration for private graduate webinar benefits. Its migration is documented as *already applied* in the training Supabase project, despite being unmerged. DO NOT apply it a second time. Do not assume it is available on `main`, or publish its private tables.

Observed existing constraints:
- The site is plain HTML/CSS/vanilla JS, with **no framework or runtime dependency**; Cloudflare Pages builds `dist/` through a strict copy allowlist.
- Existing `/api/enroll` hard-codes `COHORT = "intermediate_2026_09"`, three `chosen_option` values, cohort-specific intake fields, regional pricing and certification-policy acknowledgements.
- The live `enrollments` table has constrained option and status values and a unique rule for cohort/contact. Do **not** broaden those constraints or insert webinar attendees as if they were BCAB students.
- The existing authenticated admin is already partitioned into bookmarkable workspaces; reuse that shell and login.
- Paystack is shared with Bulletproof Scheduling; production training webhook v9 protects `BPS-` transactions. **Crucially, both v9 and current source still have a live-charge email fallback that may credit unrelated payments to a cohort enrollment.** New webinar payment references will not automatically be safe.
- Workshop route `/workshops` was previously retired with the Price by Value page and is not currently included in `scripts/build.js`. Reintroduce only when the new pages actually exist. Keep the retired `/price-by-value` redirect intact.

## 3. Goals, success criteria and boundaries

### Goals

1. Visitor sees upcoming, real webinars and standalone workshops under `/workshops` with individual, shareable pages.
2. Visitor registers on the training site without an account, pop-up or appointment calendar.
3. Free sessions record a confirmed registration without checkout.
4. Paid sessions reuse trusted server-side Paystack integration and only become paid/confirmed on verifiable payment evidence.
5. Staff view webinar sign-ups in the **existing** training admin, independent of cohort rosters.
6. A new session can be offered without building another full registration application.
7. Cohorts, credentials, paid consultations and their live payment flows continue unchanged.

### Not in v1

- Do not install Luma, Calendly, Calnode, another ticketing vendor, an LMS, a CMS or a new frontend framework.
- Do not change the `book.bulletproofautomations.com` repository, service, database, event types, OAuth, calendar or consultation flow.
- Do not build a full course/video-hosting portal, livestream platform, recordings library, attendee accounts, coupons, affiliate tracking, complex bundles or new certification products.
- Do not automate entitlement-based free graduate access until its actual source, authorization and redemption rules have been validated with existing PR #54.
- Do not build a general-purpose marketing automation application. Use existing email infrastructure if verified.

### Measure delivery

Free and paid scenarios work from a mobile browser; the same person can enroll in a cohort and a webinar without cross-credit or collision; two attendees can join one webinar without reserving individual host appointments; two signups for the same event/email produce one attendee record; authorized admin can locate and export each session's registrants; existing cohort and scheduling regression tests remain green.

## 4. Information architecture and friendly visual design

### Navigation / routes

- New top-level primary navigation label: **Webinars & workshops**, linking to `/workshops`.
- `/workshops`: warm, straightforward listing with an upcoming section; optional completed-session archive if real content exists. Prominent session cards show title, exact date, start time and time zone, format, duration, honest price or "Free", short concrete outcome, and **View details**.
- `/workshops/<stable-slug>`: self-contained detail page suitable for WhatsApp/LinkedIn sharing. Include: title, what problem it solves, audience, 3–5 specific takeaways, prerequisites, date/time/time zone, duration, format, confirmed price, instructor, what participants receive, refund/cancellation link when relevant, FAQs only where useful, and **one inline registration form**.
- Homepage: replace/augment time-sensitive "Next at the academy" and "This term" areas only after an actual upcoming session is configured; do not display a past event as upcoming.
- Existing Pathway, Foundations, Intermediate, Certification and verification navigation remains available. Webinars are **not** an automatic credential or Stage 4.
- All public routes must join the build allowlist and sitemap only once built; check link resolution, canonical tags, title/description and OG social previews.

### Visual direction

**Welcoming, comfortable, deliberate, polished but non-corporate.** Reuse `assets/css/site.css` existing off-white/sand, ink, green, Archivo and spacing tokens. Softer card composition, ample whitespace, readable short paragraphs and natural photography *only when licensed/available*. Avoid flashy dashboards, gradients everywhere, stock-office imagery, heavy video heroes, fake scarcity or excessive animation. Mobile-first from 360px; accessible focus, contrast, labels, error summaries and reduced-motion. No modal/popup for registration. Buttons use plain outcomes: "Register for free webinar", "Register and pay", "View details". Existing company, independence and certification notices remain intact.

### Content guardrails

The company is a US business based in Jacksonville, Florida; many learners are in Ghana. Do not describe it as a Ghanaian company. Do not imply n8n affiliation or credentials from attending a webinar. Never fabricate a session date, time, price, instructor, capacity, testimonial, outcome metric or promise of employment. Publish only genuine scheduled sessions with accurate price and a working registration path; otherwise do not show a card.

## 5. Registration: reuse patterns, separate records where required

Use a **single reusable event registration form/component** within the existing website conventions. Do not duplicate the entire cohort form and payment engine.

### Required information

- Event/session ID supplied by the page but looked up and checked **server-side** against an open, published session.
- Full name and email; optional WhatsApp number for logistics (explicit consent if used for messaging).
- Separate required acceptance of relevant registration/attendance and refund terms, with consent policy/version recorded; do not reuse certification acknowledgements on an ordinary webinar.
- No city/experience-level/payment-plan questions unless that individual workshop actually requires them.
- Accessible honeypot and reasonable anti-abuse/rate limits without exposing attendee lists.

### States and behavior

- Free event: validated submission -> one **confirmed** registration -> visible success and confirmation instructions.
- Paid event: validated submission -> **pending_payment** -> trusted checkout -> **confirmed** only on a verified Paystack success. Callback/thank-you URL alone never confirms payment.
- If checkout cannot initialize, preserve a visible actionable pending registration without claiming the attendee paid or has a confirmed seat. Provide a retry or contact path.
- Duplicate email at the same session: idempotently resume or report the existing registration; do not double-book/double-charge. Same email can register for different sessions and existing cohorts.
- Optional capacity: store a real capacity only when configured; concurrency-safe enforcement for confirmed seats and pending holds; no misleading "spots left" counters. If sold out, say so without building a waitlist.
- Cancellation, refund request and no-show are separate states; never claim an attempted refund was settled.
- Store UTC instant plus IANA time zone and show unambiguous GMT/local information. Do not create one separate host calendar booking per attendee.
- Joining instructions / private meeting link are delivered only to confirmed registrants and/or shown to signed-in admin. Never embed private links in a public HTML or readable Supabase table.

### Minimal data model

Prefer **only two additive webinar-specific tables**, names may be adapted after inspecting the live Supabase schema:

1. `workshop_sessions`: UUID, stable public slug, type (webinar/workshop), public title and summary, delivery information/date/time/duration, published/closed/completed state, GHS amount (0 = free), nullable capacity, private join instructions and basic timestamps. Store the true charge amount server-side, never accept a browser price. One record per actual scheduled delivery. Repeat workshops by creating another session, not rewriting old registration history.
2. `workshop_registrations`: UUID, session FK, normalized email, full name, optional WhatsApp and consent, status, payment status, server-minted Paystack reference, exact expected amount/currency/mode, registration timestamps, optional attendance status, and administrative notes. Unique on (session, normalized email); references unique; immutable event/price snapshot for paid attempts.

Use **existing `payment_events` as the transaction evidence/audit trail**, extending its routing where necessary; do not create a fourth generic payment subsystem. If implementation requires a small internal payment-attempt ledger for robust retries, document why rather than building it speculatively.

Use Supabase RLS with no anonymous read/update/delete of registration data; public submission through a narrowly scoped Cloudflare Pages Function. Admin reads/updates require the existing authenticated allowlist. Never put the service-role key, private meeting URL, or payment secrets in browser assets. Before any database migration, verify actual live schema, current RLS, triggers and previously applied private migrations. Additive, reversible changes only.

### Reuse vs new code

Keep cohort `/api/enroll` behavior, BCAB option set, regional pricing and `enrollments` records unchanged. Extract **small shared helpers where beneficial** (validation, Paystack initialization, mode checks, confirmation display) rather than rewriting mature endpoints. Proposed separate `/api/workshops/register` and narrowly scoped admin/public-read endpoints are acceptable, but do not make a parallel app. Reuse current build includes, CSS classes, auth session and admin shell.

For initial releases, session page content may be authored in the repository using shared markup and a small controlled data source; **do not build a full CMS**. The registration endpoint's database record is authoritative for open/closed status, time, capacity and price. Never trust static displayed numbers if they differ from the server: fail safely and correct the page before charging.

## 6. Paystack is the principal non-regression boundary

The existing Paystack account has **one live webhook destination**, currently the training receiver. Keep that topology unless an explicitly reviewed plan changes it.

**Hard requirement:** An unrelated successful Paystack charge cannot be credited to the existing `enrollments` table merely because the payer used the same email address.

- Reserve a distinct, unambiguous reference namespace and app metadata for workshop payments (for example `BPA-WEB-...` live; a different explicit test prefix), without colliding with current `BPA-CAB-`, `BPA-TEST-` or Scheduling `BPS-`.
- In the shared signed webhook, dispatch **by transaction ownership/reference before any cohort email fallback**. Match webinar payments to a pending webinar registration by exact reference, charge amount, currency and test/live environment. Check transaction evidence and apply once, transactionally where practicable.
- Preserve the existing Scheduling guard and existing cohort installment trigger semantics. Do not route webinar refunds or payments through `enrollments` or `payment_plan_installments`.
- Maintain append-only `payment_events` logging; unknown charges stay unmatched and visible for review, not guessed by email.
- Existing production webhook is **v9**, not identical to `main`. Do not casually deploy `supabase/functions/paystack-webhook/index.ts`; start with `docs/paystack-webhook-deployment.md`, capture production version/hash, reconcile the behavior change, rehearse against realistic schema/triggers and deploy only with separate explicit owner approval.
- For refunds, comply with published policy and Paystack settlement truth. No automatic mass refunds; flag disputed/needs-attention refund states for manual resolution. Confirm the workshop refund policy before allowing paid checkout.

Required payment tests: cohort by exact reference, cohort installment, scheduling `BPS-`, verified webinar success, webinar duplicate webhook, mismatched amount/currency/mode, abandoned checkout, valid payment by email already used in a cohort, invalid signature, unknown reference, refund events and cross-product refunds. Include both current `main` and deployed webhook v9 behavior as regression baselines.

## 7. Confirmation, reminders and admin

### Participant

- Confirmation screen is specific to **that** session; date/time/time zone and registration ID shown.
- Send confirmation with the existing authorized Bulletproof business mail transport (determine what is actually configured; do not assume the Scheduling Resend setup is the training sender). Use branded business sending identity, never the personal Gmail address.
- Free confirmed and paid verified attendees receive clear join instructions; payment-pending attendees must never receive a "paid" receipt/join link as though confirmed.
- Include simple add-to-calendar (.ics or equivalent) if safe; no individual appointment slots and no accidental duplicate calendar invites.
- One reminder before the session is desirable after confirmation/email path is reliable; record delivery outcomes, avoid duplicates and preserve opt-outs. Reminder scheduling is not an excuse to invent a separate automation system.

### Training admin

Extend the existing authenticated training operations shell with a **Webinars & workshops** workspace and bookmarkable path, e.g. `/admin/workshops/`. Display sessions and registrant lists with filtering by session, payment state, registration state, and attendance. Allow export CSV and basic attendance marking. Reuse the existing auth and admin layout, not a separate login. Keep existing cohort enrollment, payment, credential and Certificate Studio views unchanged. For v1, creating session content in source plus a secure record is acceptable; rich in-dashboard event editing is follow-on work, not a blocker.

### Graduate entitlements: related, deliberately separate

Draft PR #54 / private `studio_graduate_webinar_entitlements` provides a possible complimentary graduate benefit. **Do not infer that every Intermediate graduate receives every paid webinar free, or that an unissued credential is valid.** Treat this as a distinct benefit policy to reconcile after core registration works. Private access only via authorized server verification; no public entitlement enumeration or certificate ID guesswork. Never conflate a completion certificate with BCAB certification. Confirm whether this PR is merged and migration applied before proposing a migration or binding.

## 8. Delivery approach for Claude Code

1. **Read/recon:** Read `CLAUDE.md`, this PRD, real relevant code, active PRs (#54), current production webhook docs. Report a concise implementation plan and identify anything that requires business approval (actual offerings, price, date, refund rules, capacity, meeting format). Do not invent values. Confirm database migration state read-only before changes.
2. **Design approval:** Propose the section order / simple mobile wireframe for `/workshops` and detail page, as repository rules require, **before building the public pages**.
3. **Free registrations first:** Minimal session and registration schema, server-side registration endpoint, reusable public form, success page, admin list, and tests; keep paid checkout disabled in this stage. Feature-flag or leave links unpublished until complete.
4. **Paid path second:** Add unique references, explicit webhook isolation, verified Paystack flow and rollback strategy. Rehearse test mode with real schema/triggers and representative cross-product cases. **Never activate live charging or deploy live webhook without separate explicit approval.**
5. **Production release:** Pull request with migration scripts, test evidence, screenshots at 360px and desktop, updated sitemap/build allowlist, security/RLS verification, written deployment and rollback checklist. Do not merge to `main` without review (Cloudflare Pages auto-deploys on merge).

### Existing files likely to change

`partials/header.html`, `partials/footer.html`, `index.html`, `assets/css/site.css`, `scripts/build.js`, `sitemap.xml`, new `workshops/` pages and partials, a narrow Cloudflare Pages workshop registration Function, additive Supabase migration(s), admin view additions, tests, and **only as required** the signed payment handler / payment helper. Do not copy the BCAB page wholesale.

### Acceptance checks (release gate)

- [ ] A real published free session has a working, accessible registration page and confirmation.
- [ ] Two different visitors register for the same session; duplicate address does not create a second seat.
- [ ] A user with an existing cohort enrollment can independently register for a webinar.
- [ ] The event page on 360px and desktop is clear, readable and comfortable; no registration popup.
- [ ] Internal links, canonical tags, OG card, sitemap and `dist/` build allowlist work.
- [ ] Admin access is authenticated; attendee lists and private joining instructions are not anonymously readable.
- [ ] Paid session amount comes from trusted server configuration, not the DOM.
- [ ] Same-email webinar charge cannot modify cohort enrollment or installment balances; same-email scheduling charge remains excluded.
- [ ] Repeat webhook does not double-apply money or double-email; invalid, unknown or wrong-mode transactions never confirm a place.
- [ ] Attendee never sees "paid" solely from return URL; confirmation email carries correct event details.
- [ ] Cohort signup, verification, Certificate Studio, scheduling appointments and existing Paystack flows show no regression.
- [ ] No live database, payment webhook or public-site deployment occurs without explicit approval and a rollback plan.

## 9. Decisions intentionally left unset

Before enabling an actual public session, supply the real **topic/title, instructor, date/time/time zone, format/joining provider, duration, capacity if limited, price (including whether free), refund terms, what is included, and any complimentary-graduate-access policy**. No placeholder goes onto an open registration page. Example workshop titles in conversations are concepts, not confirmed listings.

## 10. Short Claude Code kickoff instruction

> Read `CLAUDE.md` and `docs/PRD-WEBINARS-WORKSHOPS.md` in the `Exnav29/bulletproofautomations-training` repo (docs branch/PR if not yet merged). Implement the **smallest safe extension** of existing cohort registration for webinars and workshops. Begin with a concise code/schema audit and implementation plan; preserve cohort signups, the production Paystack v9 Scheduling guard, and `book.bulletproofautomations.com`. Read PR #54 for graduate webinar entitlements. Use a feature branch and PR; no production migrations, live webhook deploys, live payments or merges without approval. Follow the PRD's free-first rollout and acceptance tests.
