# Webinar and workshop pages: approved design

_Approved by the owner on 4 November 2026. Built with Anthropic's `frontend-design` skill: audit, two
browser-rendered directions, critique, build, visual QA._

## Direction

**"Session brief" with the step-by-step payment trace.** The page reads like the one-page brief a
trainer hands the room: the outcome as the headline, then the facts in a fixed order (when, length,
fee, places, who it's for), what you leave with, the run of show, fit, and the instructor. The
registration sheet carries a four-step trace (your details, pay, confirmation email, join live).
Every payment state is that trace's status, and the confirmation page is the completed trace.

The alternative, "Run trace" across the whole page, was declined. Its payment trace was kept.

## Type

| Role | Face | Why |
|---|---|---|
| Headings, dates, fees | EB Garamond 600 (`assets/fonts/eb-garamond-600.woff2`) | The voice of a certificate. One weight. |
| Everything read or filled in | "BPA Reading", a renamed subset of Andika by SIL (`bpa-reading-400/700.woff2`) | Designed for literacy in African languages; clear on low-cost phone screens |

- **Glyph coverage:** both faces cover Akan and Ewe letters (Ɔ ɔ Ɛ ɛ Ɖ ɖ Ŋ ŋ), Yoruba tone-marked
  vowels, and the cedi (₵) and naira (₦) signs. The site's Archivo subset covers none of these.
- **Rejected candidates:** Overpass and Merriweather were tested and dropped, because they misplace
  the Yoruba low-tone mark.
- **Licence:** Andika's reserved name is the reason for the rename. See `assets/fonts/FONTS-README.txt`.
- **Weight:** about 125KB, loaded only on `/workshops` pages.
- **Rest of the site:** still uses Archivo, including the shared header and footer. Moving those to
  this pair is a separate decision.

## Rules these pages keep

- **Rules of the page:** Rules between sections, no card grids. One bold element: the title.
  Marigold only for time-sensitive facts.
- **Times:** always shown for both Accra and Lagos.
- **Phone layout:** the title, outcome, facts and button come first. A slim register bar appears at
  the bottom on phones only while neither the first button nor the form is on screen. It is not a
  pop-up.
- **Header:** no pathway rail and no cohort Enroll button.
- **Consent:** the ad-measurement bar only exists when a Pixel ID is configured, and never blocks
  the page.
- **Certification wording:** "Attending is training, not a certification" appears on every detail
  page.

## QA record (4 November 2026, test fixtures)

- **Pages and widths:** directory, paid and free detail pages, full and stale-page states, and the
  four confirmation states (pending, confirmed, held for review, not completed), at 360, 390, 768
  and 1280px.
- **Layout:** no horizontal overflow at any width.
- **axe:** clean apart from one contrast failure in the shared site footer (the "Stage 3, not yet
  open" line, 4.26:1). That failure exists on every page and predates this work.
- **Keyboard:** every focus stop is visible.
- **Phone register bar:** hidden at the top, shown mid-page, hidden at the form.
- **Defects found by looking, and fixed:**
  - a consent bar showing when it should be hidden;
  - "GHS 150" breaking across lines;
  - the title's descenders touching the summary;
  - the button below the fold at 360px.
