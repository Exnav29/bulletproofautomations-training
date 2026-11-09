# Webinar Architecture Reset: Reuse Existing Training Infrastructure

**Status:** Stage A audit only. No implementation, migration, deletion, deployment, payment-mode changes, or production activation without owner approval.

**Repository:** `Exnav29/bulletproofautomations-training`  
**Existing Supabase project:** `ikkldbhgjleelviwttir`

## Mandate

The business requirement is to **add webinars and standalone workshops as additional training types in the EXISTING Bulletproof Automations Training system**, not build a second training platform.

The working cohort infrastructure is the default for registration, enrollment, Paystack, notifications, credentials, attendance, reporting, and administrator access. **Inspect before assuming reuse is possible or impossible.** When there is a real incompatibility, show the specific file/function/schema constraint and the smallest safe extension that resolves it. A new standalone subsystem requires a documented, compelling technical reason.

### Non-negotiable rules

1. **Reuse first.** Trace and prefer existing functionality before introducing anything new.
2. **No duplication.** Do not duplicate enrollment, payment reconciliation, notification dispatch, credentials, authentication, or administrative logic merely because a training type differs.
3. **Explain gaps.** For every proposed new table/function/service, show why an existing one cannot be configured or minimally extended, what could break, and alternatives.
4. **Protect working cohorts.** Preserve existing beginner/intermediate enrollments, payment/installment flows, credentials, entitlements, permissions, and email operations.
5. **Scope discipline.** Do not add frameworks, subscriptions, new platforms, speculative features, or extra tests/CI infrastructure unless required.
6. **Safe cleanup.** Do not delete production data, deployed migrations, secrets, scheduled jobs, payment records, or dependencies without a verified dependency audit, rollback, and explicit approval.
7. **Observe reality.** Verify actual repository, Supabase schema/migrations, environment/deploy configuration, and working code paths. Do not rely on outdated documentation.
8. **Stop after Stage A.** This directive authorizes a read-only architectural audit and a short, concrete proposal, **not** implementation.

## What has already happened (verify each fact)

Current webinar work includes draft, unmerged **PR #61**, Release 1 migration `20261103120000_workshops.sql`, Release 2 migration `20261109120000_workshop_admission_benefits.sql`, workshop-specific tables/RPCs, APIs, Paystack handling, email dispatcher, admin panels, referral/benefit logic, and the `webinar-e2e-test-r2` rehearsal branch. **Both migrations were applied to the existing Supabase project**, so removing source files does not undo database changes.

The rehearsal session `rehearsal-what-to-charge` successfully processed one **GH₵350 Paystack TEST** transaction, reference `BPA-WTEST-2026-09PX033VX8`, and confirmed registration `6ab7bf12-1212-4dd6-91d1-eae9ac3a880b`. A confirmation was marked sent through Hostinger but was not observed in the destination Gmail inbox. Preserve all audit/payment data.

Workshop 01 `what-to-charge-for-automation` remains **draft**, with **zero** registrations. The rehearsal preview's dispatcher had been pointed to `webinar-e2e-test-r2`. Check current state rather than assuming it remains unchanged.

**The separate Hostinger-to-Resend webinar migration was stopped. Do not restart it.** First determine exactly how the working cohort system sends mail, and identify the smallest necessary correction. Existing Resend service elsewhere is not authorization to migrate this product.

## Business requirements to keep

**Initial training:** “You Know Automation. Do You Know What to Charge?”  
**Schedule:** Saturday 12 December 2026, 11:30 AM–2:30 PM Africa/Accra  
**Delivery:** live online via Google Meet, invited/eligible Google accounts  
**Seats:** 25 general + 5 reserved eligible Intermediate graduate = 30 total.

| Participant | Price |
| --- | ---: |
| Standard | GH₵350 |
| Qualified graduate referral | GH₵300 |
| Eligible Foundations certificate | GH₵280 (20% off) |
| Foundations certificate + referral | GH₵280 (nonstacking; referral credited if eligible) |
| Eligible Intermediate graduate | Free reserved place |

Additional rules: GH₵50 customer referral discount, GH₵50 graduate referral commission on qualifying payments, nonstacking discounts, paid-in-full/valid credential and entitlement checks using **existing credential records**, complimentary places reserved for eligible Intermediate graduates, **no payable commissions for tests**, and Google Calendar invitations only for confirmed eligible accounts. Maintain payment reconciliation and refunds safely.

Prefer one shared training model with a training type and delivery format; determine whether “webinar” and “workshop” are genuinely distinct types or simply variants. Do not contort cohort-specific schema if that would compromise it; shared services with appropriately separate records can be safer than forcing all data into an incompatible table.

## Stage A: Required investigation (READ-ONLY)

