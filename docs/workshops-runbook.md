# Webinars and workshops: deployment, verification and rollback

_Updated 4 November 2026, after the frontend was built and checked. Nothing in this document has
been run against production._

Product contract: `docs/PRD-WEBINARS-WORKSHOPS.md` (PR #59). Approved design: `docs/workshops-design.md`.

## What exists on the branch

| Piece | Where | Production state |
|---|---|---|
| Schema, RPCs, RLS | `supabase/migrations/20261103120000_workshops.sql` | **Not applied** |
| Rollback | `supabase/migrations/rollback/20261103120000_workshops_down.sql` | Not applied |
| Webhook v10 candidate | `supabase/releases/paystack-webhook-v10/index.ts` (v9 plus 137 lines, none removed) | **Not deployed.** Production is still v9 |
| The same change on `main`'s webhook | `supabase/functions/paystack-webhook/index.ts` | Not deployed |
| Pages Functions | `functions/api/workshops/*`, `functions/api/admin/workshops.js`, `_workshops.js`, `_mail.js`, `_meta.js` | Deploy with the site on merge. Inert until the tables exist |
| Public pages | `scripts/workshops.js` generates `/workshops`, `/workshops/<slug>` and `/workshops/registered` from `content/workshops/*.json` | **Nothing published**, so on merge no route, nav item or sitemap entry ships |
| Admin workspace | `/admin/workshops/` | Deploys on merge. Shows "migration not applied" until the tables exist |
| Ad tracking | `assets/js/workshop-tracking.js`, Conversions API in `_meta.js` | Inert until `META_PIXEL_ID` and `META_CAPI_ACCESS_TOKEN` are set |
| Dispatcher schedule | commented `cron.schedule` at the end of the migration | **Not created** |

## Why the order matters

1. **Production v9 credits a webinar payment to a cohort balance.** A `BPA-WEB-` charge misses
   every cohort reference join and reaches v9's email fallback. The v9 baseline in
   `tests/paystack-webhook-workshops.test.ts` shows GHS 150 of webinar money landing on a cohort
   student's balance. **Live paid checkout must not open until v10 is deployed.**
   `WORKSHOP_PAID_CHECKOUT=on` is the switch, and the code refuses live checkout without it.
2. **v10 is safe before or after the migration.** Without the tables, v10's attempt lookup gets
   PostgREST's `PGRST205` and treats it as "not a workshop", so cohort payments keep flowing.
   Prefix- and metadata-marked workshop events are still isolated. Prefer migration first.
3. **The site can merge before any of this.** With no session published, the merged site is
   unchanged apart from the admin view. Publishing a session is a separate, later step.

## Definitions used everywhere

**A paid webinar enrollment** (Meta `Purchase`, the admin "Confirmed paid" column, and revenue)
means a registration that is `confirmed` and has a payment attempt Paystack verified (`succeeded`).

- **Value:** that attempt's amount. A duplicate payment never adds to it.
- **Payment held for review** (`payment_received_review`): this is not a paid enrollment.
  - It sends no `Purchase`, neither from the browser nor from the Conversions API.
  - It is shown separately as "Held for review".
  - If an admin admits it, one `Purchase` is sent with the same event id (`pu_<registration>`), so
    Meta counts it once.
- **Refunds:** deducted from admin revenue. Meta receives no correction event.

The same rule is written in `workshop_apply_charge` / `workshop_admin_action` (SQL),
`/api/workshops/status` (browser Pixel) and `assets/js/admin-workshops.js` (report). Tests pin it
down in `tests/paystack-webhook-workshops.test.ts` and `tests/workshops-api.test.ts`.

## Release sequence (each step needs explicit owner approval)

### 0. Read-only pre-flight on the live project

```sql
select table_name from information_schema.tables where table_schema = 'public' and table_name like 'workshop%';  -- none
select column_name from information_schema.columns where table_name = 'payment_events' order by ordinal_position;
select to_regclass('private.studio_graduate_webinar_entitlements');  -- PR #54, must be untouched
select version from supabase_migrations.schema_migrations order by version desc limit 5;  -- 20261103120000 absent
```

### 1. Apply the migration

Apply it once (SQL editor or `supabase db push`). Then check:

```sql
select has_table_privilege('anon', 'public.workshop_registrations', 'select');   -- false
select has_function_privilege('anon', 'public.workshop_apply_charge(text,bigint,text,text,timestamptz,text,uuid)', 'execute'); -- false
```

An anon `GET /rest/v1/workshop_registrations` must return 401 or `[]`.

### 2. Deploy webhook v10

Follow `docs/paystack-webhook-deployment.md`. Download production and confirm `sha256 0d1255d0…acb10`,
then deploy from a clean folder:

```bash
mkdir -p /tmp/pw10/supabase/functions/paystack-webhook
cp supabase/releases/paystack-webhook-v10/index.ts /tmp/pw10/supabase/functions/paystack-webhook/
cd /tmp/pw10 && supabase functions deploy paystack-webhook --project-ref ikkldbhgjleelviwttir --no-verify-jwt --use-api
```

Download it again and compare SHA-256. Probe it with `GET` (expect 405) and an unsigned bad-JSON
`POST` (expect 400). Move the snapshot into `supabase/deployed/` with its hash.

**Rollback:** redeploy `supabase/deployed/paystack-webhook-v9/index.ts`. Never roll back to v8. Do
this only while `WORKSHOP_PAID_CHECKOUT` is off.

### 3. Cloudflare Pages variables (set Production and Preview separately, then redeploy)

| Variable | Purpose |
|---|---|
| `WORKSHOP_PAID_CHECKOUT` | `on` opens live paid checkout. **Only after step 2.** |
| `HOSTINGER_MAIL_API_TOKEN` | Already used by installment emails; confirmation emails need it too |
| `WORKSHOP_SUPPORT_WHATSAPP` | **Optional, and only once verified.** International format, e.g. `+233546527779`. Read at build time for the pages and at runtime for emails. Unset: pages and emails point to email instead, and no phone number is published |
| `WORKSHOP_REVIEW_RESPONSE_DAYS` | Optional. Business days promised in "payment held for review" emails. Unset promises no timeframe |
| `META_PIXEL_ID` | Optional. Digits only. Unset keeps the Pixel and consent bar off. Optional tokens never fail the build |
| `META_CAPI_ACCESS_TOKEN` | Runtime secret for the Conversions API |
| `META_TEST_EVENT_CODE` | Optional, while validating in Events Manager |
| `MAIL_API_BASE` | **Local testing only.** Honoured only for `http://127.0.0.1` / `localhost`. Never set it on Cloudflare |
| `WORKSHOP_CONTENT_DIR` | **Local and CI only.** Ignored on Cloudflare, so test fixtures cannot ship |

### 4. Dispatcher (pg_cron + pg_net)

```sql
insert into public.workshop_dispatch_config (secret_hash) values (encode(extensions.digest('<secret>', 'sha256'), 'hex'));
```

Then create the schedule shown at the end of the migration (check `cron.job` first).

### 5. Preview rehearsal with isolated data (before any live charge)

**Warning: a Cloudflare preview build uses the Preview environment variables.** If those point at
the production Supabase project, a preview registration writes production rows. Before testing:

1. Create a separate Supabase project for previews.
2. Apply the ledger schema there (`tests/fixtures/payment-ledger.sql` is an exact export) and then
   the workshop migration.
3. Point Cloudflare's **Preview** `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
   at it.
4. Set a Paystack **test** key there. A test key reaches checkout only with `?paystack=test`.
5. Deploy v10 to that project with the test key as `PAYSTACK_TEST_SECRET_KEY`, and register its URL
   as Paystack's **test** webhook.

Then, on the preview URL:
- **Paid session:** register on `/workshops/<slug>?paystack=test` and pay with Paystack's test MoMo.
  Confirm `confirmed` in `/admin/workshops/`, and `payment_events.match_note` reading "Workshop
  payment applied".
- **Same-email cohort record:** confirm it is unchanged.
- **Retry path:** cancel a checkout, then retry it.
- **Email:** run the dispatcher and confirm the email arrives.

Delete the preview project's rows afterwards.

### 6. Publish the first session

1. Add `content/workshops/<slug>.json`. Copy the shape of `tests/fixtures/workshops/sample-webinar.json`,
   but every value must be real. The build refuses placeholders, TBC and past dates.
2. Insert the matching `workshop_sessions` row with the same `slug`, `starts_at` and `price_ghs`.
   A registration is refused if the page and database disagree.
3. Merge. This publishes `/workshops`, the session page, the nav link and the sitemap entries.
4. Use the session URL with the Meta parameters below in the ad.

## Local integration stack (what was run on 4 November 2026)

`tests/local-stack/README.md` covers this run. It used real Chromium, the real Pages Functions under
wrangler, real SQL with production's ledger schema and the workshop migration, and the real v10
webhook. **Paystack and the mail service were local stand-ins.**

- **What it proves:** the page, functions, database and webhook work together, including:
  - same-email cohort isolation;
  - retries and duplicates;
  - free sessions;
  - email content and outbox bookkeeping.
- **What it does not prove:** anything about Paystack's real checkout or webhooks, or delivery
  through Hostinger. Step 5 above covers those.

## Rollback of the whole feature

1. Unset `WORKSHOP_PAID_CHECKOUT` and redeploy Pages. No new money can be taken.
2. Set published sessions back to `draft` (or delete their files) and merge. The pages disappear.
3. Keep v10 deployed while any workshop payment may still arrive or be refunded.
4. Export first, then run the rollback SQL only if the data is no longer needed.

## Meta ads: URL parameters

```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}
```

## Behaviour reference

| Situation | Result |
|---|---|
| Free session | `confirmed` at once, email queued, `CompleteRegistration` |
| Paid, checkout started | `pending_payment`; attempt holds a seat for `hold_minutes` (30) |
| Paystack initialize fails | Attempt kept as `init_failed`; visitor can retry; a retry mints a new reference |
| Checkout abandoned, then retried | Both references kept; a late success on either confirms, once |
| Verified payment, seat available | `confirmed` / `paid`, email, `Purchase` |
| Verified payment after hold expired and session full | `payment_received_review`; participant told the payment is held; admin alerted; **no Purchase** until admitted |
| Payment for a cancelled, closed or already-started session | `payment_received_review` (`session_unavailable`); no Purchase |
| Second successful payment | Registration stays `confirmed`; extra attempt `duplicate_payment`; `needs_review`; one Purchase only |
| Wrong amount, currency or mode | Attempt `mismatch`; `needs_review`; never confirmed |
| Admin "Admit" | `confirmed`, admitted email, one Purchase at the verified amount |
| Admin "Request refund" | `refund_pending`; seat held until Paystack sends `refund.processed` |
| `refund.processed` | Reversed on that attempt only (clamped); a full refund means `refunded` and releases the seat |
| Unknown `BPA-WEB-` reference | Logged unmatched; never reaches cohort matching |
| Confirmation page | Says the email was sent only when the outbox row is `sent` |
