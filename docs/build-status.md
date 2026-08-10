# Build status — site rebuild

**Updated:** 10 August 2026 · **Branch:** `site-rebuild` · **Nothing merged to `main` yet.**

Read this with `CLAUDE.md`, `docs/project-brief.md` (confirmed decisions in §12) and
`docs/competency-framework.md`. This file records where the build actually is, so a new
session can continue without re-deriving it.

---

## 1. What is built

| Page | Status |
|---|---|
| Global shell — header, pathway rail, footer | **Built, approved** |
| `/` homepage | **Built, approved** ("okay with the design for now") |
| `/certified-automation-builder` | **Built**, not yet reviewed. Enrollment form blocked — see §4 |
| `/standard` | Not started. **Next.** Ships with the BCAB page |
| `/thank-you` | Exists but is still the **old waitlist page**. Needs rewriting |
| `/foundations` | Not started (Tier 2, needed before 5 September) |
| `/pathway` · `/about` | Not started (Tier 2) |
| `/verify` · `/builder-pool` · `/workshops` · `/privacy` | Not started (Tier 3) |
| `_redirects` | Not created. Needed for the three legacy URLs |

Build reports **11 of 20 declared paths**; the nine unbuilt routes are already declared in
`publicPaths` and are skipped with a warning until their files exist.

---

## 2. Build order still to run

Per the approved plan, driven by the 12 September cohort start:

1. **`/standard`** — the published competency framework with PDF download. The BCAB page links
   to it five times; the link check stays red until it exists.
2. **`/thank-you`** — rewrite from waitlist framing.
3. **`/foundations`** in State 2 — showcase invite. Must be live before 5 September.
4. **`/pathway`**, **`/about`**.
5. Tier 3: `/verify`, `/builder-pool`, `/workshops`, `/privacy`, `_redirects`.

---

## 3. Conventions established (do not re-litigate)

**Stack.** Static HTML, one stylesheet, vanilla JS. `package.json` has **no dependencies** and
there is no `node_modules`. Ask before adding anything.

**Includes.** `scripts/build.js` resolves `<!-- include: header.html nav="bcab" -->` from
`partials/`, substituting `{{param}}`. `stage="2"` drives both the rail's visual state and
`aria-current="step"`; `nav="bcab"` marks the nav item. `partials/` is deliberately **not** in
`publicPaths`, so it never ships. Includes resolve into `dist/` only — serving the repo root
shows raw include comments, so always check via `npm run build && npx http-server dist`.

**Environment.** `__SUPABASE_URL__` / `__SUPABASE_ANON_KEY__` tokens in source are substituted at
build time from `process.env`, falling back to a gitignored `.env`. A build with `CF_PAGES` set
and the values missing **exits 1** rather than deploying a dead form. Never hardcode the key.

**CI validates `dist/`, not source** — `ci.yml` runs `npm run build` first. Source pages are
fragments without includes resolved, so validating them would always fail.

**Colour carries meaning.** `--sand` is the campus and the training; `--ink` is the credential.
Every page alternates on that basis. `--marigold` marks anything time-sensitive and appears
nowhere else. `--verified` for actions on light grounds, `--signal` for actions on dark. The
brighter `--signal` always takes ink text — white on it fails contrast.

**Geometry carries the same split.** Campus blocks take `--r-card`; credential blocks stay square
or `--r-sm`.

**Type.** One Archivo variable file, 90 KB, carrying weight 100–900 and width 62–125. Hierarchy
uses the **width** axis: display expanded (116–122), body normal (100), labels condensed (84).
Sentence case throughout — this is a hard rule from `CLAUDE.md`.

**Motion inventory** — deliberately small, and every piece is meant to carry meaning:
- Hero: words rise out of masks, eyebrow fades. Once, on load.
- Pathway rail: current stage's rule draws in.
- Homepage "This term": **deliberately no motion** — the client asked for stillness here.
- The wall: an eight-week rail fills with reading position, and one emphasis sweep on
  *"Every person demoing was exactly where you are eight weeks ago."*
- Stage cards: a bus line pulses between them.
- Figures: count up once on scroll.
- BCAB hero: the workflow canvas wires pulse continuously.

`prefers-reduced-motion` gets finished states, never missing content — the figures' hidden state
is opt-in for exactly this reason.