1. **Trace the functioning cohort path:** signup, enrollment, program/session selection, price calculation, Paystack merchant and checkout, webhook, reconciliation/refunds, confirmation mail, certificates/entitlements, attendance, admin dashboard, and reporting. Identify concrete paths, tables, RPCs, auth/RLS rules, deployed settings, and entry points.
2. **Trace the webinar path:** PR #61 and both migrated database releases, UI/API/backend, Paystack merchant and webhook, notification dispatcher, admin additions, referral, verification, Google Calendar, and test deployments. Identify actual duplication.
3. **Prepare a reuse matrix.** Label each webinar component **REUSE**, **EXTEND**, **RETAIN** (truly unique), **REMOVE** (redundant), or **DEFER** (not needed for first launch), with source locations and verified impact.
4. **For every gap**, document: exact blocker in existing cohort code/data; smallest possible change; alternatives; regression risk; and why reuse or configuration alone is insufficient.
5. **Evaluate Paystack carefully.** Reuse checkout/verification/reconciliation logic where feasible; preserve merchant/account separation and webhook routing where technically necessary. Never silently combine Paystack accounts, reassign transactions, or disturb live cohort charges.
6. **Evaluate email carefully.** Reuse existing working training mail path if practical. Determine why the rehearsal confirmation did not arrive despite a sent status; recommend the smallest fix. **No provider migration** authorized.
7. **Evaluate admin reuse.** Extend existing authenticated training dashboard and existing design system rather than inventing another admin experience.
8. **Design safe retirement:** list exact redundant files, functions, tables, jobs and configs; dependencies, payment-history retention, replacement paths, cleanup migration(s), rollback and approval gates. Applied migration files must not be deleted to rewrite history.

### Output: concise decision memo, not another PRD

Give the owner:

- **Assessment:** evidence-based answer on duplication/overengineering.
- **Actual existing workflow:** one short component map with specific paths.
- **Reuse matrix:** feature → cohort component → classification → smallest change.
- **True gaps:** precise blockers and minimal safe remedies.
- **Retain/remove/defer list:** exact affected objects and safety conditions.
- **Implementation proposal:** smallest sequenced changes, specific files/schema, testing, rollback, and approval points.
- **Risks & decisions:** only owner decisions needed before build.
- **Explicit statement that Stage A made no changes.**

Do not undertake broad exploratory refactoring. Do not create another PRD or implementation branch for Stage A unless the owner explicitly requests one. Read only; report clearly and **STOP FOR APPROVAL**.

## Stage B: Only after explicit owner approval

Work in a dedicated branch. Implement the approved reuse-first design with minimal changes. Preserve the existing cohort, Paystack, certificate, enrollment, and admin behavior. Use existing test infrastructure; ensure test/live isolation; perform focused end-to-end registration, discounts/referrals, verification, refunds, mail, admission, and cohort regression tests. Retire redundant code only after replacement paths are verified. Destructive database operations require separate approval and an established rollback. Do not merge PR #61, enable production paid checkout, publish Workshop 01, or deploy live changes without specific authorization.

**Decision standard:** Can the existing system do it? If yes, reuse it. If not, what is the smallest safe extension? Only then consider a new subsystem, with proof of necessity.

**Outcome:** One training platform supporting multiple training types, not a second platform bolted onto the first.


---

## Approved extension: automatic seven-day cutoff and FIFO waitlists

**Status:** Owner-approved functional requirements for the webinar/workshop rollout. This section supplements the original reuse-first mandate. It does **not** authorize immediate production deployment or destructive database changes. The original Stage A audit was completed; implement only after reconciling with the approved Stage B plan.

### Registration closing rule

