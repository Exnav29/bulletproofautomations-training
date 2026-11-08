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

Revised after visual review on 4 November 2026: the rounded Andika-based
"BPA Reading" body face looked too casual, similar to Comic Sans. Use the
established Bulletproof Automations site typography instead.

| Role | Face | Why |
|---|---|---|
| Headings, dates and fees | EB Garamond 600 (`assets/fonts/eb-garamond-600.woff2`) | Formal editorial contrast, retained from the approved layout |
| Body copy, buttons, labels and forms | Archivo variable (`assets/fonts/archivo-latin-variable.woff2`) | Consistent with the existing training site and more professional |

- Archivo is already loaded by the shared `site.css`; no additional body font download.
- The subset lacks some Akan, Ewe and Yoruba characters, so fallback to the system
  font for unsupported glyphs must be inspected during final language QA.
- Andika font files remain in the repository but are no longer referenced by
  the workshop pages; any later removal should retain required OFL notices.
- The rest of the site is unchanged.

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

## Additions for the Get Paid for Automation series (8 November 2026)

These additions extend the approved system. They introduce no new typefaces, colours or layouts.

- **Series directory:** `/workshops` opens with the series name in the existing directory heading
  style, then the positioning line in EB Garamond. The bookable workshop follows as the existing
  directory row, then the numbered sequence of ten. The sequence uses rules between items, not
  cards.
- **Labels:** "Coming soon" is a neutral outlined label. The only marigold label is the real date
  of workshop 01, keeping marigold for time-sensitive facts.
- **Coming-soon pages:** these use the session-brief layout (crumbs, kicker, title, lede, ruled
  sections). The registration sheet is replaced by a "Coming soon" sheet that says there is no
  date or fee and links to workshop 01 and the series. They have no form, no fee and no trace.
- **Detail page:** optional "Why this workshop" and numbered "What you will be able to do" sections
  sit before "What you leave with". The series appears as a ruled section near the end, followed by
  the independence disclaimer.
- **Registration not open yet:** while a session's database row is `draft`, the sheet uses the
  existing closed-form state with "Registration isn't open yet", and the hero and phone buttons
  read "Registration not open yet".
- **Case:** titles are in sentence case, following the site rule. The series name, Get Paid for
  Automation, keeps its capitals as a proper name.
- **QA (8 November 2026):**
  - Pages: the directory, workshop 01, and workshops 02 and 10.
  - Widths: 360, 390, 768 and 1280px under device emulation.
  - Layout: document width equals the viewport at every width, with no element past the edge.
  - Validation: html-validate is clean.
  - Links: all 1,137 internal links resolve.

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
