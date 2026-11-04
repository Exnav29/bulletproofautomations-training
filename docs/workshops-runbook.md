# Webinars and workshops: deployment, verification and rollback

_Updated 4 November 2026 for the separate Paystack business "Bulletproof Automations Webinars".
Nothing in this document has been run against production._

- Product contract: `docs/PRD-WEBINARS-WORKSHOPS.md` (PR #59).
- Design: `docs/workshops-design.md`.
- Non-regression record: `docs/workshops-shared-changes.md`. **Read it before any production step.**

**The production training webhook (v9) is not changed and is not redeployed at any step.**

## What exists on the branch

| Piece | Where | Production state |
|---|---|---|
| Schema, functions, RLS, webinar ledger | `supabase/migrations/20261103120000_workshops.sql` (+ rollback) | **Not applied** |
| Webinar webhook (new, separate) | `supabase/functions/workshop-paystack-webhook/index.ts` | **Not deployed** |
| Training webhook | `supabase/functions/paystack-webhook/` | Unchanged; byte-identical to `main` |
| Pages Functions | `functions/api/workshops/*`, `functions/api/admin/workshops.js` | Deploy with the site on merge. Inert until the tables exist |
| Public pages | Generated from `content/workshops/*.json` | **Nothing published** |
| Admin | `/admin/workshops/` | Deploys on merge |
| Ad tracking | `workshop-tracking.js`, `_meta.js` | Inert until the Meta IDs are set |

## Release sequence (each step needs explicit owner approval)

### 0. Paystack: the webinar business (owner, dashboard)

Switch the dashboard to **Bulletproof Automations Webinars** (check the business name and ID at
the top left before copying anything), then:

1. **Settings → API Keys & Webhooks:** confirm the test and live secret keys differ from the
   training business's keys. The code refuses equal keys, but check by eye too.
2. **Settings → Preferences → Payment channels:** confirm Mobile Money (MTN, Telecel, AirtelTigo)
   and Card are enabled in both test and live.
3. **Webhook URLs** (after step 3 below): test and live both point at
   `https://<project-ref>.supabase.co/functions/v1/workshop-paystack-webhook`. **Do not change the
   training business's webhook URL.**

### 1. Read-only pre-flight on the live database

```sql
select table_name from information_schema.tables where table_schema = 'public' and table_name like 'workshop%';  -- none
select column_name from information_schema.columns where table_name = 'payment_events' order by ordinal_position; -- note it; must be identical after step 2
select to_regclass('private.studio_graduate_webinar_entitlements');  -- PR #54, untouched
select version from supabase_migrations.schema_migrations order by version desc limit 5;  -- 20261103120000 absent
```

### 2. Apply the migration (additive)

Apply once. Then confirm `payment_events` has the same columns as in step 1, and:

```sql
select has_table_privilege('anon', 'public.workshop_registrations', 'select');  -- false
select has_table_privilege('anon', 'public.workshop_payment_events', 'select'); -- false
```

### 3. Deploy the webinar webhook (new function)

Set Edge Function secrets: `WORKSHOP_PAYSTACK_SECRET_KEY` (webinar live), `WORKSHOP_PAYSTACK_TEST_SECRET_KEY`
(webinar test). `PROJECT_URL` and `SERVICE_ROLE_KEY` already exist. Then:

```bash
supabase functions deploy workshop-paystack-webhook --project-ref <ref> --no-verify-jwt
```

Probe it:
- `GET` should return 405.
- An unsigned `POST` of `{}` should return 200 with `signature_valid:false`, and leave one row in
  `workshop_payment_events` and nothing in `payment_events`.
- A 503 `not-configured` means a key is missing, the wrong type, or equal to a training key.

Register the URL in the webinar business (step 0.3).

**Rollback:** unregister the URL in the webinar business and delete the function. The training
webhook is unaffected either way.

### 4. Cloudflare Pages variables (Production and Preview separately, then redeploy)

| Variable | Purpose |
|---|---|
| `WORKSHOP_PAYSTACK_SECRET_KEY` | Webinar business secret key. `sk_test_…` for the rehearsal; `sk_live_…` only at launch. A key equal to `PAYSTACK_SECRET_KEY` is refused |
| `WORKSHOP_PAID_CHECKOUT` | `on` opens **live** webinar checkout. **Last step, separately approved** |
| `HOSTINGER_MAIL_API_TOKEN` | Already set for installment emails; confirmation emails use it too |
| `WORKSHOP_SUPPORT_WHATSAPP` | Optional, only once verified (international format). Unset: no phone number is published |
| `WORKSHOP_REVIEW_RESPONSE_DAYS` | Optional. Unset promises no timeframe |
| `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_TEST_EVENT_CODE` | Optional ad measurement |
| `WORKSHOP_PAYSTACK_API_BASE`, `MAIL_API_BASE`, `WORKSHOP_CONTENT_DIR` | **Local testing only.** Never set them on Cloudflare (the code ignores the first two outside test or localhost, and the last on Cloudflare) |

### 5. Dispatcher (pg_cron + pg_net)

```sql
insert into public.workshop_dispatch_config (secret_hash) values (encode(extensions.digest('<secret>', 'sha256'), 'hex'));
```

Then create the schedule shown at the end of the migration (check `cron.job` first).

### 6. Test-mode rehearsal on an isolated preview database (before any live charge)

A Cloudflare preview uses the **Preview** variables. Make sure they point at an isolated database
before testing:

1. Create a separate Supabase project. Load `tests/fixtures/payment-ledger.sql`, then the
   workshop migration.
2. Deploy `workshop-paystack-webhook` there with the **webinar business's test key**.
3. Register that function's URL as the webinar business's **test** webhook.
4. Point Cloudflare **Preview** `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
   at it, and set Preview `WORKSHOP_PAYSTACK_SECRET_KEY` to the webinar **test** key.
5. Insert one `workshop_sessions` row, and the matching `content/workshops/<slug>.json` on the
   preview branch only.
6. Insert a cohort enrollment that uses **the same email** you will test with.
7. On the preview URL, open `/workshops/<slug>?paystack=test`. Register, then pay with Paystack's
   test **mobile money** and, separately, a test **card**.
8. Then check all of these:
   - the registration is `confirmed` in `/admin/workshops/`;
   - `workshop_payment_events` has a signed, matched row;
   - `payment_events` is **empty**;
   - the same-email cohort row is unchanged;
   - the confirmation email arrives;
   - a cancelled checkout followed by a retry pays once.

### 7. Publish the first session

1. Add `content/workshops/<slug>.json` with real values only. The build refuses placeholders,
   TBC and past dates.
2. Add the matching `workshop_sessions` row with the same `slug`, `starts_at` and `price_ghs`.
3. Merge. This publishes the page, the nav link and the sitemap entries.

### 8. Go live (separate approval)

Set Production `WORKSHOP_PAYSTACK_SECRET_KEY` to the webinar **live** key, then `WORKSHOP_PAID_CHECKOUT=on`,
and redeploy.

## Rollback of the whole feature

1. Unset `WORKSHOP_PAID_CHECKOUT` and redeploy. No new money can be taken.
2. Set sessions to `draft` (or delete their files) and merge. The pages disappear.
3. Keep `workshop-paystack-webhook` deployed while any webinar payment or refund may still arrive.
   The training side never needs rolling back.
4. Export first, then run the rollback SQL only if the data is no longer needed.

## Meta ads: URL parameters

```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_content={{ad.id}}&utm_term={{adset.id}}
```

## Definitions and behaviour

- **Paid webinar enrollment** (Meta `Purchase`, admin "Confirmed paid", revenue): `confirmed`, with
  a Paystack-verified payment, valued at that payment. A payment held for review is not counted
  until an admin admits it.
- **Other outcomes:**
  - abandoned checkout, then retry: both references are kept and the registration is paid once;
  - a second payment: access is kept and the extra payment is flagged for refund;
  - wrong amount, currency or mode: held for review, never confirmed;
  - a payment after the session filled: `payment_received_review`;
  - a refund: reversed on that attempt only.
- **References the webinar webhook doesn't recognise** (any non-`BPA-WEB-`/`BPA-WTEST-`
  reference): recorded only.
- **Confirmation page:** says the email was sent only when it has been sent.
