# Webinars and workshops: deployment, verification and rollback

_Updated 9 November 2026, from a read-only inspection of the production database on that date.
Live checkout is off, and no workshop registration is open._

- Product contract: `docs/PRD-WEBINARS-WORKSHOPS.md` (PR #59).
- Design: `docs/workshops-design.md`.
- Non-regression record: `docs/workshops-shared-changes.md`. **Read it before any production step.**

**The production training webhook (v9) is not changed and is not redeployed at any step.**

## Where it stands (9 November 2026)

Checked read-only against the existing Supabase project, not taken from earlier notes.

| Piece | Production state |
|---|---|
| Release 1, `20261103120000_workshops.sql` | **Applied, and recorded in `supabase_migrations.schema_migrations`.** All 8 `workshop_*` tables and their functions exist. **Never apply it again.** Its rollback is for removing the whole feature only |
| Release 2, `20261109120000_workshop_admission_benefits.sql` | **Not applied.** No release 2 column, table or function exists. Until it is applied, every session reads as `link` at its own `price_ghs` |
| Webinar webhook `workshop-paystack-webhook` | **Deployed** with the Webinars business's **test** key only, and registered as that business's **test** webhook |
| Dispatcher | **Scheduled**: cron job `workshop-dispatch`, every minute, token in Vault. Points at the **preview** `webinar-e2e-test` until merge |
| Test session `test-webinar-checkout` | `draft`. 3 confirmed test registrations and 4 test-mode attempts (`BPA-WTEST-`). No live attempt exists anywhere |
| Workshop 01, `what-to-charge-for-automation` | `draft`, GHS 350, 25 places, joining details stored on the row (never in this repository, which is public), no registrations |
| Certificate records release 2 reads | PR #54's entitlement view exists: **2** active graduate entitlements and **10** valid Foundations certificates |
| Webinar and workshop refund terms | **Owner-approved 9 November 2026. Legal review NOT done.** Section 23 of the existing `refund-policy/index.html` (`#workshops`), version `2026-11-09` = `TERMS_VERSION`. On the development branch only: it publishes when this branch reaches `main`, which must wait for legal sign-off |

## Test and live never mix (release 2, part 3)

Every session is either **test** (`is_test = true`) or **live**. The database enforces the split itself,
so a mistake in a deployment's settings cannot cross it:

| Rule | Where it is enforced |
|---|---|
| A test-mode deployment (Pages holding a `sk_test_` key, such as Preview) can see, quote and register only on test sessions. Any other deployment, including production, sees only live sessions | `workshop_register` and `workshop_quote`, from the mode the Pages Function derives from its own key. The browser cannot set it |
| Test money is taken only on a test session, and live money only on a live session | `workshop_start_attempt` refuses with `mode_not_allowed` |
| So a rehearsal can never hold or use any of a live workshop's 25 general or 5 reserved places | Places are counted per session |
| A test registration's commission is never payable, and no payout can be recorded for one: not from the admin page, not through the function, and not by a direct insert with the service key | `workshop_commission_payable`, `workshop_admin_referral` (`test_registration`), and a trigger on `workshop_referral_payouts` |
| A registration counts as test if its session is test **or** any of its checkouts was in test mode | `workshop_is_test_registration` |
| Admin revenue, campaign results, commissions due and place counts leave test rows out, and show test sessions with a TEST SESSION label and their own separate places | `/admin/workshops/` |
| No two sessions can share a Google Calendar event, so a rehearsal can never point at a real workshop's guest list | Unique index on `calendar_event_id` |
| A session cannot switch between test and live once anyone has registered | Trigger on `workshop_sessions.is_test` |

When release 2 is applied, existing sessions are classified from their own payments:
`test-webinar-checkout` (test payments only) becomes a test session, and workshop 01 (no payments)
stays live. A session with both kinds of payment would stop the migration; the preflight checks there is none.

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

Part 2 of migration `20261109120000_workshop_admission_benefits.sql`. One database function,
`workshop_price`, computes every price. The page's quote and registration both use it, and the page sends back
the figure it showed, so a changed price is refused rather than charged.

| Registration | Customer pays | Referrer commission | Retained before fees |
|---|---:|---:|---:|
| Standard | GHS 350 | 0 | 350 |
| Standard with a graduate's referral | GHS 300 | GHS 50 | 250 |
| Valid Foundations certificate | GHS 280 | 0 | 280 |
| Foundations certificate and a referral | GHS 280 | GHS 50 | 230 |
| Eligible Intermediate graduate | Free, reserved place | 0 | 0 |

- **Discounts never stack.** The customer gets the larger one. A valid referral is still recorded, and still earns its commission, when the Foundations discount wins.
- **Certificate benefits need a one-time code**, emailed only to the address on the certificate, or to an address the admin authorised. The steps:
  1. The code expires in 10 minutes and allows 5 tries.
  2. A correct code gives a 30-minute, single-use token bound to that email and session.
  3. Registration spends the token in the same transaction.

  The page gives the same answer whether or not anything matched, and allows 3 codes an hour per certificate and per address. Each certificate can be redeemed once per session (cancelled and refunded registrations release it).
- **Eligibility** is read from the certificate register and PR #54's entitlement view, and re-checked when the token is spent and again when a graduate is invited:
  - **Foundations:** a valid, issued certificate.
  - **Graduate:** an active entitlement, a valid issued certificate, and training fees and every installment paid.
- **Recovery for a changed email:** "Authorise another email for a certificate" in `/admin/workshops/`. Verify the person yourself first. The authorisation covers one certificate, one session and 7 days, with the reason recorded. The holder then asks for their code at the new address.
- **Referral codes and links:** one per eligible graduate, issued from `/admin/workshops/`. You choose the code (4–16 letters and digits) or one is generated. A code is refused if it contains the certificate number.
  - A code is issued **prepared**: it works only on test sessions, so the link and typed entry can be rehearsed before registration opens. "Activate for live workshops" makes it valid on workshop 01; do that only when you give it to the graduate. "Suspend" makes it valid nowhere.
  - The link is `/workshops/<slug>?ref=CODE`, which fills in the code; a customer can also type it.
  - Unknown, suspended or expired codes are refused, as is a code whose graduate is no longer eligible. So is the referrer's own email, which reads as "invalid" so the owner of a code can't be looked up.
- **Places:** `capacity` is the 25 general places; graduates count only against `reserved_graduate_seats` (5). Both are checked while the session row is locked. When the general places are gone, the page stays open for a confirmed graduate only. The API reports yes/no, never a count. Reserved places are never released.
- **Commission** is derived, not stored as owed (`workshop_commission_payable`). It is payable only on a confirmed registration paid once, in full, with no refund, duplicate or mismatch, a valid referral, not voided and not complimentary.
  - Pay by MoMo yourself, then record the reference: once per registration.
  - A refund after payout shows "review"; there is no automatic clawback.
  - "Void" removes a fraudulent or mistaken sale's commission, with a reason.
  - A test registration's commission is never payable, and the database refuses to record a payout for one (see "Test and live never mix").
- **Admin reporting** shows the advertised price, discount and its kind, customer payment, commission and net retained separately, with totals, plus general and reserved places used.
- Verified read-only on 9 November 2026: the eligibility rules match exactly the **2** active graduate entitlements and **10** valid Foundations certificates.

## Release 2 deployment checklist

One pass, in this order. **Each numbered step needs the owner's approval.** Steps 1 to 4 change
nothing anyone can see: workshop 01 stays `draft`, live checkout stays off, and no referral code works
on a live workshop.

Run SQL in the Supabase SQL editor of the existing project. The three check files are read-only and
can be re-run at any time.

### 1. Preflight (read-only)

Run `supabase/checks/20261109120000_preflight.sql` and **save the output**.

- Every `ok_` value must be `true`. In particular: release 1 is recorded, release 2 is not, and no
  session has both test and live payments.
- `will_become_test_sessions` must be `["test-webinar-checkout"]` and `live_attempts` must be `0`.
- `active_graduate_entitlements` is expected to be `2` and `valid_foundations_certificates` `10`. A
  different number is not a blocker, but find out why before step 4.
- Keep `snapshot` and `release1_bodies`. Run this **immediately** before step 3: cohort activity
  changes `snapshot` from day to day.

**Stop if any `ok_` is false.** Do not reapply `20261103120000_workshops.sql` under any circumstances.

### 2. Back up

Take a backup in the dashboard, or at minimum export `workshop_sessions`,
`workshop_registrations`, `workshop_payment_attempts`, `workshop_payment_events` and
`workshop_notifications`.

### 3. Apply release 2, once

Paste `supabase/migrations/20261109120000_workshop_admission_benefits.sql` into the SQL editor
between `begin;` and the history insert below, then `commit;`, so it runs as one transaction and is
recorded once:

```sql
begin;
-- … the whole of 20261109120000_workshop_admission_benefits.sql …
insert into supabase_migrations.schema_migrations (version, name) values ('20261109120000', 'workshop_admission_benefits');
commit;
```

**Do not use `supabase db push`.** Several older files in `supabase/migrations/` carry different
version numbers from the ones recorded in production's history (for example, the repository's
`20261016175227_certificate_issuance_studio.sql` was recorded as `20261016180950`), so a push would
try to apply migrations that are already in place.

