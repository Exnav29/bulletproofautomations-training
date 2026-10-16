# Automatic certificate preview validation — 16 October 2026

PR: https://github.com/Exnav29/bulletproofautomations-training/pull/43

Backend: Supabase `ikkldbhgjleelviwttir`, Edge Function `certificate-processor`,
version 2. Renderer: PDFium WASM 3.0.0, fast-png 8.0.0. No VPS dependency.
Recovery: active `certificate-processor-recovery` cron, once per minute.

## Results

- Node workflow tests: 20 pass.
- Deno actual rendering tests: 5 pass (landscape, rotated portrait, portrait,
  invalid/oversized/corrupt PDFs, excessive page dimensions/corrupt PNG).
- TypeScript check, JavaScript syntax, build and HTML validation pass.
- GitHub Secret scanning, HTML validation, Server PDF renderer pass.
- Link check: pre-existing external `https://www.bulletproofautomations.com/`
  HTTP 421 in `dist/nfc/resources/index.html`; unrelated to this change.
- Live transactional database tests pass: actual RPC grants, invalid capability,
  stale-job rejection, duplicate active-job prevention, idempotent completion.
  All test writes rolled back; no test credentials created.
- Live saved-job retry succeeded after fixing empty PostgREST response handling.
- Reprocessing Carl's existing PDF returned `already_processed=true` without
  changing its record again or overwriting an object.
- Anonymous backend health access: 403. Administrator JWT is checked against
  Supabase Auth and the existing email allowlist. Backend capability routes
  cannot create jobs or accept arbitrary URLs.
- All nine production public PNGs loaded in the actual cloud browser at
  1584 × 1224. Every public PDF and PNG returned HTTP 200 with correct MIME.
- All nine published PDF SHA-256 values match the original delivery manifest.
  Backend also compared each production private master against its public PDF.
- Record snapshots: only preview_path and automatic updated_at changed. No
  names, emails, IDs, issue dates, PDF paths, status or consent fields changed.
- No email tools were used for this implementation; no graduate emails sent.

| Graduate | Certificate ID | PDF | Preview | Browser |
|---|---|---|---|---|
| Carl Lokko | BPA-FND-2026-WHXRTT | 200, original bytes | 200, 1584 × 1224 | Loaded |
| Edem Koku Dzameshie | BPA-FND-2026-D7S1ZC | 200, original bytes | 200, 1584 × 1224 | Loaded |
| Isaac Ayiku-Lartey | BPA-FND-2026-TKM9XC | 200, original bytes | 200, 1584 × 1224 | Loaded |
| James Bediako | BPA-FND-2026-K3J054 | 200, original bytes | 200, 1584 × 1224 | Loaded |
| Kwesi Dela Odoom | BPA-FND-2026-3BB8FN | 200, original bytes | 200, 1584 × 1224 | Loaded |
| Michael Tettey | BPA-FND-2026-ASBGN1 | 200, original bytes | 200, 1584 × 1224 | Loaded |
| Muniratu Iddris | BPA-FND-2026-DYYXK5 | 200, original bytes | 200, 1584 × 1224 | Loaded |
| Nana Appeadu Yeboah-Boateng | BPA-FND-2026-H558H4 | 200, original bytes | 200, 1584 × 1224 | Loaded |
| Samuel Nnadi | BPA-FND-2026-C3V8PF | 200, original bytes | 200, 1584 × 1224 | Loaded |

## Acceptance limits

The administrator signed in successfully. Enrollment roll, payment reporting,
credential register and archive controls loaded. Private-master download and
retained-master processing/restoration were exercised in the actual browser.
The controlled test used an identical copy of Carl's approved PDF, then restored
his original published paths. An extra immutable private master is retained as
version history; no existing master was modified or deleted.

The live test found and fixed deployment cache mismatch and a timezone-only
admin date display issue (stored issue dates never changed). A transient job-start
timeout retained the uploaded master and was recovered without reupload. Automatic
status-check/retry coverage was added for both uncertain success and no-job cases.
No real enrollment, payment, credential issuance or revocation was performed solely
to smoke-test unrelated features in production.

Edge functions enforce 256 MB / 2 seconds CPU per request. Complex or excessive
PDFs fail safely and retain the master for retry/attention. Cold renderer loads
also depend on the fixed pinned CDN binary; SHA-256 integrity is verified.
An immutable conflicting PNG is not overwritten: the job requires attention.
The private queue's RLS-with-no-policies INFO is intentional (backend only).
Pre-existing security advisor findings outside this feature remain unchanged.
