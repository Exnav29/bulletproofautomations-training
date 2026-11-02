# Paystack webhook: what is deployed, and how to bring it in line with `main`

_Last updated 2026-11-02 (corrected the same day: installments; see below)._

## The two versions

| | Production (`paystack-webhook` v9) | `main` with this change |
|---|---|---|
| Source | [`supabase/deployed/paystack-webhook-v9/index.ts`](../supabase/deployed/paystack-webhook-v9/README.md) | `supabase/functions/paystack-webhook/index.ts` |
| Base | `e7f7e34`: August code, deployed as v8 on 2026-08-13 | `3110f7d` and later: adds installment plans (#30, 2026-09-18) |
| Scheduling guard | yes | yes, the same code |
| Installment lookup in the function | no: matched by email, then the database trigger marks the installment paid | yes: by installment reference (the trigger also runs) |
| Regression suite (30 cases) | 30 / 30 | 30 / 30 |

The Paystack account is shared with Bulletproof Scheduling (book.bulletproofautomations.com).
Both versions stop its payments, recognised by a `BPS-` reference or
`metadata.app = "bulletproof-scheduling"`, before any enrollment lookup. That check runs after
signature verification and the test/live checks. Without it, a live appointment payment would
reach the email fallback and be credited to the payer's enrollment.

## Installments in production

An earlier version of this page said production leaves paid installments `pending`, and that this
was why it passed 20 of 21 cases. **That was wrong.** The test database then had no triggers;
production's does.

- **What happens in production:**
  - The August function has no installment lookup, so an installment's reference misses the
    enrollment reference join and is credited to the enrollment by email.
  - The function then marks the event `matched`.
  - The database trigger `payment_events_mark_installment_paid` (see
    `supabase-payment-plans.sql`, enabled in production) then marks the installment with that
    reference `paid`.
- **Read-only audit, 2026-11-02:**
  - 9 installments `paid`, each with exactly one verified, matched `charge.success` event.
  - 0 installments not marked paid despite a verified payment.
  - The 2 `sent` installments are unpaid: one checkout is `abandoned` at Paystack, and the other
    has not been started.
  - Paystack's 10 successful live charges are all in the ledger.
- **What `main` changes:** it finds the installment by its own reference instead of by email, so
  it no longer depends on the payer using the same email address. The trigger still marks the
  installment paid.

The tests now run against production's schema, triggers included, in PGlite
(`tests/fixtures/payment-ledger.sql`, copied from the live catalog). Both versions pass all 30
cases.

## Run the suite

```bash
deno test --node-modules-dir=none --allow-net --allow-env --allow-read tests/paystack-webhook.test.ts   # main: 30/30
WEBHOOK_MODULE=$PWD/supabase/deployed/paystack-webhook-v9/index.ts \
  deno test --node-modules-dir=none --allow-net --allow-env --allow-read tests/paystack-webhook.test.ts # production: 30/30
```

`tests/fixtures/payment-ledger.sql` is production's `payment_events`, `enrollments` and
`payment_plan_installments`, with their constraints, indexes, trigger functions and triggers,
exported read-only from the live catalog. If the live schema changes, re-export it rather than
editing it by hand. A test checks that its trigger functions still match
`supabase-payment-plans.sql`.

CI runs both lines on every pull request.

## Bring production in line with `main` safely

Deploying `main`'s webhook changes how installment payments are matched: by installment
reference instead of by email. The installment is still marked paid by the trigger. That is a
smaller change than first described, but it still changes live payment handling, so treat it as
its own release, not part of the scheduling work.

1. **Merge this PR, then don't deploy it on its own.** Merging changes only the repository.
   Cloudflare Pages republishes the static site, which is unchanged by this PR. Edge Functions
   are deployed only by hand with `supabase functions deploy`.
2. **Installment plans are live** (11 rows, 2026-11-02), and production records them correctly
   through the trigger. No reconciliation is needed before deploying: the audit found no paid
   installment left unmarked. Re-run that check just before deploying.
3. **Don't replay old events.** Every installment payment so far is already applied, and a
   replay would add the money twice.
4. **Deploy `main`'s webhook in a quiet window.** Download production first
   (`sha256 0d1255d0…acb10` expected). Deploy, download again, and compare with `main`. Probe
   with `GET` (405) and an unsigned bad-JSON `POST` (400); neither writes to the ledger. Then
   watch the next real payment's `payment_events.match_note`.
5. **Rollback:** redeploy `supabase/deployed/paystack-webhook-v9/index.ts`. It keeps the guard.
   Never roll back to v8 or `e7f7e34` while Bulletproof Scheduling takes live payments.
6. **Afterwards,** replace the snapshot folder with the new production version and its SHA-256.

Until then, any webhook deploy must start from `main` with this change (guard included), or
from the v9 snapshot. Never from a checkout of `main` before this change, which has no guard.
