# Paystack webhook: what is deployed, and how to bring it in line with `main`

_Last updated 2026-11-02._

## The two versions

| | Production (`paystack-webhook` v9) | `main` with this change |
|---|---|---|
| Source | [`supabase/deployed/paystack-webhook-v9/index.ts`](../supabase/deployed/paystack-webhook-v9/README.md) | `supabase/functions/paystack-webhook/index.ts` |
| Base | `e7f7e34`: August code, deployed as v8 on 2026-08-13 | `3110f7d` and later: adds installment plans (#30, 2026-09-18) |
| Scheduling guard | yes | yes, the same code |
| Installment payments | **not handled** | handled |
| Regression suite | 20 / 21 | 21 / 21 |

The Paystack account is shared with Bulletproof Scheduling (book.bulletproofautomations.com).
Both versions stop its payments, recognised by a `BPS-` reference or
`metadata.app = "bulletproof-scheduling"`, before any enrollment lookup. That check runs after
signature verification and the test/live checks. Without it, a live appointment payment would
reach the email fallback and be credited to the payer's enrollment.

## Why production passes 20 of 21

The one failing case is `training: installment charge advances the enrollment and the installment`.
It tests code that production has never had:

- `main` (#30) first looks the reference up in `payment_plan_installments`. Then it credits the
  owning enrollment and marks that installment `paid`.
- Production (August code) has no installment lookup. An installment's reference
  (`BPA-CAB-…`, stored on the installment row) misses the enrollment reference join and falls back
  to email. The enrollment balance is credited, which is usually the right enrollment. But the
  installment row stays `pending`, so the installment scheduler may keep treating it as unpaid.

This was true before the scheduling guard and is not changed by it. On the August code, the same
case fails identically with and without the guard.

## Run the suite

```bash
deno test --allow-net --allow-env --allow-read tests/paystack-webhook.test.ts           # main: 21/21
WEBHOOK_MODULE=$PWD/supabase/deployed/paystack-webhook-v9/index.ts \
  deno test --allow-net --allow-env --allow-read tests/paystack-webhook.test.ts         # production: 20/21
```

CI runs the first line on every pull request.

## Bring production in line with `main` safely

Deploying `main`'s webhook switches on installment handling for real payments. Treat it as its
own release, not part of the scheduling work.

1. **Merge this PR, then don't deploy it on its own.** Merging changes only the repository.
   Cloudflare Pages republishes the static site, which is unchanged by this PR. Edge Functions
   are deployed only by hand with `supabase functions deploy`.
2. **Decide whether installment plans are live.** Check whether the site's installment endpoints
   (`/api/installment`, the scheduler) are in use, and whether `payment_plan_installments` has
   rows with a `paystack_reference`. If installments are already being charged, production is
   under-recording them today (see above). That raises the priority of step 4, but does not
   change how to do it.
3. **Before deploying, reconcile any installment payments made so far.** Each `payment_events`
   row whose reference matches a `payment_plan_installments.paystack_reference` was credited by
   email. Mark those installments `paid` by hand. Don't replay the events: the enrollment balance
   is already credited, and a replay would add the money twice.
4. **Deploy `main`'s webhook in a quiet window.** Download production first
   (`sha256 0d1255d0…acb10` expected). Deploy, download again, and compare with `main`. Probe
   with `GET` (405) and an unsigned bad-JSON `POST` (400); neither writes to the ledger. Then
   watch the next real payment's `payment_events.match_note`.
5. **Rollback:** redeploy `supabase/deployed/paystack-webhook-v9/index.ts`. It keeps the guard.
   Never roll back to v8 or `e7f7e34` while Bulletproof Scheduling takes live payments.
6. **Afterwards,** replace the snapshot folder with the new production version and its SHA-256.

Until then, any webhook deploy must start from `main` with this change (guard included), or
from the v9 snapshot. Never from a checkout of `main` before this change, which has no guard.
