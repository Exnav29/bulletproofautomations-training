# Training Administration — Operations Console

## Why this exists

The old /admin view was one continuous 700-line page. Administrators had to
scroll through enrollment queues, payment transactions, issuance controls,
archives, Studio forms and verification enquiries to find an action.

This update gives those workflows independent **physical, bookmarkable Pages
routes** while retaining the original tested form fields, event handlers,
Supabase authentication and database permissions.

## Page map

| Destination | URL | Tasks |
|---|---|---|
| Overview | /admin/ | Live summary, follow-ups, shortcuts |
| Enrollments | /admin/enrollments/ | Roster, cohort filters, payments plans, CSV |
| Payments | /admin/payments/ | Paystack ledger, exceptions, export |
| Credentials | /admin/credentials/ | Search, correct, revoke, archive, manual issuance |
| Certificate Studio | /admin/studio/ | Course, cohort, approvals, print, email |
| Verification activity | /admin/verification/ | Enquiry logs |

Each URL is built as dist/admin/{route}/index.html from the canonical
admin/index.html. This is intentional: shared legacy scripts require the
complete administrative DOM with its unique IDs; cloning at **build time**
keeps existing code paths unchanged while displaying only the current route.
The stylesheet hides other workspaces before JavaScript initializes. Only the
signed-in operator can see the administrative shell.

## Visual direction

Training operations desk. Dark deep-navy navigation rail, restrained
gold institutional accent, teal interactions and bright legible work surfaces.
Self-hosted Archivo font; no third-party visual assets or new framework.
Tables remain tables. Dense workflow fields are not converted to decorative
cards. At narrow widths, navigation becomes a keyboard-accessible horizontal
tab bar and tables stay horizontally scrollable. Motion respects reduced-motion.

## Cross-page actions

- Overview follow-ups navigate to /admin/enrollments/?flag=...
- Credentials can be filtered at /admin/credentials/?q=...
- 'Correct Certificate' on a matching issued credential navigates to
  /admin/studio/?correction=ID and resumes a saved correction draft, if present.
- The Studio auto-opens on /admin/studio/ after the existing login; no extra
  login or privileged state in the URL.
- The current PDF's corrected-name draft must be reviewed and approved via
  the official Studio flow; a shortcut must never directly PATCH names or
  bypass approval.

## Regression boundary

All existing administration HTML element IDs and the original signed-in
session mechanism remain available on **every** route. Payment webhooks,
issuance RPCs, archived PDF bytes, certificate IDs and Supabase table RLS are
unchanged. The update writes no production business data by itself.

CI exercises every built route, 6 active nav states, missing/duplicate legacy
IDs, direct filter URLs, workflow regression and document rendering. If a
specific screen breaks, rolling back the GitHub commit restores the old
single-page route, without needing a database rollback.

The legacy unrelated external-link 421 remains tracked separately.
