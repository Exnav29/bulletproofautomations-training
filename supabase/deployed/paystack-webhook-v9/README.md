# Production snapshot: `paystack-webhook` v9

`index.ts` in this folder is the exact source of the Edge Function running in production.
It is stored here, outside `supabase/functions/`, so `supabase functions deploy` cannot pick it up
by accident, and the site build (`scripts/build.js`) never publishes `supabase/`.
`.gitattributes` marks the folder `-text`, so a checkout's line endings never change the bytes.

| | |
|---|---|
| Supabase project | `ikkldbhgjleelviwttir` (bulletproofautomations-training) |
| Function | `paystack-webhook`, **version 9**, `verify_jwt = false` |
| Deployed | 2026-11-02 01:32:45 UTC with `supabase functions deploy paystack-webhook --project-ref ikkldbhgjleelviwttir --no-verify-jwt --use-api` |
| SHA-256 | `0d1255d065a03ccf44391394132b224ea2320c6f9c435de87acd95c75a2acb10` |
| Based on | commit `e7f7e34` (v8, deployed 2026-08-13), SHA-256 `6ac042e3e8b122ddbd63717925462a3a78ab19486cb4764cca553f0375b5d37e` |
| Change | v8 plus the Bulletproof Scheduling guard and nothing else: 59 added lines, none removed |

After the deploy, the source downloaded back from production was compared with this file:
same bytes, same SHA-256.

**Not in production:** the installment-reference lookup added to this function in #30
(`3110f7d`, 2026-09-18). Version 9 is the August code. It still records installment payments
correctly: it credits the enrollment by email, and the database trigger
`payment_events_mark_installment_paid` then marks the installment paid. The tests pass 30/30
against this file, using production's schema and triggers. See
[docs/paystack-webhook-deployment.md](../../../docs/paystack-webhook-deployment.md).

## Check that production still matches

```bash
mkdir /tmp/pw && cd /tmp/pw && mkdir supabase
supabase functions download paystack-webhook --project-ref ikkldbhgjleelviwttir --use-api
sha256sum supabase/functions/paystack-webhook/index.ts   # 0d1255d0…acb10
```

## Redeploy exactly this version (recovery)

```bash
mkdir -p /tmp/pw9/supabase/functions/paystack-webhook
cp supabase/deployed/paystack-webhook-v9/index.ts /tmp/pw9/supabase/functions/paystack-webhook/
cd /tmp/pw9 && supabase functions deploy paystack-webhook --project-ref ikkldbhgjleelviwttir --no-verify-jwt --use-api
```

## Roll back to v8 (before the guard)

Deploy `e7f7e34:supabase/functions/paystack-webhook/index.ts` the same way. **Do not do this
while Bulletproof Scheduling takes live Paystack payments:** without the guard, a live appointment
payment whose email matches an enrollment is credited to that enrollment.
