# Webinar and workshop content

**Since release 6 (November 2026) workshops are managed in `/admin/workshops/`, not here.**
Each workshop's page content lives on its `workshop_sessions` row (`content`), and the series
text lives in `workshop_series`. The public pages at `/workshops` and `/workshops/<slug>` are
rendered on request from the database by `functions/workshops/[[path]].js`, so a workshop
created, edited, opened, closed, cancelled or deleted in the admin is live at once, with no
GitHub change and no deploy.

What the admin enforces (in `workshop_admin_session()`, not only in the page):

- Registration opens only with a future date, a short description and, for invitation-only
  workshops, the Google Calendar event attached.
- Places never go below the people who already hold one.
- The page address can't change once registration has opened, so shared links keep working.
- A workshop anyone has registered or queued for is cancelled, never deleted, and its paid
  places stay on record for a refund or a move.
- A meeting link can't go on the public page: joining details are private and live only in
  the joining instructions, which go to confirmed people.
- Every change is stamped in the row's `admin_notes`.

`materials/<session slug>/` still holds participant materials. They are never published (see its
README).

## Joining links never go here

This repository is public. A workshop's Meet (or other) joining link lives only in
`workshop_sessions.join_instructions` on its database row, and reaches confirmed participants
by email or Calendar invitation. The page renderer never selects it.

## Refund policy

Paid forms link to the webinar and workshop terms: section 23, "Webinars and workshops", of the
existing `/refund-policy` page (`refund-policy/index.html#workshops`). When the terms change,
update that section's version line and `TERMS_VERSION` in `functions/api/_workshops.js`
together; `tests/workshops-render.test.js` fails if they differ.
