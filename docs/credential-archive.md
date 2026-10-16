# Certificate archive and automatic previews

The site remains on Cloudflare Pages. Rendering runs in Supabase Edge Functions
on project `ikkldbhgjleelviwttir`. Product Studio/VPS is not involved.

## Administrator workflow

1. Issue the credential using the existing form (unchanged).
2. Open Manage PDF / Archive PDF, choose ONE PDF, click **Upload & Archive Certificate**.
3. The browser uploads an insert-only private master using its Supabase Auth JWT.
4. The server validates and renders page 1 at 144 DPI, validates the full PNG,
   publishes and retrieves both objects, and transactionally links both paths.
5. Complete means the objects and database paths were verified. The dialog provides
   verification, PDF, preview and private-master downloads and earlier versions.

Bulk: select PDFs named `<certificate_id>.pdf`. Every valid file is independent;
invalid filenames or failed conversions are reported without stopping other files.
Repair missing previews processes all current PDF records with no preview. For a
broken or unlinked image use Manage PDF → Regenerate Preview. No PNG uploads exist.

A lost browser connection does not stop a queued conversion. Reopen Manage PDF:
Processing jobs shows durable status and **Retry saved PDF**. A failed upload before
a job is created is recoverable under Earlier versions → Process & make current.
No certificate email is sent by any archive/repair action.

## Backend

- `supabase/functions/certificate-processor/`: Deno Edge Function, PDFium WASM
  3.0.0 + fast-png 8.0.0; no browser canvas, HTML reconstruction or conversion API.
- Renderer binary is fetched at one fixed versioned npm CDN URL, checked against
  committed SHA-256 before compilation, and cached per isolate. Requests cannot
  select URLs or files. Pin dependency changes and review upstream notices.
- Native Poppler cannot execute in the existing edge runtimes. PDFium is a real
  PDF rasterizer compatible with this hosting, avoiding additional infrastructure.
- Queue: private Postgres table, RLS enabled; service-role-only RPCs. No new browser
  permissions. Supabase validates user JWT via `/auth/v1/user`, then exact admin
  allowlist. API never accepts frontend claims as authorization.
- Dispatch uses existing pg_net; pg_cron recovers queued/interrupted jobs once per
  minute. Only one conversion lease is active. A 256-bit per-job capability is
  stored privately and sent only to the fixed backend run endpoint. It cannot
  create work or choose a PDF. Job polling never returns that capability.
- Execution: 15 MiB PDF, 5 MiB PNG, maximum 12M pixels / 6000px edge, 20s network
  deadlines, 120s job lease; Supabase also enforces 256MB and 2s CPU/request.
  Oversized, corrupt or expensive PDFs fail safely, retaining the private master.
- Private master, public PDF and PNG use immutable matching versioned keys.
  Preview is `<pdf_path without .pdf>.png`. Paths remain relative.
- Completion compares both expected pdf_path and updated_at and validates the
  live job lease in one database transaction. Repair updates preview_path only;
  replacement/restoration atomically update both. Credential details are untouched.
- Existing conflicting immutable PNG bytes require investigation; never overwrite
  an object blindly. Missing PNGs can be recreated safely from the retained master.

## Deployment order

1. Feature branch/PR. Run Node tests, renderer tests, build, HTML validation,
   secret scanning. Feature code must be committed before production deployment.
2. Apply `supabase/certificate-processing.sql` with the connected Supabase account.
   It adds only private queue infrastructure and service-role RPCs.
3. Deploy `certificate-processor` with `verify_jwt=false` because the function
   validates administrator JWTs itself and accepts private job capabilities for
   database dispatch. Existing payment functions are never changed. Default
   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase; keys are
   never copied into repository, browser or new Cloudflare settings.
4. Test anonymous denial, admin health, one real archive repair and object hashes.
5. Schedule recovery after backend availability:
   `select cron.schedule('certificate-processor-recovery','* * * * *','select private.dispatch_certificate_jobs()');`
   Check `cron.job` first; do not create duplicate schedules.
6. Merge tested PR to main (Cloudflare Pages deploys automatically). Verify built
   assets and actual admin/public behavior before retiring manual-upload policies.
7. Apply `supabase/certificate-processing-retire-manual.sql` only after successful
   rollout. It preserves private master INSERT/SELECT and credential admin rights.

## Existing-cohort backfill

Retrieve the nine existing records; use their CURRENT pdf_path and updated_at.
Call `certificate_job_start` with mode repair and master_path equal to pdf_path.
This fetches both production public and private PDFs, proves their bytes match,
renders the real page, uploads a matching PNG, and updates only preview_path.
Never use a locally prepared PNG, reissue, change dates, or resend emails.
Query sanitized job status and verify every public PNG and PDF afterwards. A repeat
checks identical objects and does not modify already-correct records.

## Recovery and rollback

- Inspect `public.certificate_job_status(null,null)` as service_role, or the admin
  Processing jobs panel. Never expose private run_token values in logs.
- Recovery dispatcher returns interrupted jobs to queued; after 3 interruptions
  marks failed, for manual retry. Ordinary conversion errors fail immediately.
- Retry saved jobs only while their expected credential version still matches.
  A newer issue/revocation/visibility edit causes Requires attention; reload and
  start from current data. Earlier private masters remain downloadable.
- Revert frontend PR first to roll back the UI. Pause the named cron job and wait
  for active leases to finish before reverting backend. Retain queue audit data,
  both Storage buckets, existing PDFs and linked previews. Never delete masters.
- Do not run the historical root SQL files as migrations.
- Existing external HTTP 421 link-check failures are unrelated to rendering.
