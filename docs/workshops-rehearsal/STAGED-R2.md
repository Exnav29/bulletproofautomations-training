# Release 2 controlled rehearsal staging (9 November 2026)

**Preview-only branch:** `webinar-e2e-test-r2` (from PR #61 head `95b8127c0be79fb8afcefad03d362ab104b8078f`). This branch must never be merged into `main` or PR #61.

**Rehearsal page:** `content/workshops/rehearsal-what-to-charge.json`.

**Database:** Existing production Supabase training project `ikkldbhgjleelviwttir`; release 2 migration `20261109120000` already applied and verified. A single session `rehearsal-what-to-charge` is `is_test=true`, `status=published`, admission=`invite`; 25 general seats, 5 graduate seats, GHS 350 advertised price, GHS 50 referral discount and commission, 20% Foundations discount. Workshop 01 remains `draft`.

**Test event:** Google Calendar on the owner's personal account; event ID `u2cqtiqhcl289nme78vq2ff7v0`, 2026-11-14 11:30–14:30 Africa/Accra. The distinct Meet link is stored on the Calendar event and is NOT included in any public source file. No guests have been invited. Owner must manually apply and confirm Trusted / admission-by-invitation settings before a Google Meet admission test.

**Date difference:** This rehearsal deliberately occurs on 14 Nov, instead of the live workshop date of 12 Dec. The preview-only JSON and database session both use 14 Nov; do not overwrite the 12 Dec live Workshop 01 event or its session.

**Referral:** One `prepared` test-only referral code has been created using an active Intermediate webinar entitlement. Never activate or distribute it before owner approval. A direct database quote verified GHS 300 price, GHS 50 customer discount, GHS 50 commission, and case-insensitive code handling. Do not commit this actual code to GitHub.

**Read-only verification:** `workshop_quote` returns GHS 350 for standard test and `not_found` in live mode; live Workshop 01 remains inaccessible as `draft`. No test or live workshop 01 registrations were created.

**Still to do:** Confirm Cloudflare deployed this preview branch and exposes the test page. The existing `workshop-dispatch` cron STILL points to the older `webinar-e2e-test` preview and should not be retargeted until the new deployment is verified. Carry out five real Paystack *test-mode* browser journeys with controlled inboxes and verify real delivery; check zero live commissions and seats. Finish and remove the test event after the rehearsal, not before.

**Guardrails:** No production key changes, no public registration, no live payments, no PR #61 merge, no student outreach or invitations.