The file can safely be re-run (`if not exists`, `create or replace`). If it stops on "both test and
live payments", nothing was applied.

### 4. Postflight (read-only)

Run `supabase/checks/20261109120000_postflight.sql`.

- Every `ok_` must be `true`.
- `sessions` must be `[["test-webinar-checkout", true], ["what-to-charge-for-automation", false]]`.
- `referrers` must be `0`.
- **`snapshot` must equal step 1's `snapshot` exactly.** It covers the training ledger, enrollments,
  installments, credentials, PR #54's entitlements, every existing workshop registration, payment and
  notification, and every non-workshop function.
- Also confirm the cohort `paystack-webhook` checksum is unchanged.

### Rollback, if anything in step 4 is wrong

1. **Export `workshop_referral_payouts` and `workshop_benefit_email_grants` first**, if anything has
   been written to them. They record commissions paid and recovery decisions.
2. Run `supabase/migrations/rollback/20261109120000_workshop_admission_benefits_down.sql`, then delete
   its history row:
   ```sql
   delete from supabase_migrations.schema_migrations where version = '20261109120000';
   ```
3. Run `supabase/checks/20261109120000_rollback_check.sql`.
   - Every `ok_` must be `true`.
   - `release1_bodies` must equal step 1's.
   - `snapshot` must equal step 1's.

