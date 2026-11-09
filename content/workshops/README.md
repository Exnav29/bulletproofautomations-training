# Webinar and workshop content

One JSON file per scheduled session, named `<slug>.json`. Never shipped; the build reads it and
generates `/workshops` and `/workshops/<slug>` (see `scripts/workshops.js`).

- `"status": "draft"` never renders. Set `"published"` only when every detail is real.
- The build refuses a published file with a missing field, a past start time, or any
  `[PLACEHOLDER]`, TODO or TBC.
- The matching `workshop_sessions` row in Supabase is the authority for price, time, capacity and
  whether registration is open. Create it with the same `slug`, `starts_at` and `price_ghs`; a
  registration is refused if the page and the database disagree.
- `tests/fixtures/workshops/sample-webinar.json` shows every field. It is a test fixture with
  sample content and must never be copied here as published.
- Optional fields `why` (paragraphs) and `outcomes` (a numbered list) add "Why this workshop" and
  "What you will be able to do" sections.
- **Opening registration is a database change, not a deploy.** Keep the row `draft` until go-live:
  the page then says registration isn't open yet, and the API refuses bookings. Set it to
  `published` to open.

## Series

`series/<slug>.json` groups sessions under one name. Today there is one series,
`get-paid-for-automation`. Each entry is one of two kinds:

- `{ "number": 1, "session": "<slug>" }`: a published session file. It is bookable.
- `{ "number": 2, "status": "planned", "slug", "title", "headline", "problem", "audience", "outcomes", "series_fit" }`:
  copy only. It gets a coming-soon page with no form.

The build refuses the series if any of these is true:

- a planned entry carries `starts_at`, `price_ghs`, `capacity`, `duration_minutes` or any other
  schedule field;
- a session entry points at a file that is not published;
- the numbers are not 1, 2, 3 and so on in order.

Planned workshops never get a database row, so the registration API refuses them.

To schedule a planned workshop, add its session file with real values and a matching `draft` row,
then replace its series entry with `{ "number": n, "session": "<slug>" }`. Keep the same slug so its
URL does not change.

`materials/<session slug>/` holds participant materials. They are never published (see its README).

## Joining links never go here

This repository is public. A workshop's Meet (or other) joining link lives only in
`workshop_sessions.join_instructions` on its database row, and reaches confirmed participants
by email. The build fails on a meeting link or a `join_instructions` field in any file in this
folder, draft or not.

## Refund policy

Paid forms link to the site's existing `/refund-policy` page. The webinar and workshop terms are an
unpublished draft in `docs/workshops-refund-policy-draft.json`; once approved they become a section
of that page (`docs/workshops-runbook.md`, step 8). No separate policy page is built.
