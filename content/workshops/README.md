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
