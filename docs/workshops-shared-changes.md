# Webinars and workshops: shared production components

_4 November 2026. This is the non-regression record for PR #61. **Rule:** the feature is additive,
isolated and backward-compatible. Existing enrollment, installment, payment, Scheduling and
certification behaviour must stay exactly as it is._

## What the feature does NOT change

These are byte-identical to `main`, and the **Baseline regression** CI job checks it on every PR:

- `functions/api/_paystack.js` (cohort and installment Paystack calls). Webinars have their own
  calls in `functions/api/_workshops.js`.
- `functions/api/enroll.js`, `functions/api/installment.js`, `functions/api/_installments.js`,
  `functions/api/installment-scheduler.js`, `functions/api/_regions.js`, `functions/_middleware.js`.
- The `enrollments`, `payment_plan_installments` and `payment_events` tables. The migration creates
  **new objects only**, alters no existing table, and adds no trigger to an existing table.
  `tests/workshops-migration.test.ts` checks that `payment_events` has the same columns before,
  during and after.
- Bulletproof Scheduling (`book.bulletproofautomations.com`): no code, configuration or data is
  touched. Its existing `BPS-` guard in the webhook is unchanged.
- Certificate Studio, credentials and `/verify`.
- Every public page. With no session published, the built site is byte-identical to `main` except
  the reviewed list below (`tests/baseline/compare-site.sh`).

## Shared components that DO change

| # | Component | Change | Why it is necessary | Effect on existing behaviour | Rollback |
|---|---|---|---|---|---|
| 1 | **`paystack-webhook` Edge Function** (production v9, the single Paystack receiver for training *and* Scheduling) | v10 = v9 plus 128 added lines, none removed: a workshop branch that runs before the cohort code | v9 sends any unrecognised live charge to an **email fallback**. A paid webinar bought by someone with a cohort enrollment would be credited to their cohort balance (shown by the v9 baseline test). **Necessary only for PAID webinars on this Paystack account** | For a non-workshop transaction the new code is two string checks (reference prefix `BPA-WEB-`/`BPA-WTEST-`, metadata `app`), with **no database call and no new failure mode**. Then exactly v9's code runs. `main`'s own 30-case webhook test file passes unchanged against v9, v10 and this branch. Non-workshop traffic still passes when the workshop tables are made unreachable | Redeploy `supabase/deployed/paystack-webhook-v9/index.ts`. **Safe only before any paid workshop transaction exists.** After that, a later webhook or refund for a workshop charge would reach v9's email fallback. See the risk section |
| 2 | Supabase database | New tables and functions only | Workshop registrations need storage | None: no existing object altered | `supabase/migrations/rollback/20261103120000_workshops_down.sql`. Export workshop rows first |
| 3 | `admin/index.html`, `assets/js/admin-console.js`, `assets/css/admin-console.css`, `scripts/build.js` (admin views) | One nav link, one hidden workspace section, one new route `/admin/workshops/` | PRD: a webinar workspace inside the existing admin | All existing admin element IDs are unchanged (checked by the admin console test). The new script exits immediately on every other admin route | Revert the commit; no data involved |
| 4 | `_headers` | One appended rule matching `/workshops*` only | The Meta Pixel needs a CSP that allows Meta's script on those pages, and only those | None; the compare script checks additions only | Delete the rule |
| 5 | `scripts/build.js` (generator, optional tokens) | Generates workshop pages from `content/workshops/` | Reusable pages without a CMS | With nothing published, output is byte-identical. A Cloudflare build without the optional Meta/WhatsApp values succeeds (this was a bug, fixed and tested) | Revert the commit |
| 6 | `partials/header.html`, `partials/footer.html` | One marker line each | Nav link only when a session is published | Removed at build time, so output is identical | Revert the commit |
| 7 | CI and tests | New jobs; the Studio test is scoped to Studio migrations | Regression evidence | None in production | Revert the commit |

## The one material risk, and safer alternatives

**Risk:** deploying v10 changes the one production function that applies every training payment
and screens every Scheduling payment. The change is small and tested, but it is a change to a
shared, money-moving component. **Its rollback is not clean once paid webinars have happened.**

The three options, safest first:

| Option | Shared payment changes | What it allows | Trade-off |
|---|---|---|---|
| **A. Free webinars first** (recommended to start advertising) | **None.** v9 stays deployed. `WORKSHOP_PAID_CHECKOUT` stays off | Free registration, confirmation emails, admin, and Meta `CompleteRegistration` and attribution. The migration is additive | No paid webinars yet. Ads measure registrations, not revenue, until a later phase |
| **B. Separate Paystack account for workshops** | **None.** Workshop charges go to a different Paystack integration with its own new webhook function, so v9 never sees them | Paid webinars with complete isolation from cohorts and Scheduling, and clean rollback | A second Paystack business account (onboarding, separate settlement and dashboard), and a second small webhook function to build |
| **C. v10 on the shared receiver** (what this PR prepares) | Change #1 | Paid webinars on the existing account | Smallest code, but it changes the shared receiver, and its rollback is safe only before the first paid workshop transaction |

**Recommendation:** launch with **A**. Validate C in an isolated preview with real Paystack test
transactions (runbook step 5). Then choose B or C for paid webinars as a separate decision.
Until that decision, nothing in this PR needs v10 deployed.

## What "validated" requires, and its status

| Requirement | Status |
|---|---|
| Baseline tests of existing behaviour, run on `main` and on this branch | **Done.** Webhook: `main`'s own 30 cases on v9, v10 and branch. Cohort enrollment and installment endpoints: 10 cases on `main`'s code and branch, with the exact Paystack payloads compared. Site: byte-compare. Shared helpers: byte-identical. Each was checked to fail when a cohort payload is deliberately changed |
| No regression in those baselines | **Done.** All pass on both |
| Isolated preview database with real Paystack test transactions | **Not done; blocked.** This session cannot reach Paystack, Cloudflare, Supabase or Hostinger and holds no credentials. Needs the owner: runbook step 5 |
| Live webinar checkout | **Disabled.** It needs `WORKSHOP_PAID_CHECKOUT=on`, which is not set, and it is not needed for option A |

## A gap found in the test fixture

`tests/fixtures/payment-ledger.sql` (a catalog export) has no unique indexes on `enrollments
(cohort, email)` / `(cohort, whatsapp)`, which `supabase-enrollments.sql` documents as live. The
baseline adds them in its own setup rather than editing the export. Confirm against the live
catalog the next time the fixture is re-exported.