Release 1 is untouched by this rollback. Rehearsed end to end on a production-shaped database: see
`tests/workshops-migration.test.ts`, "release 2 deployment checks".

### 5. Rehearsal (test mode, owner)

See "Release 2 rehearsal" below. It needs release 2 applied, and touches only test rows on a test session.

### 6. Configure workshop 01

The row is still `draft`, at GHS 350 and 25 places. Paste the real event ID here, never into this
repository:

```sql
update public.workshop_sessions
   set admission = 'invite', calendar_event_id = '<workshop 01 event id>', reserved_graduate_seats = 5,
       foundations_discount_pct = 20, graduate_free = true, referral_discount_ghs = 50, referral_commission_ghs = 50
 where slug = 'what-to-charge-for-automation' and status = 'draft' and not is_test;
```

**This must happen before registration opens.** Without it, emails fall back to printing the joining link.

### 7. Google Meet checks (owner, on workshop 01's event)

Run the access test above. The rehearsal (step 5) can already have run it on the rehearsal event.

### 8. Refund policy

**Owner approval: done (9 November 2026).** The terms are section 23 of the existing
`refund-policy/index.html`; paid forms link to `/refund-policy#workshops`, and every registration records
`TERMS_VERSION` `2026-11-09`, the section's version line.

**Legal review: not done.** It must be completed before this branch is merged to `main`, because merging
publishes the section. Points for the reviewer: the Ghana electronic-transactions cancellation
provisions (Act 772, section 49, and its exceptions for services already begun), Paystack's refund
rules from October 2026, and the late-registration full-refund clause (see PR #61 notes on its
financial exposure). If the reviewer changes the wording, update section 23's version line and
`TERMS_VERSION` in the same commit.

