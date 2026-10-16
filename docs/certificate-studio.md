# Certificate Issuance Studio

The existing `/admin` portal contains **Create & Send Certificates**, with seven stages: course, cohort, graduates, PDF proofs, issuance approval, delivery and reporting. It remains a framework-free HTML/CSS/JavaScript site on Cloudflare Pages. No VPS or additional document-processing service is involved.

## Data and authorization

Courses, cohorts, batch snapshots, graduates, deliveries, template manifests and append-only audit records live in the unexposed `private` schema, with RLS and no grants to `anon` or `authenticated`. The server validates the existing administrator with Supabase Auth's `/auth/v1/user`; service-only RPCs independently verify its Auth user UUID against the configured administrator email. Browser input cannot invoke internal proof registration, queue context or email claims.

The three migrations in `supabase/migrations/` are reviewed and additive. Existing IDs, archive keys, timestamps and consents are preserved. The nine approved Foundations records are linked into a historical Studio batch without updating `public.credentials`. Prior email/physical delivery is not inferred.

A new credential has type `completion` and a random `BPA-TRN-YYYY-XXXXXX` identifier, backed by the existing unique constraint. General completion workflows cannot award BCAB/BCAE. Existing Foundations/BCAB paths remain supported. Drafts remain in Studio records. Approved credentials begin with `issuance_state=pending` and public consent disabled. Both lookup functions exclude pending credentials.

Eligibility is independent of enrollment/payment. Enrollment selection, manual entry and validated CSV imports are supported. Each roster change increments a batch revision. Proof generation and explicit review must match the current revision before final approval. Approval freezes the snapshot, reserves IDs and immutable master paths, and records the administrator. No email is sent by issuance.

## Exact original artwork

`scripts/studio/recover-template.py` recovers the approved signature image **and its original PDF transparency mask**, proving the resulting RGBA image is identical across all nine original PDFs. See `certificate-studio-signature-provenance.json` for hashes, original placement, source filenames, font hashes and dimensions. The original Python generator was not included in the retrieved packages; recovery therefore uses the actual approved issued documents, not a replacement font or redrawn signature.

Template 001 v1, the exact signature, and recovered fonts are in the private `certificate-studio` Storage bucket under `studio/001/v1/`. The browser and public GitHub repository contain no signature or blank-template bytes. The generator verifies template and signature hashes, composes vector text and QR modules, embeds/subsets fonts and flushes font resources before page composition. It produces unsigned, visibly watermarked draft PDFs. Signed generation is reachable only after final approval.

Assets are immutable. Future changes must register a new template version, retain the old assets and add a reviewed generator version; never overwrite `001/v1`. Existing documents are always retrieved from their archived masters.

## Archive integration and recovery

The Studio uploads an approved final PDF to the existing private `credential-masters` bucket and enqueues the existing `certificate-processor`. That processor continues to use PDFium WASM, the durable PostgreSQL queue, leases, recovery and immutable versioned PDF/PNG objects. Its ID validation now additionally accepts `TRN`.

A completion trigger atomically registers a matching approved Studio document when its archive job completes. Metadata, publication consent, current PDF and current preview are finalized together. Interrupted browsers can resume; retries reuse the allocated ID/master path and reconnect or retry the saved queue job. They do not create another credential.

Corrections create a new draft and immutable document version under the existing credential ID. The previous master remains archived. Current-document lookup is authoritative for future print/email, including requests from the old batch. Revocation retains the record and its history. Cohort/course configuration updates never rewrite approved snapshots.

## Printing

Individual Letter downloads use the exact current archived PDF bytes. A batch PDF copies one official certificate per page, without covers, administrative notes or PNG reconstruction. ZIP downloads contain individual PDFs. Reprinting never allocates credentials or sends mail.

The approved design is placed uniformly inside an explicit 18-point safety margin. Primary output is **US Letter landscape, 792 × 612 points**. The optional explicitly selected A4 rendition is **841.8898 × 595.2756 points**, generated from the current approved snapshot and template version, then independently checked for dimensions, margins, text and QR readability.

