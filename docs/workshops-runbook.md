# Webinars and workshops: deployment, verification and rollback

_Written 3 November 2026. Nothing in this document has been run against production._

Product contract: `docs/PRD-WEBINARS-WORKSHOPS.md` (PR #59). This page covers how the backend ships.

## What exists on the branch

| Piece | Where | Production state |
|---|---|---|
| Schema, RPCs, RLS | `supabase/migrations/20261103120000_workshops.sql` | **Not applied** |
| Rollback | `supabase/migrations/rollback/20261103120000_workshops_down.sql` | Not applied |
| Webhook v10 candidate | `supabase/releases/paystack-webhook-v10/index.ts` (= v9 + 137 lines, 0 removed) | **Not deployed**. Production is still v9 |
| Same change on `main`'s webhook | `supabase/functions/paystack-webhook/index.ts` | Not deployed |
| Pages Functions | `functions/api/workshops/*`, `functions/api/admin/workshops.js`, `_workshops.js`, `_mail.js`, `_meta.js` | Deploy with the site on merge. Inert until the tables exist |
| Admin workspace | `/admin/workshops/` | Deploys on merge. It reports "migration not applied" until the tables exist |
| Browser tracking | `assets/js/workshop-tracking.js` | Ships, but no page loads it yet. With no `META_PIXEL_ID` it loads nothing |
| Public pages | not built | Blocked on the design gate |

## Why the order below matters

1. **Production v9 credits a webinar payment to a cohort balance.** A `BPA-WEB-` charge misses every
   cohort reference join and reaches v9's email fallback. `tests/paystack-webhook-workshops.test.ts`
   (v9 baseline) shows it: GHS 150 of webinar money lands on a cohort student's balance. So
   **live paid checkout must not open until v10 is deployed.** `WORKSHOP_PAID_CHECKOUT=on` is the
   switch, and the code refuses live checkout without it.
2. **v10 before or after the migration is safe either way.** Without the tables, v10's attempt lookup
   gets PostgREST's `PGRST205` and treats it as "not a workshop", so cohort payments keep flowing.
   Prefix- and metadata-marked workshop events are still isolated. Prefer **migration first**.
3. **The Pages Functions are harmless before the migration.** Registration returns a 502
   ("could not complete"), and no public page calls them yet.

## Release sequence (each step needs explicit owner approval)

### 0. Read-only pre-flight on the live project

```sql
-- Nothing named workshop_* yet
select table_name from information_schema.tables where table_schema = 'public' and table_name like 'workshop%';
-- payment_events matches tests/fixtures/payment-ledger.sql (no workshop_registration_id column)
select column_name from information_schema.columns where table_name = 'payment_events' order by ordinal_position;
-- PR #54's private objects exist and are untouched by this migration
select to_regclass('private.studio_graduate_webinar_entitlements');
-- Migration history: confirm 20261103120000 is absent
select version from supabase_migrations.schema_migrations order by version desc limit 5;
```

### 1. Apply the migration (approval required)

Apply it once, in the SQL editor or with `supabase db push`, after the pre-flight above. Then verify:

```sql
select has_table_privilege('anon', 'public.workshop_registrations', 'select');   -- false
select has_function_privilege('anon', 'public.workshop_apply_charge(text,bigint,text,text,timestamptz,text,uuid)', 'execute'); -- false
```

Run an anon `GET /rest/v1/workshop_registrations` with the publishable key. It must return 401 or `[]`.

### 2. Deploy webhook v10 (approval required)

Follow `docs/paystack-webhook-deployment.md`: download production and confirm
`sha256 0d1255d0…acb10`, then deploy from a clean folder:

```bash
mkdir -p /tmp/pw10/supabase/functions/paystack-webhook
cp supabase/releases/paystack-webhook-v10/index.ts /tmp/pw10/supabase/functions/paystack-webhook/
cd /tmp/pw10 && supabase functions deploy paystack-webhook --project-ref ikkldbhgjleelviwttir --no-verify-jwt --use-api
```

Download the function again and compare its SHA-256 with the file. Probe with `GET` (expect 405) and an
unsigned bad-JSON `POST` (expect 400). Then move the snapshot into `supabase/deployed/` with its hash.

**Rollback:** redeploy `supabase/deployed/paystack-webhook-v9/index.ts` (see its README). Never roll
back to v8. Do this only while `WORKSHOP_PAID_CHECKOUT` is off, or you reopen the hazard in point 1.

### 3. Cloudflare Pages variables (Production and Preview separately, then redeploy)

| Variable | Purpose |
|---|---|
| `WORKSHOP_PAID_CHECKOUT` | `on` opens live paid checkout. **Only after step 2.** Unset means paid sessions register without taking money |
| `HOSTINGER_MAIL_API_TOKEN` | Already used by installment emails. Confirmation emails need it |
| `WORKSHOP_REVIEW_RESPONSE_DAYS` | Optional. Number of business days promised in "payment held for review" emails. Unset means no timeframe is promised |
| `META_PIXEL_ID` | Build-time and runtime. Digits only. Unset keeps the Pixel and the consent bar off |
| `META_CAPI_ACCESS_TOKEN` | Runtime secret for the Conversions API. Never in the browser |
| `META_TEST_EVENT_CODE` | Optional. Routes CAPI events to Events Manager's Test Events tab while validating |

### 4. Dispatcher (pg_cron + pg_net)

Generate a long random secret and store only its hash:

```sql
insert into public.workshop_dispatch_config (secret_hash) values (encode(extensions.digest('<secret>', 'sha256'), 'hex'));
```

Then create the schedule shown at the end of the migration (check `cron.job` first). It reconciles
checkouts the webhook missed, sends emails and sends Conversions API events.

### 5. Test-mode rehearsal before any live charge

Open `/workshops/<slug>?paystack=test` (once the pages exist) with Paystack test MoMo. Confirm the
registration reaches `confirmed` in `/admin/workshops/`, with `payment_events.match_note` reading
"Workshop payment applied", and that the cohort roll is unchanged. Delete the test rows afterwards.

## Rollback of the whole feature

1. Unset `WORKSHOP_PAID_CHECKOUT` and redeploy Pages. No new money can be taken.
2. Revert the site PR. Public pages and the admin view disappear. The webhook keeps isolating workshop references.
3. Keep v10 deployed while any workshop payment may still arrive or be refunded.
4. Export first, then run the rollback SQL only if the data is no longer needed.

## Meta ads: URL parameters

Set these in each ad's URL parameters, so attribution doesn't depend on the Pixel or on consent:

```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}
```

In `/admin/workshops/`, "Results by campaign" counts only Paystack-verified paid registrations per
campaign and ad. Test-mode rows are excluded. Enter the same period's spend to get the cost per paid
registration.

## Behaviour reference

| Situation | Result |
|---|---|
| Free session | `confirmed` at once, email queued, `CompleteRegistration` |
| Paid, checkout started | `pending_payment`; attempt holds a seat for `hold_minutes` (30) |
| Paystack initialize fails | Attempt kept as `init_failed`; visitor can retry; a retry mints a new reference |
| Verified payment, seat available | `confirmed` / `paid`, email, `Purchase` |
| Verified payment after hold expired and session full | `payment_received_review`; participant told payment is held and they will be contacted; admin alerted |
| Payment for a cancelled, closed or already-started session | `payment_received_review` (`session_unavailable`) |
| Second successful payment | Registration stays `confirmed`; extra attempt `duplicate_payment`; `needs_review`; admin alerted |
| Wrong amount, currency or mode | Attempt `mismatch`; `needs_review`; never confirmed |
| Admin "Request refund" | `refund_pending`; seat stays held until Paystack sends `refund.processed` |
| `refund.processed` | Reversed on that attempt only (clamped); fully refunded means `refunded` and the seat is released |
| Unknown `BPA-WEB-` reference | Logged unmatched; never reaches cohort matching |
