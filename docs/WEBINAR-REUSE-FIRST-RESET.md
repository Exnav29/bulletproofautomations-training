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
