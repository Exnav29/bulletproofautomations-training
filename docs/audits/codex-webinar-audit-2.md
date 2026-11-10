# Codex independent audit 2 — focused re-review of PR #65

**Source:** Codex re-audit report shared by the owner with ChatGPT on 9 November 2026, via uploaded paste. This is a detailed transcription of its findings, evidence and action recommendations, preserved so Claude can review **both audits** rather than infer findings from headlines. This audit was **read-only** and used mocked external services.

- **Decision:** CONDITIONAL GO for **isolated, test-mode integration testing**; **NO-GO for production activation**.
- **Audited branch/commit:** `fix/codex-audit-corrections` at `8833ee93c1dc12ae37b75352d077f9f51e28bd62`.
- **Comparison baseline:** `78a707bc589e05f277d8722b5f6181940954e068`.
- CI passed at audited commit, including independent PostgreSQL connection tests and secret scanning. No code, migrations, infrastructure, or production data changed in this review.
- The original report contained **12 numbered defects plus deployment concerns (13)**. Original full finding inventory is in [audit 1](codex-webinar-audit-1.md).

## Re-review results, each original finding

| # | Finding | Codex re-review | Evidence / remaining issue |
|---|---|---|---|
| 1 | Concurrent duplicate refunds | **VERIFIED FIXED** | Refund RPC now locks event and checks `matched` before applying; separate PostgreSQL sessions test overlap. [supabase/migrations/20261112120000_workshop_audit_corrections.sql:65-81](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L65-L81) |
| 2 | Refund before charge | **PARTIALLY FIXED** | Authenticated early refunds reconcile with charge, but initial unauthenticated ledger entry can poison `signature_valid`; see A. [supabase/migrations/20261112120000_workshop_audit_corrections.sql:130-147](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L130-L147) |
| 3 | Renewed checkout holds beyond deadline | **VERIFIED FIXED** | Restarts retain original deadline, with seat counts and confirmation honoring it. [supabase/migrations/20261112120000_workshop_audit_corrections.sql:223-235](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L223-L235) |
| 4 | Reconciliation starvation | **PARTIALLY FIXED** | `last_verify_at` rotation improves fairness but >48h and `init_failed` are excluded; see B. [functions/api/_workshops.js:405-410](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/functions/api/_workshops.js#L405-L410) |
| 5 | Concurrent waitlist emails / invalid links | **PARTIALLY FIXED** | Claims stop normal overlaps, but failure writing delivery acknowledgement means later retry reissues token; see C. [supabase/migrations/20261112120000_workshop_audit_corrections.sql:391-425](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L391-L425) |
| 6 | Orphaned Calendar guests | **PARTIALLY FIXED** | Claimed plans stop usual overlaps, but failed result recording can leave permanently unauthorized guests; see D. [supabase/migrations/20261112120000_workshop_audit_corrections.sql:448-503](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L448-L503) |
| 7 | Dispatcher switch instructions | **NOT FIXED** | Actual target `webinar-e2e-test-r2...`, command replaces `webinar-e2e-test...`; see G. [docs/workshops-runbook.md:424-429](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/docs/workshops-runbook.md#L424-L429) |
| 8 | Email-only status-token disclosure | **PARTIALLY FIXED** | Email-only financial disclosure stopped; expired offer tokens may still serve as credentials and no self-service cross-device recovery; see E. [supabase/migrations/20261112120000_workshop_audit_corrections.sql:578-598](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L578-L598) |
| 9 | Sold-out retry / reserved grad waitlisting | **PARTIALLY FIXED** | Same-browser retry fixed, but reserved seat queue unavailable when general seats open. [assets/js/workshops.js:254-270](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/assets/js/workshops.js#L254-L270) |
| 10 | Email recovery / dispatcher health | **PARTIALLY FIXED** | Admin retry for `failed` exists, but exhausted `sending` rows can strand; waitlist/configuration failures missing from health; see F. |
| 11 | CSV spreadsheet formula injection | **VERIFIED FIXED** | All 4 exports prefix formula-leading values as literal text. [assets/js/admin-workshops.js:502-509](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/assets/js/admin-workshops.js#L502-L509) |
| 12 | Historical date breaks site builds | **VERIFIED FIXED** | Past events no longer block build; references to series remain valid. [scripts/workshops.js:98-105](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/scripts/workshops.js#L98-L105) |
| 13 | Production/deployment checks | **PARTIALLY FIXED — REQUIRES VERIFICATION** | Documentation improved; Cloudflare public API protection, Google event settings/OAuth, actual email receipt still require verification. [docs/workshops-runbook.md:46-61](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/docs/workshops-runbook.md#L46-L61) |

**Codex's conclusion:** Only high findings 1 and 3 are fully closed; high 2/4/5/6 have remaining paths and 7 remains incorrect. It is inaccurate to claim all seven high severity findings closed.

## Remaining confirmed defects, concrete reproductions and minimum fixes

### A. HIGH — Unverified first event poisons authenticated early-refund replay

Webhook logs unsigned/invalid requests under same unique event identity later used by valid deliveries. The subsequent signed refund reuses the row without fixing `signature_valid`, so the new pending-refund query (`signature_valid=true`) excludes it. Reproduced with actual webhook handler + in-memory ledger: unverified arrival → legitimate signed refund → `awaiting_charge` flag still false; later charge doesn't reconcile refund. No production incident alleged.

- Evidence: [supabase/functions/workshop-paystack-webhook/index.ts:110-135](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/functions/workshop-paystack-webhook/index.ts#L110-L135) and [supabase/migrations/20261112120000_workshop_audit_corrections.sql:139-147](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L139-L147).
- **Smallest fix:** On reuse of an unverified row, make subsequently authenticated delivery data authoritative before adding refund to pending queue. Regress unsigned-first, signed-refund, later-charge sequence.

### B. HIGH — Unresolved payments can fall permanently outside reconciliation

`last_verify_at` ordering fixes fairness *within* list, but selects only `initialized` attempts newer than 48 hours. An extended outage leaves payments unresolved and unverified; initialization failure uncertainty also depends on webhook/return. 

- Evidence: [functions/api/_workshops.js:405-410](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/functions/api/_workshops.js#L405-L410).
- **Smallest fix:** Bounded per-run, fair rotation over unresolved/uncertain attempts until explicitly terminal or sent to documented human review. Do not silently drop by age.

### C. MEDIUM — Waitlist send acknowledgment failure invalidates delivered links

`processWaitlist` mints fresh offer token for each send; completion helper ignores unsuccessful HTTP response. After lease expiry, new worker updates token hash, despite Hostinger accepting first email. Mock produced two accepted emails with first link invalid. 

- Evidence: [functions/api/_waitlist.js:81-93](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/functions/api/_waitlist.js#L81-L93).
- **Smallest fix:** Keep issued offer links valid to expiry (or reuse securely one token), check completion write results and prevent stale worker from completing another's claim. Test accepted provider send + lost DB acknowledgment + lease expiry.

### D. HIGH — Calendar changes accepted by Google can be orphaned permanently

External Google patch succeeds; DB `workshop_calendar_record` completion fails and is swallowed. Registration then refunded; `invited_email` remains null, so later plan emits no removal. Actual Google event retains unauthorized attendee indefinitely. Mock reproduces the sequence.

- Evidence: [functions/api/_calendar.js:70-88](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/functions/api/_calendar.js#L70-L88), [functions/api/_calendar.js:113-122](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/functions/api/_calendar.js#L113-L122), [supabase/migrations/20261112120000_workshop_audit_corrections.sql:480-482](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L480-L482).
- **Smallest reliable fix:** Persist intended/managed guest identity before external Google write; reconcile actual event attendees against current eligible roster **plus managed guest history**; preserve hosts/cohosts; keep pending/retrying until Google and DB agree. Retry must inspect actual event even if `invited_email` null. Merely increasing lease duration is insufficient.

### E. MEDIUM — Registration recovery remains incomplete / expired offer token accepted

An offer-token ownership branch checks neither offer status nor expiry. Cross-device unpaid customer cannot resume autonomously; loss of initial response on original device similarly strands checkout.

- Evidence: [supabase/migrations/20261112120000_workshop_audit_corrections.sql:585-590](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L585-L590), [assets/js/workshops.js:425-425](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/assets/js/workshops.js#L425-L425).
- **Smallest fix:** Check offer status and expiry as recovery credential; implement short-lived, single-use registered-email recovery via existing Hostinger + existing outbox. Generic acknowledgment before verification, token only after verified mailbox ownership; recheck price, seats, cutoff at checkout. No new auth platform.

### F. MEDIUM — Exhausted sending rows and dispatcher failures remain invisible

If fifth send's completion write fails, status remains `sending`, attempts=5. Claim excludes it, retry endpoint accepts only `failed`, admin UI lists only `failed`. Dispatcher success can omit waitlist failures and missing Calendar config.

- Evidence: [supabase/migrations/20261103120000_workshops.sql:718-728](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261103120000_workshops.sql#L718-L728), [supabase/migrations/20261112120000_workshop_audit_corrections.sql:708-712](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/supabase/migrations/20261112120000_workshop_audit_corrections.sql#L708-L712), [functions/api/workshops/dispatch.js:29-30](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/functions/api/workshops/dispatch.js#L29-L30).
- **Smallest fix:** Recover/report stale exhausted claims, show/admin-retry them, and include required outbox/Calendar/waitlist failures in health.

### G. HIGH — Live dispatcher command would be a no-op; rollback incomplete

Live job points at `webinar-e2e-test-r2...`. Launch instructions replace `webinar-e2e-test...`, so do not alter existing job. Whole-feature rollback lists releases 2 then 1 while omitting 3, 4 and 5.

- Evidence: [docs/workshops-runbook.md:424-429](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/docs/workshops-runbook.md#L424-L429), [docs/workshops-runbook.md:667-674](https://github.com/Exnav29/bulletproofautomations-training/blob/8833ee93c1dc12ae37b75352d077f9f51e28bd62/docs/workshops-runbook.md#L667-L674).
- **Smallest fix:** Read actual configured URL, update exact job target and **assert** resulting target; document reverse migration rollback order (5→4→3→2→1 as appropriate), stopping workers/checkout and preserving in-flight data before destructive rollback.

## Additional specific defect to close (original item 9)

When general seats are still available, but reserved graduate seats have sold out, eligible graduates cannot enter the reserved-seat waitlist through the page. Fix allocation-aware waitlist UX without changing capacity or entitlement semantics. Confirm browser retry for already registered/unpaid customers remains working.

## Rollback and cohort protection

- Forward migration and restore-on-rollback approach is correct. Codex compared all **11** restored SQL functions with baseline exactly.
- **Online rollback still unsafe if in-flight:** dropping `hold_until`, lease/claim timestamps destroys operational state and reintroduces old defects. Runbook must explicitly stop/settle workers and pending payments/holds before considering rollback.
- Nine protected payment/middleware files remain identical; admin CSV changed only three formula-escape helper functions, with narrow CI exception independently validated.

## Testing / deployment verification

- CI succeeded; PostgreSQL tests employ **independent DB connections**, real row lock waits and SKIP LOCKED, and are meaningful; Calendar tests still mock Google guest set.
- Re-review did NOT independently rerun the claimed baseline '10 failures' experiment. Missing tests: external write succeeds but DB ack fails (waitlist & Calendar), unverified-first refund event, >48h reconciliation, expired offer token, stale exhausted `sending` row.
- At re-review, production still had releases **1 and 2 only**; releases 3–5 absent. Confirm live migration state before actions.
- Cloudflare abuse protection, calendar event guest privacy and OAuth authorization, Hostinger actual receipt and ability to recover need operational verification. Previously **Test 1 confirmation was observed in Gmail**, so treat it as passed; do not repeat standard payment or change providers without a reason.

## Original re-review decision

**CONDITIONAL GO for isolated TEST-mode integration tests, NO-GO for live production.** Correct remaining A/B/D/G before enabling production, plus C/E/F/seat-allocation flows and required operational checks. No architecture rewrite necessary.

**Use with:** [Original audit](codex-webinar-audit-1.md), [reuse-first requirements](../WEBINAR-REUSE-FIRST-RESET.md), and PR #65. This file is documentation-only, not evidence that the code changed.