### 9. Merge PR #61

This publishes `/workshops` with registration still closed.

### 10. Repoint the dispatcher to production

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'workshop-dispatch'),
  command := replace((select command from cron.job where jobname = 'workshop-dispatch'),
    'webinar-e2e-test.bulletproofautomations-training.pages.dev', 'training.bulletproofautomations.com'));
```

### 11. Live keys

- Webinars business: set the **live** webhook URL (the same function URL as test).
- Supabase secret `WORKSHOP_PAYSTACK_SECRET_KEY` = the Webinars **live** key.
- Cloudflare **Production** `WORKSHOP_PAYSTACK_SECRET_KEY` = the same key, and `WORKSHOP_PAID_CHECKOUT=on`. Redeploy.
- **Never put the live key in Preview.** Preview keeps the test key, so it keeps seeing only test sessions.

### 12. Open registration

```sql
update public.workshop_sessions set status = 'published' where slug = 'what-to-charge-for-automation' and not is_test;
```

From then on, work the invitation panel daily.

### 13. Referral codes: activate when you share them

Codes are issued **prepared** and work only on test sessions. When you are ready to give a graduate their code, click "Activate for live workshops" in `/admin/workshops/`. Until then, nothing about the code is public and it cannot be used on workshop 01.

## Release 2 rehearsal (test mode, on the existing project)

Exercises all five prices in a browser, with real verification emails, Paystack **test**
transactions, the confirmation dispatcher, the admin reports and the Calendar invitation status. It
uses the existing Supabase project and the existing Webinars test configuration: Preview's test key,
the test webhook and the dispatcher, which already points at the preview. **No other Supabase project is created.**

A local dry run of exactly this journey already passes, with stand-ins for Paystack and the mail
API: `tests/local-stack/journey-release2.js`, 33 checks.

**What keeps it away from real people:**

- **Its own session.** The rehearsal session is a test session, so Preview can book it and production cannot. None of workshop 01's places are touched.
- **Certificate codes go to your addresses only.**
  - The Foundations price uses your own certificate (`BPA-FND-2026-4GGY96`, registered to `johnathan@bulletproofautomations.com`).
  - The graduate place and the second Foundations registration use admin email grants. A grant is scoped to the rehearsal session and sends the code to an address you choose.
  - No graduate receives anything.
- **Referral codes stay prepared.** The referral code you issue stays prepared throughout, so it never works on workshop 01.
- **Invitations go to a separate event.** They are added to a separate test Calendar event, never to workshop 01's.

### Before you start

- **Approvals:** release 2 is applied (steps 1 to 4), and you have approved creating the rehearsal row (R1).
- **Five inboxes you control**, all different, called A to E below. A must be `johnathan@bulletproofautomations.com`, because your Foundations certificate is registered to it. The others can be any addresses you read, such as `info@`. Do not use a graduate's or customer's address.
- **Two Google accounts you control:** one to invite and one left uninvited.
- **A new Google Calendar event** on the owner's calendar, titled "TEST rehearsal – not a real workshop":
  - Meet access restricted to invited guests.
  - Guests cannot see the guest list.
  - Nobody invited yet.
  - Note its event ID.

### R1. Create the rehearsal session (SQL, approval)

```sql
insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, time_zone, format, price_ghs,
  capacity, status, is_test, admission, calendar_event_id, reserved_graduate_seats, foundations_discount_pct,
  graduate_free, referral_discount_ghs, referral_commission_ghs)