The source signature is 358 × 78 pixels, matching the approved artwork. Its effective resolution is approximately 142 DPI on the printer-safe Letter layout; it is not a 300-DPI source, and no artificial upscale or alternative signature is substituted. Text, borders and QR modules remain vector content. Physical stock/printer validation requires an operator.

Physical tracking distinguishes ready, pack generated, printed, handed out and not collected. Generating/downloading a PDF records only pack generation. Explicit administrator handout records include timestamp and administrator UUID; audit history retains all transitions.

Print landscape on the matching paper size, Actual size/100%, single-sided, with browser headers/footers disabled. Select the printer's appropriate heavy-paper setting and recommended feed tray; check its supported stock weight and test one sheet.

## Permanent Hostinger email transport

The backend uses Hostinger Mail's documented `POST /api/v1/mailboxes/{mailboxResourceId}/send`, for `johnathan@bulletproofautomations.com`. Its verified mailbox resource ID is configured server-side. Set **`HOSTINGER_MAIL_API_TOKEN`** in this Supabase project's Edge Function secrets; never place it in the repository, browser, course data or chat. `HOSTINGER_API_TOKEN` is a supported legacy alias. The ChatGPT connector's authorization cannot be exported or used as an application's permanent credential.

Email remains disabled until this secret is configured. A missing secret is checked before delivery is claimed. Prepared messages stay reviewable and nothing is sent. After setup, perform a controlled send to the owner before relying on graduate delivery.

The database's Foundations catalogue retains the original full congratulatory message, personalized through explicit placeholders. New courses use neutral configurable wording. Review recipient, subject, body and the exact PDF before separate send approval. Messages contain one recipient and one matching PDF; no CC/BCC. Recipients can be excluded. Explicit resends require a reason.

Delivery claims persist before calling Hostinger. HTTP 204 is authoritative provider acceptance; its correlation identifier is retained when supplied. The documented send API does not return an RFC Message-ID. Definitive rejections are failed; timeout/5xx/network ambiguity is uncertain. Sending/uncertain deliveries cannot be automatically retried. Check Hostinger Sent and record provider evidence through reconciliation before preparing another attempt. Crash recovery deliberately requires this reconciliation instead of speculative resending.

## Validation commands

- `node --test tests/*.test.js`
- `npm ci --prefix supabase/functions/certificate-studio --ignore-scripts`
- Link the installed backend `node_modules` to the repo root for local/CI test resolution.
- `deno check --node-modules-dir=manual supabase/functions/certificate-studio/index.ts`
- `deno test --node-modules-dir=manual --allow-env tests/studio-auth.test.ts`
- `deno run --node-modules-dir=manual --allow-read --allow-env tests/studio-db.test.mjs`
- `node tests/studio-ui.test.mjs`
- With the private original assets available: `STUDIO_TEST_ASSETS=/private/path deno test --node-modules-dir=manual --allow-read --allow-write --allow-env tests/studio-pdf.test.ts`
- `npm run build` and `npx html-validate 'dist/**/*.html'`

PGlite tests run actual PostgreSQL/PLpgSQL in an isolated process. Only Auth, Storage metadata and network dispatch are mocked there. They never access production graduate, enrollment or payment data. The actual signed PDF tests require private approved artwork and are deliberately not published in CI assets. The existing real-PDF renderer CI remains in place.

## Deployment and rollback

Apply the reviewed migrations first. Deploy `certificate-studio/index.ts`, `handler.ts`, `pdf.mjs`, `domain.mjs`, `deno.json` and its relative `certificate-processor/render.mjs` dependency. The function performs its own administrator authentication. Deploy the existing processor with its `deno.json` explicitly supplied as `import_map_path` to avoid inheriting stale absolute deployment paths. Merge only after CI/security/regression review; Cloudflare Pages deploys `main` automatically.

Initial private asset installation uses a temporary deployment capability, removed from the final production bundle after setup/pilot validation. Such setup files and capabilities are excluded from Git. The final endpoint has only the normal administrator-authenticated interface.

Rollback the website by reverting the release merge. The additive database structures and versioned archives should remain intact; do not drop them or delete issued documents. Disable/hide the Studio frontend if needed. Existing Foundations and BCAB verifier behavior remains available because existing records have the default `issuance_state=issued`. Never revert the processor's TRN support while new TRN jobs are queued.
