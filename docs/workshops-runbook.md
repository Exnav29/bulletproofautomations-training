# Webinars and workshops: deployment, verification and rollback

_Updated 8 November 2026. Steps 1 to 3, 5 and 6 have been run against the existing Supabase
project (owner-approved); see "Where it stands". Live checkout is off._

- Product contract: `docs/PRD-WEBINARS-WORKSHOPS.md` (PR #59).
- Design: `docs/workshops-design.md`.
- Non-regression record: `docs/workshops-shared-changes.md`. **Read it before any production step.**

**The production training webhook (v9) is not changed and is not redeployed at any step.**

## Where it stands (8 November 2026)

| Step | State |
|---|---|
| 1-2. Migration | **Applied** to the existing project after a verified backup. 19 protected checks (cohort, installments, `payment_events`, credentials, certificates, schema) unchanged |
| 3. Webinar webhook | **Deployed** as `workshop-paystack-webhook` with the Webinars **test** key only. Registered as the Webinars business's **test** webhook |
| 5. Dispatcher | **Scheduled**: cron job `workshop-dispatch`, every minute, token in Vault (`workshop_dispatch_token`). It points at the **preview** `webinar-e2e-test` until merge |
| 6. Test-mode rehearsal | **Done on the existing project** (owner decision, no second project): MoMo and card payments, a cancelled checkout and retry, signed webhooks, automatic confirmation emails. Test rows use `BPA-WTEST-` and are excluded from revenue |
| Test session `test-webinar-checkout` | Set to `draft`: not visible, not bookable |
| Get Paid for Automation, workshop 01 | Page file published; database row **`draft`**, so it shows "Registration isn't open yet" and cannot take a booking |
| Workshop 01 joining details | **Stored on the row** (8 November 2026): Google Meet link and joining instructions. Never in this repository, which is public |
| Webinar and workshop refund policy | **Drafted, not approved**: `content/workshops/refund-policy.json`, `"approved": false`. Nothing published |
| Release 2: admission, prices, benefits, referrals | **Built and tested, not applied.** `20261109120000_workshop_admission_benefits.sql` is on the branch only. Until it is applied every session reads as `link` at its own `price_ghs` |
| Workshop 01 price | **GHS 350** on the draft row (9 November 2026); test transactions untouched |

## Joining: Google Meet by Calendar invitation

Each workshop has its own Google Calendar event and its own Meet link, on the owner's calendar,
with Meet's access restricted to invited guests. A session with `admission = 'invite'`
(migration `20261109120000_workshop_admission_benefits.sql`) is joined **only** by Google accounts on that
event. Nothing in this repository creates or edits a Calendar event.

**What the participant gives us.** The paid form asks for the Google account they will join with
(`attend_email`), which may differ from the payment email. The server refuses an invitation-only
registration without one. The first value wins: re-submitting the form with someone else's
payment email cannot redirect their invitation. Later changes go through the admin.

**What they receive.** The confirmation email explains the invitation and names the account. It
carries **no Meet link and no calendar file**: the link only works for invited accounts, and the
Google invitation is the calendar entry, so a second one would duplicate it. Google sends the
invitation, with the Meet link, when the admin adds the guest.

**Admitting people (manual, in `/admin/workshops/`, panel "Google Calendar invitations").** For each
invitation-only session it derives:

| List | Who | What the admin does |
|---|---|---|
| Add to the event | `confirmed` and either paid (Paystack-verified, or admitted from review) or a complimentary graduate place still matching an active entitlement, with an account not on the event | Copy the addresses, add them as guests on that session's event, choose **Send** when Calendar asks, then click "Added in Calendar" |
| Remove from the event | An account on the event whose registration is no longer `confirmed` (refund requested, refunded, cancelled) or that was replaced | Remove the guest in Calendar, then click "Removed in Calendar" |
| Paid, no Google account yet | `confirmed` without an account | Email them; set it with "Set Google account" |

The database refuses to record an invitation for a registration that is not `confirmed` and paid or legitimately free, a graduate place whose entitlement has lapsed, a second
registration with the same account, or a new account while the old one is still on the event.
"Added" twice is a no-op. Account changes are made only on a request from the registered email.

**Event settings, once per event:** guests cannot see the guest list and cannot invite others, so
participants never see each other's addresses. Keep the Meet access setting restricted to invited
guests. Do not add anyone who has not appeared under "Add to the event".

**Joining instructions stay private.** `join_instructions` and `calendar_event_id` live only on the
session row: `anon` and `authenticated` have no grant, and no public endpoint selects them. An
invitation-only session never prints `join_instructions`. The build fails on a meeting link or a
join field in any content file, and CI fails if one reaches `dist/`.

### Can invitations be automated?

**Yes, technically, but not with what exists today, and it needs the owner's authorization.** The
events live on a personal Google account, so a Google service account cannot reach them:
domain-wide delegation exists only for Workspace. Automation would need:

1. a Google Cloud project with the Calendar API enabled, at no cost;
2. an OAuth client and consent screen, published "In production". In "Testing" the refresh token
   expires after 7 days. An unverified app is allowed for the owner's own account, behind
   Google's warning screen;
3. the owner signing in once to grant `calendar.events` on that account, with the refresh token
   stored as a Supabase or Cloudflare secret, never in this repository;
4. code calling `events.patch` on each event's `calendar_event_id` to add or remove the derived
   guests, with `sendUpdates=all`.

The manual panel is the first version because it needs none of that. If automated later, the same
derived lists and `workshop_admin_admission` records stay as they are; only the clicking changes.

### Access test before taking money (owner, with two Google accounts)

The site cannot test Google's side. Do this on workshop 01's event:

1. Add account A as a guest.
2. Open the Meet link signed in to A. A should go straight in, or be admitted without being asked.
3. Open it signed in to account B, which is not invited. B should be refused, or held at "Ask to
   join" with nobody able to let it in except the host.
4. Sign out of Google and open the link. The same result as B.
5. Remove A, then try A again. A should now be treated like B.
6. Check that A's invitation shows no other guests.
7. Run a call with three or more people past 60 minutes, hosted by the account that owns the event.

Record the results in the PR before opening registration.

## Prices, certificate benefits, reserved places and referrals

Part 2 of migration `20261109120000_workshop_admission_benefits.sql`. The database decides every price; the page
only describes it.

| Who | Price | Checked against |
|---|---|---|
| Anyone | `price_ghs` (GHS 350) | — |
| Foundations certificate holder | `price_ghs` less `foundations_discount_pct` (20%: GHS 280) | `public.credentials`: `foundations`, valid, issued, not expired, `holder_email` = registration email |
| Intermediate graduate | Free when `graduate_free`, in one of `reserved_graduate_seats` | PR #54's `private.studio_graduate_webinar_entitlements_by_certificate` = `active`, credential valid and issued, `holder_email` = registration email, and the training enrollment paid in full with no installment owing |

- **The certificate ID and the email must both match.** Certificate IDs are public (LinkedIn), so an ID alone proves nothing. A claim that does not match registers nobody and charges nothing (`benefit_not_matched`).
- **Places:** `capacity` is the **general** places (25). Graduates count only against `reserved_graduate_seats` (5), so the total is 30. Unused reserved places are not released to general registrants.
- **Checkout** charges the price stored on the registration when it was created. A payment of any other amount is held as a mismatch, never confirmed.
- **Invitations:** a complimentary graduate place is invited exactly like a paid one. The graduate is re-checked against the certificate register and entitlement at the moment of invitation.
- **Referrals:** codes are issued from `/admin/workshops/` only to eligible graduates, one each (eight characters, A–Z and 2–9).
  - A link is `/workshops/?ref=CODE` and is remembered for the browser tab.
  - A code counts only when it is active, is not the referrer's own registration, and is not a complimentary place.
  - Commission is `referral_commission_ghs` (GHS 50) on a confirmed, fully paid registration. It is **derived**, not stored as owed.
  - The admin pays by MoMo, then records the reference. Each registration can be paid once.
  - A refund after payout shows as "review"; nothing is clawed back automatically. No Paystack split or subaccount is used.
- Verified read-only on 9 November 2026: the rules match exactly the **2** active graduate entitlements and **10** valid Foundations certificates.

## Go-live: Get Paid for Automation, workshop 01

Each line needs owner approval. Order matters: the row opens registration, so it goes last.

1. **Google Meet.** On the host account, confirm it is a Google One plan of **2 TB or more**. Google's help says those plans host group calls of up to 100 people for up to 24 hours; 100 GB Basic and free accounts stop at 60 minutes. Then run the access test above, with a real call of three or more people past 60 minutes.
2. **Refund policy: legal review, then approval.** In `content/workshops/refund-policy.json` set `"legal_review": "complete"`, `"approved": true` and `"version"` to the effective date. Set `TERMS_VERSION` in `functions/api/_workshops.js` to the same date, in the same commit. The build refuses approval without the legal review, and a test fails if the versions differ.
3. **Back up**, then **apply `20261109120000_workshop_admission_benefits.sql`**. It is additive: new columns with defaults, two new tables, new functions, and three workshop functions replaced in place with unchanged signatures. Rollback is `rollback/20261109120000_workshop_admission_benefits_down.sql`, which restores those three functions verbatim. Check afterwards: the 19 protected checks are unchanged, and the cohort `paystack-webhook` checksum is unchanged.
4. **Configure workshop 01** (the row is `draft`; its price is already 350):
   ```sql
   update public.workshop_sessions
      set admission = 'invite', calendar_event_id = '<event id>', capacity = 25, reserved_graduate_seats = 5,
          foundations_discount_pct = 20, graduate_free = true, referral_commission_ghs = 50
    where slug = 'what-to-charge-for-automation' and status = 'draft';
   ```
   **This must happen before registration opens.** Without it, emails fall back to printing the joining link.
5. **Rehearsal (test mode, recommended).** Merge this branch into `webinar-e2e-test` and configure the test session the same way. Then:
   - Register once at the standard price, once with a Foundations certificate, and once as a graduate (with your own records), paying with Paystack test MoMo.
   - Add the accounts from `/admin/workshops/` to a **test** Calendar event.
   - Set the test session back to `draft`.
6. **Merge PR #61.** This publishes `/workshops` with registration still closed.
7. **Repoint the dispatcher** to production:
   `select cron.alter_job((select jobid from cron.job where jobname = 'workshop-dispatch'), command := replace((select command from cron.job where jobname = 'workshop-dispatch'), 'webinar-e2e-test.bulletproofautomations-training.pages.dev', 'training.bulletproofautomations.com'));`
8. **Live keys:**
   - Webinars business: set the **live** webhook URL (same function URL as test).
   - Supabase secret `WORKSHOP_PAYSTACK_SECRET_KEY` = the Webinars **live** key.
   - Cloudflare **Production** `WORKSHOP_PAYSTACK_SECRET_KEY` = the same key, and `WORKSHOP_PAID_CHECKOUT=on`. Redeploy.
   - Never put the live key in Preview.
9. **Open registration:**
   `update public.workshop_sessions set status = 'published' where slug = 'what-to-charge-for-automation';`
   From then on, work the invitation panel daily.
10. **Referral codes, separately.** Issue them from `/admin/workshops/` only when you decide to share them. Issuing a code publishes nothing.


Workshops 02 to 10 have no database row and no form. Scheduling one later means a session file with
real values, a matching row, and pointing its series entry at the session
(`content/workshops/README.md`).

Their dates are held in the owner's Google Calendar, which is the schedule of record. They are
deliberately **not** in this repository or on the coming-soon pages: each opens only when its fee,
places and terms are approved, and the 26 December and 2 January dates need marketing approval
before anyone advertises them. A calendar date never opens registration. Only the database row
does.

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

### 7. Publish a session

1. Add `content/workshops/<slug>.json` with real values only. The build refuses placeholders,
   TBC and past dates.
2. Add the matching `workshop_sessions` row with the same `slug`, `starts_at` and `price_ghs`,
   as `draft` until registration should open.
3. Merge. This publishes the page, the nav link and the sitemap entries. While the row is `draft`
   the page says registration isn't open yet and the API refuses bookings.

### 8. Go live (separate approval)

Set Production `WORKSHOP_PAYSTACK_SECRET_KEY` to the webinar **live** key, then `WORKSHOP_PAID_CHECKOUT=on`,
and redeploy.

## Rollback of the whole feature

1. Unset `WORKSHOP_PAID_CHECKOUT` and redeploy. No new money can be taken.
2. Set sessions to `draft` (or delete their files) and merge. The pages disappear.
3. Keep `workshop-paystack-webhook` deployed while any webinar payment or refund may still arrive.
   The training side never needs rolling back.
4. Export first, then run the rollback SQL only if the data is no longer needed:
   `20261109120000_workshop_admission_benefits_down.sql` first, then `20261103120000_workshops_down.sql`.

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