values ('rehearsal-what-to-charge', 'workshop', 'TEST SESSION: Get Paid for Automation rehearsal',
  '2026-12-12T11:30:00Z', 180, 'Africa/Accra', 'live online', 350, 25, 'published', true, 'invite',
  '<rehearsal event id>', 5, 20, true, 50, 50)
on conflict (slug) do nothing;
```

It mirrors workshop 01's settings and date, so the emails show the real Ghana and Lagos times. It is
`published` because only a test deployment can see it.

### R2. Put the page on the preview only

On branch `webinar-e2e-test`, which is never merged:

1. Merge this PR's branch in.
2. Copy `docs/workshops-rehearsal/rehearsal-what-to-charge.json` to `content/workshops/`.
3. Push.

Then check:

- `https://webinar-e2e-test.bulletproofautomations-training.pages.dev/api/workshops/session?slug=rehearsal-what-to-charge` answers `"status":"open"`.
- The same URL with `slug=what-to-charge-for-automation` answers **404**. Workshop 01 is a draft, so this is 404 regardless. Once it is published (step 12), Preview must still answer 404 for it, because Preview cannot see a live session.

### R3. Prepare the codes and grants (preview's `/admin/workshops/`)

1. **Issue a referral code** for one graduate certificate (graduate G1), with the code you intend to give them later. It shows **Prepared: rehearsal only**. Do not activate it.
2. **Authorise another email** for the *other* graduate certificate (G2): session `rehearsal-what-to-charge`, inbox E, reason "rehearsal".
3. **Authorise another email** for your Foundations certificate `BPA-FND-2026-4GGY96`: session `rehearsal-what-to-charge`, inbox D, reason "rehearsal".

### R4. The five paths

Open `/workshops/rehearsal-what-to-charge/?paystack=test` on the preview. For a referral path, add `&ref=<code>` to that address, or type the code into the field. Pay with Paystack's test mobile money on one path and a test card on another.

| # | Inbox | Certificate | Referral | Page and Paystack must show | Then |
|---|---|---|---|---|---|
| 1 | B | none | none | You pay GHS 350; Paystack GHS 350 | |
| 2 | C | none | the link `&ref=<code>` | Advertised GHS 350, less GHS 50 referral discount, you pay GHS 300; Paystack GHS 300 | Repeat the price check by typing the code in lower case (do not submit) |
| 3 | A | `BPA-FND-2026-4GGY96`, code from inbox A | none | Less GHS 70, Foundations certificate price, you pay GHS 280; Paystack GHS 280 | In admin, "Request refund", then refund it in the Paystack **test** dashboard. Wait for "Refunded". This releases the certificate for path 4 and rehearses a refund |
| 4 | D | `BPA-FND-2026-4GGY96`, code from inbox D | typed | You pay GHS 280, and "Discounts don't combine; your referral is still recorded"; Paystack GHS 280, never 230 | |
| 5 | E | G2's certificate, code from inbox E | none | Complimentary graduate place, button "Register for free"; no Paystack page | |

For every path, check:

- **The verification email** (paths 3 to 5) arrives within two minutes, at the address typed. G2 receives nothing.
- **The confirmation email** arrives within two minutes of payment, by the dispatcher. It has no Meet link and no calendar file, explains the Google invitation and names the account. It shows "11:30 AM–2:30 PM (GMT)" and "12:30 PM–3:30 PM (WAT)", and names any discount.
- **The confirmation page** says the place is confirmed.

### R5. Admin reports (preview's `/admin/workshops/`)

- **The rehearsal session:** shows **TEST SESSION**, with "general 3 of 25, reserved graduate 1 of 5" after the path 3 refund.
- **Workshop 01:** 0 places used.
- **Referrals:**
  - Paths 2 and 4 show advertised, discount, customer paid and "Test registration: never payable".
  - **Commissions due is 0**, and no "Record payout" button appears.
- **Results by campaign:** "No live registrations yet".
- **Invitations:** four to add (paths 1, 2, 4 and 5), under the warning "Rehearsal only. Add these addresses to the rehearsal Calendar event".

### R6. Invitations