For every webinar or standalone workshop, new paid and complimentary registrations close **exactly 168 hours before \`starts_at\`** (expressed/displayed in \`Africa/Accra\`); enforce server-side, including checkout initialization, not only in the browser. Show the exact cutoff time on the event page. At the cutoff, disable new regular registrations, waitlist entries and offers; let already confirmed registrations and automatic attendee communications continue. Carefully reconcile checkout sessions and payments initiated before cutoff, so a delayed Paystack webhook cannot create an unaccounted charge or uncontrolled oversell. Apply the cutoff consistently to rescheduled sessions. Workshop 01 starts 12 December 2026 at 11:30 AM Africa/Accra, so its cutoff is **5 December 2026 at 11:30 AM Africa/Accra**. Test immediately before, at, and after cutoff. Do not equate this business rule with statutory consumer cancellation rights.

### Waitlist scope and user experience

Use the **existing** workshop sessions, registration/seat allocation, Supabase, Paystack, shared Hostinger mail sender, notification outbox and dispatcher. Do **not** build a separate app, scheduler, payments subsystem, or second admin portal.

- When the relevant seat allocation is sold out or fully held, display **“Sold Out — Join the Waitlist”** and a free waitlist form instead of a paid checkout. Collect name, email and only essential existing registration/eligibility preferences; never initiate Paystack on waitlist enrollment.
- Record the timestamped, session-scoped entry and a deterministic tie-breaker. Prevent duplicate entries by normalized identity and session, including retry/race behavior. Send a waitlist acknowledgment via existing Hostinger notification transport. Where safe, show the individual's queue position without exposing anyone else's information.
- For the initial workshop honor **25 general paid seats + 5 reserved eligible Intermediate graduate seats, 30 total**. Maintain eligibility-aware FIFO within each allocation. **Never** issue a general admission offer against reserved graduate capacity without explicit authorized release; protect Foundations discounts, graduate referrals/commissions, graduate complimentary entitlements, and test/live isolation.
- When a confirmed place is freed by an eligible cancellation/refund, expiration of an existing hold, or approved capacity change, automatically issue an offer to the **oldest eligible** waiting person, using entry timestamp then stable tie-breaker. Document and audit any reason for bypassing an ineligible entry.
- Each offer includes a unique, unguessable, scoped, expiring claim token and **exclusively holds its seat**. This is essential: a concurrent new buyer, another offer or a duplicate webhook must not take the same seat. A token opens a prefilled registration page with the correct participant's data and current eligible price/discount, without revealing the participant's information to anyone else. Only the recipient should be able to use the claim securely; verify token, status, eligibility and expiry server-side. The participant must explicitly initiate any paid checkout. No charge for joining the waitlist or receiving an offer.
- The claim window is **24 hours**, ending earlier if the registration cutoff is reached. The hold expires automatically on decline, lapse, cancellation, or successful conversion. On failure/decline/expiry, release and offer the next eligible person in FIFO order. Payment failures can be retried within the valid window.
- Recheck hold and capacity **atomically on the server before starting Paystack checkout** and again during payment confirmation. Define a safe bounded **payment-in-flight state** so that a checkout begun before offer expiry is reconciled properly if its webhook arrives late. Never double-sell the seat, automatically charge a different participant, or lose a successful payment. Where a payment cannot result in a valid seat, record it as an exception for prompt reconciliation/refund rather than silently confirming oversold attendance.
- Use database constraints/transactions or existing locking/RPC mechanisms for idempotent seat assignment, offer transitions and webhook handling. Duplicate sends and concurrent releases must not create extra holds, payments, invitations or registrations.
- At the **168-hour cutoff**, stop new waitlist entries and offers; expire unaccepted/unpaid holds according to the specified payment-in-flight rule. Preserve the waitlist and offer audit history for reporting. Don't issue an offer that cannot be completed before cutoff.
- Automatically send waitlist acknowledgment, offer email with secure registration link, optional reminder, and offer expiration/decline notices using the existing Hostinger email/outbox. A waitlisted person **never** receives a Google Meet invitation or meeting access until their registration is actually confirmed.
- Once registration is paid/complimentary-confirmed, use the approved **automated Google Calendar invitation** workflow, with deduplication and subsequent cancellation/refund removal. Do not require the owner to invite attendees manually.
- In the existing admin console show general/reserved capacity, confirmed and held seats, FIFO entries, active offers, expirations, declined/converted entries and exceptions. Keep an auditable record of offer decisions and admin overrides.

### Required acceptance tests

1. Sold-out view replaces payment form with no-charge waitlist signup.
2. Waitlist enrollment is idempotent, timestamps order FIFO, does not contact Paystack and does not reveal other customers.
3. A freed seat offers the **oldest eligible** person an exclusive hold with a secure prefilled link.
4. Acceptance and explicit Paystack payment convert the held seat to a confirmed registration; confirmation triggers one automated Calendar invitation.
5. Decline and expiration release the hold and automatically move to the next person, including at the 168-hour cutoff.
6. A failed payment can retry safely within the offer window; a late verified payment cannot cause overselling or disappear.
7. Multiple simultaneous requests, webhooks, releases and retries preserve capacity and FIFO; no duplicate offers or charges.
8. Graduate reserved capacity, certificate entitlement, Foundations pricing, referral discounts/commissions and test-only payments remain isolated and correct.
9. Cutoff is enforced server-side immediately before, at and after the exact cutoff time; rescheduling recalculates correctly.
10. Existing cohort registration/payment/notifications and admin access remain unchanged.

**Implementation gate:** Inspect the actual workshop seat-hold/reservation model, \`workshop_*\` schema, outbox/dispatch, and checkout before proposing new objects. For any missing primitive, explain the exact limitation, the smallest safe schema or code extension, and its rollback. Make development-branch changes only with focused regressions; no production deployment, public registration, live Paystack activation, or destructive cleanup without owner authorization.