**Hero images.** Art-directed `<picture>`: wide crop from 900px, tall crop below, in AVIF/WebP/JPEG
at three widths each. Generated with **ffmpeg** (`convert` on this machine is Windows' filesystem
tool, not ImageMagick). A phone downloads ~115 KB total for the homepage, 90 KB of which is the font.

---

## 4. Blockers

**Resolved 10 August 2026 — the enrollment form works end to end (HTTP 201).** The four CHECK
vocabularies are recorded in `supabase-enrollments.sql`. Four column/value mismatches were caught
by testing against the live API rather than assuming: `whatsapp` not `whatsapp_number`,
`chosen_option` not `option`, `payment_plan` is a boolean, and `source` is constrained to
`website | showcase | whatsapp | referral`. `consent_given` also needed a real checkbox — it
defaults to false, so every enrollment would otherwise have recorded no consent while the page
promised WhatsApp contact.

**One test row to delete** in the enrollments table: `full_name = 'ZZ TEST ROW - safe to delete'`.
Anon has no delete policy, so it needs removing from the dashboard.

**Already fixed against the live schema** (verified through the API, not assumed): `whatsapp` not
`whatsapp_number`; `chosen_option` not `option`; `amount_ghs` not `amount_due`; `cohort` not
`cohort_slug`; `payment_plan` is a **boolean**; `consent_given` needed a real checkbox.

**Paystack** is in review, expected live around 16 August. Until then the form writes a
reservation and shows the confirmed state. When it goes live only the block after a successful
insert changes — the form, validation and stored record are already correct.

---

## 5. Placeholders on built pages

Every one renders in conspicuous dashed marigold. **Nothing ships with one still visible.**

| Placeholder | Where | Needed from |
|---|---|---|
| `[WHATSAPP NUMBER]` ×3 | footer, BCAB enroll intro | Johnathan |
| `[CONTACT EMAIL]` ×2 | footer | confirm `training@bulletproofautomations.com` |
| `[REFUND AND CANCELLATION POLICY]` | BCAB FAQ | policy decision |
| `[MISSED-SESSION POLICY]` | BCAB FAQ | policy decision |
| `[WEBHOOK METHOD]` | BCAB, before Week 1 | n8n Cloud / VPS / tunnel |
| `[INSTRUCTOR BIO AND PHOTO]` | BCAB, and all of `/about` | Johnathan |

---

## 6. Other open items

- **Nothing is committed.** The entire rebuild is uncommitted on `site-rebuild`. Commit before
  anything else.
- **`assets/js/main.js` still hardcodes the OLD project's anon key** and serves the retiring
  legacy routes. Decide: tokenise it, or remove it with the legacy pages.
- **The Daily Waitlist Digest action** points at an Edge Function in the old Supabase project.
  It will keep digesting old data or start failing. `supabase/functions/` are deployed to the old
  project too.
- **The standard PDF** does not exist. `/standard` promises a download; only the `.docx` exists.
- **Framework placeholders** appear verbatim on `/standard`: issue date, n8n version, review date.
- **Legal review** of the §7 hiring-standard wording.
- **Locked copy tension:** the showcase copy says "The next Beginner Cohort is coming" — "Beginner"
  is on the terminology avoid-list. Flagged, deliberately unchanged, awaiting a decision.
- **The hero photograph is stock.** A real cohort photo from the 5 September showcase would
  upgrade the hero, the wall and `/about` in one pass.
- **Cohort 1 proof** — consent to publish names, photos, portfolio links and capstone screenshots.

---

## 7. Verification before any merge

1. `npm run build && npx --yes http-server dist -p 8080 -c-1` — confirms the route is in
   `publicPaths` and actually ships.
2. `npx --yes html-validate "dist/**/*.html"` — currently clean.
3. Open a PR; the lychee link check is what enforces "every internal link resolves". **It will
   stay red until every route linked from the shell exists**, so either finish Tier 3 or narrow
   the nav before merging.
4. 360px, 768px, 1280px. Keyboard-only pass. Contrast. `prefers-reduced-motion`.
5. Terminology audit against the `CLAUDE.md` table.
6. Independence statement in every footer; non-guarantee wording on every page mentioning the
   hiring standard.
7. No fabricated dates, prices, testimonials or statistics — placeholders visible instead.

**Merging to `main` deploys immediately.**
