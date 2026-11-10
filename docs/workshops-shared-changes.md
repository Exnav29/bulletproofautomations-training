# Webinars and workshops: shared production components

_Updated 4 November 2026, after the owner chose a separate Paystack business ("Bulletproof
Automations Webinars"). This is the non-regression record for PR #61. **Rule:** the feature is
additive, isolated and backward-compatible. Existing enrollment, installment, payment, Scheduling
and certification behaviour must stay exactly as it is._

## Payment architecture

```
Training business (existing)              Webinar business (new, separate Paystack profile)
  /api/enroll, /api/installment              /api/workshops/register, /api/workshops/status
  PAYSTACK_SECRET_KEY                        WORKSHOP_PAYSTACK_SECRET_KEY
  -> Paystack (training) -> webhook v9       -> Paystack (webinars) -> workshop-paystack-webhook (new)
  -> enrollments, installments,              -> workshop_* tables, workshop_payment_events
     payment_events                             (cannot write any training table)
  Bulletproof Scheduling's BPS- guard: unchanged
```

Paystack sends each business's events only to that business's webhook URL. A webinar charge
therefore never reaches v9, so it cannot be credited to a cohort enrollment or a Scheduling
appointment, and nothing in the training payment path needed changing.

## Unchanged: byte-identical to `main`, checked on every PR

The **Baseline regression** CI job checks these:

- **Training payment code:** `functions/api/_paystack.js`, `enroll.js`, `installment.js`,
  `installment-scheduler.js`, `_regions.js`, `functions/_middleware.js`.
- **Installment email, by behaviour:** `_installments.js` changed in one place (row 8 below). The
  baseline job runs main's code and the branch's through the same assertions on the exact Hostinger
  requests, result codes and installment row updates.
- **Training webhook:** `supabase/functions/paystack-webhook/`, the production v9 snapshot in
  `supabase/deployed/`, its test file `tests/paystack-webhook.test.ts`, and the ledger fixture.
  **Production v9 needs no redeploy.**
- **Database:** `enrollments`, `payment_plan_installments` and `payment_events`. The migration
  creates new objects only, and `tests/workshops-migration.test.ts` checks that `payment_events`
  has the same columns before, during and after.
- **Untouched systems:** Bulletproof Scheduling, Certificate Studio, credentials, `/verify`.
- **Public pages:** identical while nothing is published (`tests/baseline/compare-site.sh`).

## Shared components that change

| # | Component | Change | Why | Effect on existing behaviour | Rollback |
|---|---|---|---|---|---|
| 1 | Supabase database (shared project) | New `workshop_*` tables, functions and policies, including its own ledger `workshop_payment_events` | Storage for webinars | None: no existing object is altered | `supabase/migrations/rollback/20261103120000_workshops_down.sql`, after exporting workshop rows |
| 2 | Supabase Edge Functions (shared project) | A **new** function `workshop-paystack-webhook`. The existing `paystack-webhook` is not touched | The webinar business needs its own receiver | None: a separate function with separate secrets | Delete the function and unregister its URL in the webinar business |
| 3 | Supabase Edge Function secrets (shared project) | New: `WORKSHOP_PAYSTACK_SECRET_KEY`, `WORKSHOP_PAYSTACK_TEST_SECRET_KEY` | The webinar business's keys | None: existing secrets are unchanged. The new function refuses to run if a webinar key equals a training key | Remove the two secrets |
| 4 | Cloudflare Pages variables | New: `WORKSHOP_PAYSTACK_SECRET_KEY`, `WORKSHOP_PAID_CHECKOUT` (and the optional mail, Meta and WhatsApp settings) | Webinar checkout | None: existing variables are unchanged. A webinar key equal to `PAYSTACK_SECRET_KEY` is refused | Remove them and redeploy |
| 5 | Admin shell (`admin/index.html`, `admin-console.js/.css`, build admin views) | One nav link, one hidden workspace, route `/admin/workshops/` | PRD: webinar admin inside the existing dashboard | Every existing admin element ID is unchanged (admin console test) | Revert the commit |
| 6 | `_headers` | One appended rule matching `/workshops*` only | CSP for the Meta Pixel on webinar pages only | None (additions-only check) | Delete the rule |
| 7 | `scripts/build.js`, header and footer markers | Page generator; optional build values | Reusable pages | Output identical while nothing is published; optional values never fail a Cloudflare build | Revert the commit |
| 8 | `functions/api/_installments.js` | `sendInstallment` sends through the shared Hostinger sender `functions/api/_mail.js` instead of its own copy of the same two API calls | One email sender for the site instead of two copies | None observable: same mailbox, same requests and display name, same result codes and row updates (baseline tests run on main's code and this branch's). Only difference: a network exception now returns `mail_unreachable` (502) instead of throwing | Revert the commit |
| 9 | `assets/js/admin.js` (cohort admin) | The enrollments, payment-events and credentials CSV exports prefix `'` to a cell starting with `=` `+` `-` `@`, tab or CR | Codex audit, 9 November 2026: names, cities and notes are typed by the public, and a spreadsheet runs such a cell as a formula | Ordinary cells export exactly as before (`tests/admin-csv.test.js`). `compare-site.sh` strips exactly these lines and requires the rest of the file to match `main` | Revert the commit |

## How isolation is enforced, not just assumed

- **Separate business, separate keys.**
  - Webinar Pages Functions read only `WORKSHOP_PAYSTACK_SECRET_KEY` and never import
    `_paystack.js`.
  - The webinar webhook verifies signatures only with the webinar business's keys.
  - Both refuse to work if a webinar key equals a training key.
- **No code path to training tables.**
  - The webinar webhook can write `workshop_payment_events` and call `workshop_apply_*` only.
  - Those functions touch `workshop_*` tables only.
- **Defence in depth.** The webinar webhook applies only references it minted (`BPA-WEB-` /
  `BPA-WTEST-`). A cohort, installment or Scheduling reference arriving there is recorded and
  never applied.
- **Tests.** `tests/workshop-webhook.test.ts` runs 25 cases on production's ledger schema with a
  same-email part-paid cohort student. Every case asserts the cohort rows are unchanged and
  `payment_events` is empty, including cohort and Scheduling references sent to the webinar
  webhook and an event signed with a training key.

## Validation status

| Requirement | Status |
|---|---|
| Existing-behaviour baselines on `main` and this branch | Done: `main`'s own 30-case webhook tests on v9 and branch, the cohort and installment endpoint baseline (10 cases, exact Paystack payloads, mutation-checked), byte-identity checks, and the site comparison |
| Full journey on an isolated database (local) | Done: 26/26 with a real browser, the real Pages Functions under wrangler, real SQL and the webinar webhook. **Paystack is a local stand-in** |
| Real Paystack test mode on the webinar business and an isolated preview database | **Owner action needed.** This session cannot reach Paystack, Cloudflare or Supabase and holds no credentials |
| Keys unique to the webinar business; MoMo and card enabled | **Owner check** (dashboard). Uniqueness is also enforced in code |
| Live webinar checkout | Disabled: needs `WORKSHOP_PAID_CHECKOUT=on` |

## A gap found in the test fixture

`tests/fixtures/payment-ledger.sql` (a catalog export) lacks the unique indexes on
`enrollments (cohort, email)` / `(cohort, whatsapp)` that `supabase-enrollments.sql` documents.
The baseline adds them in its own setup. Confirm against the live catalog when the fixture is
re-exported.
