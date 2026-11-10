# Webinars and workshops: deployment, verification and rollback

_Updated 9 November 2026, from a read-only inspection of the production database on that date.
Live checkout is off, and no workshop registration is open._

- Direction: `docs/WEBINAR-REUSE-FIRST-RESET.md` (on main). It supersedes the 2 November PRD (PR #59, closed).
- Design: `docs/workshops-design.md`.
- Non-regression record: `docs/workshops-shared-changes.md`. **Read it before any production step.**

**The production training webhook (v9) is not changed and is not redeployed at any step.**

## Where it stands (9 November 2026)

Checked read-only against the existing Supabase project, not taken from earlier notes.

| Piece | Production state |
|---|---|
| Release 1, `20261103120000_workshops.sql` | **Applied, and recorded in `supabase_migrations.schema_migrations`.** All 8 `workshop_*` tables and their functions exist. **Never apply it again.** Its rollback is for removing the whole feature only |
| Release 2, `20261109120000_workshop_admission_benefits.sql` | **Applied**, per both independent Codex read-only inspections of 9 November (this table previously said otherwise, which was wrong). Re-check with the queries below |
| Webinar webhook `workshop-paystack-webhook` | **Deployed** with the Webinars business's **test** key only, and registered as that business's **test** webhook |
| Release 3, `20261110120000_workshop_calendar_sync.sql` | **Not applied** as of both 9 November inspections |
| Release 4, `20261111120000_workshop_waitlist.sql` | **Not applied** as of both 9 November inspections |
| Release 5, `20261112120000_workshop_audit_corrections.sql` | **Not applied.** Written after the inspection, for the Codex audit findings. Requires release 4 |
| Dispatcher | **Scheduled**: cron job `workshop-dispatch`. At the Codex inspection it called the **preview** `webinar-e2e-test-r2`, not `webinar-e2e-test`. Read the actual target before step 10; never assume it |

**This table is a record of one inspection, not a live reading.** Before any production step, re-read the
state with the read-only queries below and correct the table. Do not act on it if they disagree.

```sql
-- Which workshop releases are recorded (1 is expected; 2 to 5 are not, until applied).
select version, name from supabase_migrations.schema_migrations where version >= '20261103120000' order by version;
-- The dispatcher: schedule, target and how it authenticates. The command must read the
-- secret from Vault and must never contain it; if it does, rotate the secret.
select jobname, schedule, active, command from cron.job where jobname = 'workshop-dispatch';
select name from vault.secrets where name = 'workshop_dispatch_secret';
```
| Test session `test-webinar-checkout` | `draft`. 3 confirmed test registrations and 4 test-mode attempts (`BPA-WTEST-`). No live attempt exists anywhere |
| Workshop 01, `what-to-charge-for-automation` | `draft`, GHS 350, 25 places, joining details stored on the row (never in this repository, which is public), no registrations |
| Certificate records release 2 reads | PR #54's entitlement view exists: **2** active graduate entitlements and **10** valid Foundations certificates |
| Webinar and workshop refund terms | **Owner Approved, 9 November 2026** (non-refundable; transfers 72 hours or more ahead). No external legal review: not a launch gate, by owner decision. Section 23 of the existing `refund-policy/index.html` (`#workshops`), version `2026-11-09` = `TERMS_VERSION`. Publishes when the webinar release is merged |

## Operational checks before launch (Codex audit, 9 November 2026)

What the repository can prove is proved by tests. What lives in a dashboard or in the production
database has **not** been checked: nothing here was read from production for the audit corrections.
Each item below needs the owner, and the queries are read-only.

| Area | Proved in the repository | Still to verify or set up in production |
|---|---|---|
| **Abuse protection on public endpoints** | Honeypot on registration; amounts, prices and places decided server-side; certificate codes single-use; status needs a token (and, from release 5, re-registering an existing email needs that browser's token or its offer link) | No Turnstile on `/api/workshops/register`, `/waitlist`, `/benefit`, `/quote` or `/status`. `/benefit` and waitlist joining **send email**, so they can be used to mail-bomb an address. Confirm the Cloudflare rate-limiting rule recorded in `docs/build-status.md` (on `/api/*`, dashboard state, not in version control) exists, covers `/api/workshops/*`, and is tight enough for `/benefit` and `/waitlist`. Bot Fight Mode likewise |
| **Google Calendar** | Only the account a registration added is ever removed; overlapping runs are serialised per registration (release 5); test and live never mix | Which Google account the refresh token belongs to, and that its scope is calendar events only. **Guest privacy is a manual setting on each event**: "guests can see the guest list" and "guests can invite others" must be off, and Meet access restricted to invited guests. The code does not set or check them. Run the access test above on every new event |
| **Hostinger email** | Failed sends retry 5 times; from release 5 the admin can retry an exhausted email from its row ("Retry email"), as already for waitlist emails; a message no longer true is never sent | The code knows only that Hostinger **accepted** a message, not that it was delivered. Bounces and spam-foldering are invisible here: check the mailbox's bounce reports after the rehearsal |
| **Supabase RLS and privileged functions** | Every new or changed function in release 5 is executable by `service_role` only (`tests/workshops-migration.test.ts`); tables keep RLS with the admin read policy | Run the query below on production. It must return no rows |
| **Migrations and dispatcher** | Release 5 is up, re-applied and rolled back exactly in tests; its races run on a real PostgreSQL server in CI | The state table at the top is from one inspection. Re-run its queries; follow "Dispatcher" below for the schedule (every minute, secret in Vault), not the comment in release 1 |

```sql
-- Privileged workshop functions anyone but service_role can call. Expected: no rows.
select p.proname, pg_get_function_identity_arguments(p.oid) args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'workshop%' and p.prosecdef
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
-- Workshop tables without row level security. Expected: no rows.
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'workshop%' and not c.relrowsecurity;
```

**Unresolved checkouts (human review).** The dispatcher keeps asking Paystack about every unresolved
checkout, in rotation, with no age limit (Codex audit 2, B), so a payment is never dropped for being
old. Anything still unresolved a day after it started has almost certainly been abandoned, but check
it in the Paystack dashboard before treating it so:

```sql
select a.reference, a.status, a.created_at, a.last_verify_at, r.email_normalized, r.status as registration
  from public.workshop_payment_attempts a join public.workshop_registrations r on r.id = a.registration_id
 where a.status in ('initialized', 'init_failed') and a.created_at < now() - interval '24 hours'
 order by a.created_at;
```

**Dispatcher health.** Each run answers `{"ok": …, "report": {…, "health": [...]}}`, stored by pg_net in
`net._http_response`. `health` is empty when nothing needs a person; otherwise it lists:
`emails_need_retry` (use "Retry email" on the row), `waitlist_email` or `waitlist_not_run`,
`calendar_sync`, `calendar_not_configured` (an upcoming invitation-only session and no Google
connection) and `health_check_failed`.

```sql
select created, status_code, content::jsonb->'report'->'health' as health
  from net._http_response order by created desc limit 10;
```

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

**Admitting people: automatic (release 3, `20261110120000_workshop_calendar_sync.sql`).** The existing
dispatcher (cron `workshop-dispatch`, every minute; also straight after a free registration or an
admin retry) runs `functions/api/_calendar.js`:

| When | What happens on the session's Google Calendar event |
|---|---|
| A registration is confirmed and paid, or is a complimentary graduate place still matching an active entitlement | Its Google account is added, and Google emails the invitation (`sendUpdates=all`) |
| Refund requested, refunded or cancelled | The account it added is removed, and Google emails the cancellation |
| An approved change of Google account (admin "Set Google account") | Old account removed and new one added, in one update |
| Duplicate payment webhook, a second run, an account already on the event | Nothing is sent; the record is brought in step |

**What it never does:**
- It never touches anyone else on the event (the host, a co-host).
- It never invites an unpaid, unconfirmed or ineligible registration.
- It never invites the same account twice in a session.
- Test and live never mix: a test-mode deployment syncs test sessions only, and any other deployment syncs live sessions only.

**Exception queue.** Temporary Google errors (rate limits, 5xx, an etag race) are retried on each run, up
to 5 times. A missing event, an address Google refuses, or a lapsed graduate place stops at once. All of
them appear first in the "Google Calendar invitations" panel under **Needs attention**, with the reason
and a **Retry now** button. The manual buttons stay as a fallback and still record a change made by hand.

**Event settings, once per event:** guests cannot see the guest list and cannot invite others, and Meet
access is restricted to invited guests.

**Joining instructions stay private.** `join_instructions` and `calendar_event_id` live only on the
session row: `anon` and `authenticated` have no grant, and no public endpoint selects them. An
invitation-only session never prints `join_instructions`. The build fails on a meeting link or a
join field in any content file, and CI fails if one reaches `dist/`.

### Connecting Google Calendar (owner, once)

Reuses the Google OAuth client Bulletproof Scheduling already uses, so no new Google Cloud project is
needed. It is a **separate** authorisation for this site, limited to calendar events. Scheduling's own
stored connection is never copied.

1. In Google Cloud console, open the OAuth client Scheduling uses.
   - Add `https://developers.google.com/oauthplayground` as an authorised redirect URI.
   - Create a new client secret for this site.
   - Check the consent screen's publishing status is **In production**. In "Testing", Google expires the token after 7 days and invitations stop.
2. In Google's OAuth Playground (settings: "Use your own OAuth credentials"):
   - Authorise scope `https://www.googleapis.com/auth/calendar.events`, signed in to the Google account that **owns the workshop events**.
   - Exchange the code for tokens.
3. In Cloudflare Pages, set these as **encrypted** variables, Production and Preview separately, then redeploy:
   - `GOOGLE_CALENDAR_CLIENT_ID`
   - `GOOGLE_CALENDAR_CLIENT_SECRET`
   - `GOOGLE_CALENDAR_REFRESH_TOKEN`
   - Optional: `GOOGLE_CALENDAR_ID` (default `primary`)

   Never paste them anywhere else.
4. Test on the rehearsal session (`rehearsal-what-to-charge`, test-mode Preview) with its own test event: a test payment should appear as a guest within a minute, and a refund should remove it.

Until the three values are set, nothing calls Google and the manual panel works as before. **Rollback:**
remove `GOOGLE_CALENDAR_REFRESH_TOKEN` and redeploy, then (optionally) run
`rollback/20261110120000_workshop_calendar_sync_down.sql`.

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

## Registration cutoff: seven days (release 3)

Registration closes **168 hours before each session starts**, at every price, including complimentary
graduate places. For workshop 01 (Saturday 12 December 2026, 11:30 AM Accra) that is **Saturday 5 December
2026, 11:30 AM Accra**.

- **Enforcement.** The database refuses after the cutoff, through the one function that already decides
  "open" (`workshop_session_open`). That covers registration, new checkouts, certificate codes and
  waitlist joins. The page shows the closing date and time and switches to "Registration closed".
- **Defaults and changes.** It is derived from `starts_at`, so every future session has it by default
  and a rescheduled session's cutoff moves with it. Existing registrations are unaffected by a
  reschedule; the refund terms (section 23) give those people the choice.
- **Late payments.** A checkout started before the cutoff and paid after it is confirmed, through
  the webhook or the dispatcher's reconciliation. Confirmed registrations, invitations and emails
  carry on as normal after the cutoff.
- **Not the same as statutory rights.** It does not shorten any statutory cancellation right. See
  step 8.

## Waitlist (release 4)

When a session sells out while registration is open, the page shows **"Sold out — join the
waitlist"**. The same form adds the person to a free waitlist: no payment and no Paystack. A verified
Intermediate graduate (confirmed by the emailed code) joins the queue for the reserved places; everyone
else joins the queue for open places. They get an email with their position in the queue, and nothing
about anyone else.

The existing per-minute dispatcher (`workshop_waitlist_advance`, under each session's lock) does the rest:

| When | What happens |
|---|---|
| A place opens (refund, cancellation, expired checkout hold, a capacity increase) | It is offered to the earliest person waiting for that kind of place: by time of joining, then id. The place is held for them. They get an email with a single-use link that fills in their details; they register and pay with the normal form, prices, discounts and Paystack checkout |
| A place opens but people are waiting | Newcomers cannot take it: the session shows as sold out until the queue is served |
| An offer is open | It expires at the earlier of 24 hours and the registration cutoff. A reminder goes 6 hours before expiry, for offers longer than 12 hours. A failed payment can be retried within the window |
| An offer expires or is declined (link in the email) | The place goes to the next person at once (declining) or at the next minute (expiry). The person is told it was released |
| The offered person has registered in the meantime, or their graduate entitlement has lapsed | They are skipped, with the reason recorded, and the queue order is otherwise unchanged |
| Less than 2 hours before the cutoff | No new offer is made; one could not be used in time |
| The cutoff | Open offers end, people still waiting are closed out and told, and joining is refused. Confirmed registrations and the full history remain |

**Guarantees:**
- An offer holds its place in the same count that registrations and checkout holds use, under the same lock, so nothing can oversell (tested with racing registrations and dispatcher runs).
- Nobody is charged by an offer: payment always starts from the person's own registration.
- **Checkout is rechecked atomically before Paystack is called** (`workshop_start_attempt`, under the session lock). A checkout can start only in three cases:
  - for a live offer;
  - for a registration whose own checkout hold is still running;
  - when a place is free and nobody is waiting.

  An expired offer or an old unpaid registration can never jump the queue.
- **Payment in flight, bounded.** A checkout started before an offer lapses keeps the offer open until it resolves or its 30-minute hold (`hold_minutes`) ends, so a slightly late webhook still converts the place. A payment verified after that is confirmed only if a place is free **and nobody is waiting**, a rule in the payment confirmation itself (`workshop_apply_charge`), so it holds even before the dispatcher has offered a freed place. Otherwise it is held for review (`payment_received_review`, reason `capacity`). It appears under "Needs resolution" for admit or refund: it never oversells, and the money is never lost. Money held for review counts as occupying a place until you resolve it, so nothing more is offered meanwhile.
- Reserved graduate places are offered only to verified graduates, and only used with the graduate certificate check. A reserved place is released to open-place waiters only if the admin changes the session's `capacity` / `reserved_graduate_seats`.
- Waitlisted people get no meeting access: the automatic invitation runs only after the registration is confirmed.

**Admin** (`/admin/workshops/`, "Places and waitlists"):
- The panel shows capacity and places left, reserved graduate places, the queue in order, open offers with their expiry, and counts of every outcome.
- The only actions are exceptions: **Remove** (a reason is required and recorded) and **Retry email**.
- Every row keeps an audit trail of joins, offers, emails, expiries, conversions and admin actions.

## Releases 3 and 4: deployment

Apply after release 2, in order, each as one transaction recorded in the history, with the same backup
and snapshot discipline as steps 1 to 4 below:

1. `20261110120000_workshop_calendar_sync.sql`: automatic invitations and the seven-day cutoff.
   Rollback: `rollback/20261110120000_workshop_calendar_sync_down.sql`, which restores
   `workshop_session_open` verbatim.
2. `20261111120000_workshop_waitlist.sql`: the waitlist. Rollback:
   `rollback/20261111120000_workshop_waitlist_down.sql`. It restores release 2's
   `workshop_seats_in_use`, `workshop_graduate_seats_in_use` and `workshop_register` verbatim. Export
   `workshop_waitlist` first.

Both are tested up, re-applied and rolled back in `tests/workshops-migration.test.ts`. Neither touches a
payment, enrollment, cohort or credential object.

3. `20261112120000_workshop_audit_corrections.sql`: the corrections from the Codex audit of 9 November
   (duplicate and early refunds, checkout holds, waitlist email and Calendar overlap, status-token
   disclosure, email retry). Apply after release 4, the same way. Rollback:
   `rollback/20261112120000_workshop_audit_corrections_down.sql`, which restores every function it
   replaces verbatim and drops its four columns (settle in-flight work first: see "Rollback of the whole
   feature", step 4). Tested up, re-applied and rolled back in
   `tests/workshops-migration.test.ts`, and its races on a real PostgreSQL server in
   `tests/workshops-concurrency.test.ts`. It touches no payment, enrollment, cohort or credential object.

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

### 8. Refund policy: done, no launch step

**Status: Owner Approved, 9 November 2026, by the business owner as final approval authority.** No
external legal review was carried out, and none is a launch gate (owner decision, 9 November 2026). Do
not describe the policy as independently reviewed. It publishes as section 23 of `/refund-policy` when the
webinar release is merged.

- **Where:** section 23 of the existing `refund-policy/index.html`.
  - Paid registrations are non-refundable except as stated or as the law requires.
  - A one-time transfer within 12 months is available when cancelling 72 hours or more ahead.
  - Within 72 hours, and for no-shows, there is no voluntary refund or transfer.
  - If we cancel or materially reschedule: a refund or another session.
  - Duplicate payments and registrations we cannot fulfil are refunded.
  - Discounts and complimentary places have no cash value.
- **Acceptance:** paid forms link to `/refund-policy#workshops` and require an explicit, ticked acceptance that names the non-refundable term. The server refuses a registration without it. Every registration records the accepted `terms_version` (`2026-11-09`, the section's version line) and, in `created_at`, the time of acceptance.
- **Sections 1 to 22 (cohort and certification terms) are byte-identical to `main`:** `tests/baseline/compare-site.sh` removes section 23 and compares the rest.

**Statutory rights are preserved by the wording, not by assumption:**
- The section does not limit rights that cannot be waived, and names Ghana's Electronic Transactions Act, 2008 (Act 772).
- Where the law gives a period to cancel, it states that the period runs from the purchase, not from the event.
- It does not rely on any exception for services already begun, and does not treat ticking the box at checkout as waiving a statutory right.
- It claims no deduction from a statutory refund.

**If the wording ever changes,** update section 23's version line and `TERMS_VERSION` in the same
commit; a build test fails if they differ.

### 9. Merge PR #61

This publishes `/workshops` with registration still closed.

### 10. Repoint the dispatcher to production

The job's target is read from the job, not from this document. An earlier version of this step replaced
a fixed preview host, while the job actually called a different preview (`webinar-e2e-test-r2`), so it
would have changed nothing and left live work running against the rehearsal (Codex audit 2, G).

```sql
-- 10a. Read-only: what does the job call now?
select jobid, schedule, active, substring(command from 'https://[^/'']+') as target
  from cron.job where jobname = 'workshop-dispatch';

-- 10b. Point it at production, whichever preview it calls now.
select cron.alter_job((select jobid from cron.job where jobname = 'workshop-dispatch'),
  command := regexp_replace((select command from cron.job where jobname = 'workshop-dispatch'),
    'https://[a-z0-9-]+\.bulletproofautomations-training\.pages\.dev', 'https://training.bulletproofautomations.com', 'g'));

-- 10c. Assert. Raises an error, rather than passing quietly, unless the job now calls production only.
do $$
declare c text := (select command from cron.job where jobname = 'workshop-dispatch');
begin
  if c is null then raise exception 'no workshop-dispatch job'; end if;
  if c like '%pages.dev%' or c not like '%https://training.bulletproofautomations.com/api/workshops/dispatch%' then
    raise exception 'workshop-dispatch does not call production: %', substring(c from 'https://[^/'']+');
  end if;
end $$;
```

Then confirm a `200` from production in `net._http_response` within two minutes (Dispatcher, below).

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

### Dispatcher (pg_cron + pg_net, every minute, secret in Vault)

**Do not use the schedule in the comment at the end of release 1.** It runs every five minutes and
writes the secret into `cron.job`, where anyone who can read that table can read it. Release 1 is
applied history and is not edited, so the correct steps are here. Every step needs the owner's approval.

It runs **every minute**: waitlist offers, their expiry and the Calendar sync are timed on that basis.
Overlapping runs are safe from release 5 on: each one claims the emails, waitlist rows and Calendar
registrations it works on.

Check `cron.job` first (the query above). If `workshop-dispatch` already exists, change it with
`cron.alter_job` rather than scheduling a second job.

```sql
-- 1. The secret, once, in Vault. Generate a long random value; it is never written anywhere else.
select vault.create_secret('<secret>', 'workshop_dispatch_secret');

-- 2. Its SHA-256, which /api/workshops/dispatch compares against. Read from Vault, not pasted again.
insert into public.workshop_dispatch_config (secret_hash)
select encode(extensions.digest(decrypted_secret, 'sha256'), 'hex') from vault.decrypted_secrets where name = 'workshop_dispatch_secret'
on conflict (id) do update set secret_hash = excluded.secret_hash;

-- 3. The schedule. <host> is the preview host during a rehearsal, and
--    training.bulletproofautomations.com only after the merge (step 10 below).
select cron.schedule('workshop-dispatch', '* * * * *', $cron$
  select net.http_post(
    url := 'https://<host>/api/workshops/dispatch',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-workshop-dispatch', (select decrypted_secret from vault.decrypted_secrets where name = 'workshop_dispatch_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
$cron$);
```

Verify: `select status_code, timed_out from net._http_response order by created desc limit 5` shows
`200` within a minute or two. `403` means the hash and the Vault secret differ. pg_net's default
timeout is 5 seconds, which a run that reconciles several checkouts can exceed; hence the 30 seconds.

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
4. **Settle before any destructive step.** Rolling back release 5 drops `hold_until`,
   `mail_claimed_at`, `calendar_claimed_at` and `calendar_managed_emails`: in-flight checkout
   deadlines, claims and the record of which Google accounts this system added. Before it:
   - pause the dispatcher: `select cron.alter_job((select jobid from cron.job where jobname = 'workshop-dispatch'), active := false);`
   - wait until no checkout is open:
     `select count(*) from public.workshop_payment_attempts where status in ('initialized', 'init_failed') and coalesce(hold_until, created_at + interval '30 minutes') > now();`
     is `0`, and resolve every row of the "Unresolved checkouts" query (Operational checks);
   - remove from each Calendar event every account in `calendar_managed_emails` that should not be
     there, or export that column, because after the rollback nothing records it.
5. Export the `workshop_*` tables, then run the rollback SQL only if the data is no longer needed,
   **newest first, one release at a time, skipping any release that was never applied**
   (check `supabase_migrations.schema_migrations`):
   1. `20261112120000_workshop_audit_corrections_down.sql` (release 5)
   2. `20261111120000_workshop_waitlist_down.sql` (release 4)
   3. `20261110120000_workshop_calendar_sync_down.sql` (release 3)
   4. `20261109120000_workshop_admission_benefits_down.sql` (release 2)
   5. `20261103120000_workshops_down.sql` (release 1, the whole feature)

   To undo only the latest release, stop after its step. Unpause the dispatcher only if release 1 is
   still in place.

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