1. Add the four Google accounts to the **rehearsal** event and choose Send. Then click "Added in Calendar" for each.
2. Run the access test (above) on the rehearsal event: invited in, uninvited and signed-out refused, removed refused, and guests can't see each other.
3. Run the 3-person call past 60 minutes here too, if not yet done.
4. Refund one path in the Paystack test dashboard. It must move to "Remove from the event".

### R7. Tidy up

- Set the rehearsal session to `completed`.
- Revoke the two email grants.
- Delete the rehearsal Calendar event.
- Leave the referral code **prepared**.

The rehearsal rows stay in the database, permanently marked test and excluded from every figure.

## Release 1 (applied): reference only

These were done once, with the owner's approval. **Do not repeat them.** They are kept because the
settings they describe still apply.

### Paystack: the webinar business (owner, dashboard)

Switch the dashboard to **Bulletproof Automations Webinars** (check the business name and ID at
the top left before copying anything), then:

1. **Settings → API Keys & Webhooks:** confirm the test and live secret keys differ from the
   training business's keys. The code refuses equal keys, but check by eye too.
2. **Settings → Preferences → Payment channels:** confirm Mobile Money (MTN, Telecel, AirtelTigo)
   and Card are enabled in both test and live.
3. **Webhook URLs**: test and live both point at
   `https://<project-ref>.supabase.co/functions/v1/workshop-paystack-webhook`. **Do not change the
   training business's webhook URL.**

### The webinar webhook (deployed)

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

The URL is registered as the webinar business's test webhook.

**Rollback:** unregister the URL in the webinar business and delete the function. The training
webhook is unaffected either way.

### Cloudflare Pages variables (Production and Preview separately, then redeploy)

| Variable | Purpose |
|---|---|
| `WORKSHOP_PAYSTACK_SECRET_KEY` | Webinar business secret key. `sk_test_…` for the rehearsal; `sk_live_…` only at launch. A key equal to `PAYSTACK_SECRET_KEY` is refused |
| `WORKSHOP_PAID_CHECKOUT` | `on` opens **live** webinar checkout. **Last step, separately approved** |
| `HOSTINGER_MAIL_API_TOKEN` | Already set for installment emails; confirmation emails use it too |
| `WORKSHOP_SUPPORT_WHATSAPP` | Optional, only once verified (international format). Unset: no phone number is published |
| `WORKSHOP_REVIEW_RESPONSE_DAYS` | Optional. Unset promises no timeframe |
| `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_TEST_EVENT_CODE` | Optional ad measurement |
| `WORKSHOP_PAYSTACK_API_BASE`, `MAIL_API_BASE`, `WORKSHOP_CONTENT_DIR` | **Local testing only.** Never set them on Cloudflare (the code ignores the first two outside test or localhost, and the last on Cloudflare) |

### Dispatcher (pg_cron + pg_net, scheduled)

```sql
insert into public.workshop_dispatch_config (secret_hash) values (encode(extensions.digest('<secret>', 'sha256'), 'hex'));
```

Then create the schedule shown at the end of the migration (check `cron.job` first).

## Publish a later session (workshops 02 to 10)

1. Add `content/workshops/<slug>.json` with real values only. The build refuses placeholders,
   TBC and past dates.
2. Add the matching `workshop_sessions` row with the same `slug`, `starts_at` and `price_ghs`,
   as `draft` until registration should open.
3. Merge. This publishes the page, the nav link and the sitemap entries. While the row is `draft`
   the page says registration isn't open yet and the API refuses bookings.

Workshops 02 to 10 have no database row and no form. Scheduling one later means a session file with
real values, a matching row, and pointing its series entry at the session
(`content/workshops/README.md`).

Their dates are held in the owner's Google Calendar, which is the schedule of record. They are
deliberately **not** in this repository or on the coming-soon pages: each opens only when its fee,
places and terms are approved, and the 26 December and 2 January dates need marketing approval
before anyone advertises them. A calendar date never opens registration. Only the database row
does.

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
