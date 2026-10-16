# Credential PDF archive — operator runbook

This is an additive workflow inside the existing /admin dashboard. It does NOT issue credentials, change certificate IDs, send emails, or affect enrollment, Paystack or verification systems.

## Production resources

- Supabase organization: Bulletproof Automations QA
- Project: ikkldbhgjleelviwttir
- Credential source of truth: public.credentials
- Public Storage bucket: credentials
- Private master Storage bucket: credential-masters
- Approved admin email: johnathan@bulletproofautomations.com

The pdf_path column is already read by /api/verify. It stores a relative object path, never a full URL. The preview_path column is unchanged.

## Archive the nine 2026 Foundations certificates

1. Open https://training.bulletproofautomations.com/admin and sign in.
2. Under Credentials find Archive issued PDF certificates.
3. Select the approved PDF files named exactly after the issued credential ID. Example: BPA-FND-2026-WHXRTT.pdf. Select all nine if convenient.
4. Click Archive selected PDFs ONCE and wait for the final report.
5. Confirm all nine rows show Attached. Use Manage PDF to download the master, then check View certificate on the existing public verifier for several graduates.
6. Do not resend certificates by email. The first nine already received their emails.

If an attempt partially succeeds, open Manage PDF before retrying. Every upload uses a new immutable versioned key; it never overwrites a prior certificate.

## Future issues and recovery

- New credential: issue using the existing form, create and approve its PDF, then use Archive PDF on that row.
- Replacement: use Manage PDF to upload a new version; confirm the dialog. Older private master copies remain.
- Retrieve: use Manage PDF > Download master.
- Restore an earlier version: use Manage PDF > Make current. If the matching public copy is missing, the UI republishes it before linking the record.
- Partial failure: a private master may succeed while the public upload or database update fails. The old pdf_path remains untouched. Check earlier versions before retrying.
- A 401/403 means the signed-in user lacks Storage privileges, or the policy rejected the filename or bucket. Do not bypass the policy.
- Do not manually set pdf_path unless the associated public object was checked.
- Do not overwrite or delete old masters: the Storage policy grants no UPDATE or DELETE.

## Security

PDF files must be nonempty, no larger than 15 MiB, and pass a PDF signature check. The browser uses the signed-in administrator's Supabase Auth JWT, NEVER the service-role key. Storage RLS requires the approved email and a real credential ID in the object path. Keys use a versioned format such as:

BPA-FND-2026-WHXRTT/20261015T224259-11ab22cd.pdf

The credentials bucket serves public PDFs, while credential-masters is private.

IMPORTANT: Hiding a credential from the verification result does not revoke a public Storage URL someone already saved. Moving public PDF serving behind a signed, access-controlled route would require a separate security change.

## No-regression boundary

The new JavaScript runs after admin.js and leaves its session, enrollment, payments, issuance, visibility, and revocation logic alone. /api/verify and the RPC functions are unchanged. Node tests: node --test tests/credential-archive.test.js. Complete a live admin login, upload/download, enrollment, payment, and public verification smoke test before marking a production rollout complete.


## Certificate image previews (2026-10-16)

A published PDF alone is **not** an image preview. The public verifier displays
a PNG only when public.credentials.preview_path has an associated public
Storage object. Without that field the verifier shows a clear PDF-download
fallback instead of an empty image box.

To backfill or provide previews:

1. Render the first PDF page to PNG (landscape, 1584 x 1224 works well for US Letter);
   do not change the already-issued PDF.
2. Name each thumbnail by its certificate ID: BPA-FND-2026-WHXRTT.png.
3. Sign into /admin and select them under **Certificate preview images**.
4. Click **Upload selected previews** and check the final report.
5. Verify each credential shows the preview and its existing PDF download.

The browser determines the PNG Storage key from the existing pdf_path,
replacing only .pdf with .png. It uploads that immutable public PNG and
updates **preview_path only** after upload success. Authenticated Storage
RLS restricts PNG uploads to the approved admin, the credentials bucket,
and the matching already-linked PDF. Neither the PDF path nor credential
validity changes.

When publishing a replacement PDF, the admin archive intentionally clears
preview_path to avoid displaying an out-of-date image. The replacement
preview may then be uploaded. Old PDF masters are unaffected.

The inaugural cohort previews are included in the downloadable
Bulletproof_Foundations_2026_Archive_9_Previews.zip created for the
2026-10-16 backfill.
