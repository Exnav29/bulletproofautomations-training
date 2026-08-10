# CLAUDE.md — Bulletproof Automations Training Site

## What this project is

A complete rebuild of `training.bulletproofautomations.com` — a multipage marketing and
enrollment site for Bulletproof Automations' training arm, run by Johnathan Lightfoot
from Accra, Ghana.

The site's immediate commercial job: **enroll people in the Intermediate cohort (BCAB) now.**
Its longer-term job: present the full Bulletproof Automation Builder Pathway as a credible
training and certification programme.

Full background: @docs/project-brief.md
Certification standard: @docs/competency-framework.md
**Current build state, conventions and blockers: @docs/build-status.md — read this first.**

## Terminology — use these exactly

| Use | Never use |
|---|---|
| Bulletproof Automation Builder Pathway | n8n Automation Builder Pathway, n8n Ghana Training Pathway |
| Bulletproof Automation Foundations Certificate | Beginner Certificate (alone), n8n Foundations Certificate |
| Bulletproof Certified Automation Builder (BCAB) | Intermediate Certificate, n8n Intermediate Certification |
| Bulletproof Certified Automation Engineer (BCAE) | Advanced Certificate |
| certificate (Stage 1 — records completion) | certification, for Stage 1 |
| certification (Stage 2+ — assessed, failable) | certificate, for Stage 2+ |

The Stage 1 / Stage 2 distinction is the spine of the whole pathway. Stage 1 is a
**certificate of completion**. Stage 2 is a **professional certification** that can be failed.
Never blur them.

## Immutable rules

1. **Never imply n8n affiliation or endorsement.** Bulletproof Automations is an independent
   provider. n8n is the platform competence is assessed on, not the subject of certification.
   Every page footer carries the independence statement.
2. **Never write job-guarantee language.** Certification is not an offer, promise, or
   indication of employment. Where the builder pool or hiring standard is mentioned, the
   non-guarantee wording from the framework must appear on the same page.
3. **No waitlists and no "Coming Soon" course cards.** Every course that is open gets a real signup with dates, price, and a payment path. Stage 3 (BCAE) is an exception: it is named on the pathway page as defined-but-not-yet-open, with no date, no signup, and no email capture. Naming it gives the pathway a visible ceiling; selling it early would devalue Stages 1 and 2.
4. **Never invent dates, prices, testimonials, learner names, or outcome statistics.**
   Use clearly bracketed placeholders like `[START DATE]`, `[GHS 0,000]`. Flag them in a
   summary at the end of your turn so they can be filled in.
5. **Training and certification are separate products.** Completing the cohort qualifies a
   learner to attempt the assessment; it does not award the credential. Any page describing
   BCAB must say this.

   6. **Pricing language.** Never write "Get BCAB Certified — [price]" or any
   phrasing implying the price purchases certification. Always write
   "Intermediate + BCAB Assessment" or "training and assessment opportunity".
   The credential is earned, not bought.

   7. **Showcase pitch copy is locked.** The text beginning "Builders don't W8"
   is final. Do not rewrite, tighten, or improve it. Use it verbatim.

## Voice

Plainspoken, direct, and willing to say no. The existing site's best instinct — a "Who this
is not for" section, explicit statements that there is no shortcut and no job guarantee — is
the register to keep. Specificity beats enthusiasm: an exact date, an exact cap, and an exact
pass threshold do more for credibility than adjectives.

Avoid: hype, growth-marketing urgency, fake scarcity, exclamation marks, "unlock", "transform",
"game-changing". Real scarcity (a 15-seat cap, a real deadline) is fine — state it flatly.

Write in sentence case. Active voice. Buttons say what happens: "Enroll in the cohort",
not "Submit" or "Get started".

## Audience constraints

- Primarily Ghanaian professionals. Price in **cedis (GHS)**, not USD.
- **Mobile-first is not optional.** Assume most visitors are on a phone, some on slow
  connections. Keep payloads light; avoid heavy hero media.
- **MoMo must be a visible payment option**, not card-only.
- **WhatsApp is a first-class contact channel**, alongside email.

## Source documents — how to use them
- `docs/competency-framework.md` — **canonical.** Source of truth for all weights,
  thresholds, and legal wording. Quote it exactly; never paraphrase from memory.
- `docs/Bulletproof_Automation_Builder_Pathway_Framework_v2.docx` — the circulation
  version of the same content. Do not edit it directly. If the framework changes,
  update the .md and flag that the .docx needs regenerating.
- `docs/[foundations-teaching-guide].pdf` — **internal only.** Use it to determine what
  the Foundations course covers, its structure, and its outcomes. Never publish its
  instructor notes, demo scripts, deliberate-mistake sequences, fallback plans, or
  Gamma prompts to any public page.

## Design direction

**Not prescribed.** Use the design skills in this project. Constraints only:

- Must read as a professional training and certification body, not a course-seller.
- Must work down to a 360px viewport.
- Accessible by default: visible keyboard focus, sufficient contrast, `prefers-reduced-motion`
  respected, semantic headings.
- No prior design from earlier drafts should be carried forward.

## Working rules

- Ask before adding a dependency or framework; this is a marketing site, keep it light.
- When writing page copy, pull facts from `@docs/competency-framework.md` rather than
  paraphrasing from memory — the weights, thresholds, and legal wording are exact.
- Before building any page, propose the section order and get it approved.
- After content or route changes, check every internal link still resolves.

## Repo & deployment

- Repo: github.com/Exnav29/bulletproofautomations-training
- Work on a branch; do not commit directly to main. **Merging to main deploys immediately.**

### How it deploys

Cloudflare Pages, connected to this repo, production branch `main`. Build command `npm run build`,
output directory `dist`. DNS is at Namecheap — a CNAME for `training` pointing at Cloudflare Pages.
There is no `CNAME` file in the repo; the record lives in the Namecheap dashboard.

Flow: push to `main` → Cloudflare Pages runs `npm run build` → serves `dist/` →
`training.bulletproofautomations.com`.

The site was previously on Netlify. Do not reconnect it, do not deploy the repo root, and do not
use `npx wrangler deploy` for this site. Full runbook in @README_DEPLOYMENT.md; hosting constraints
and recovery notes in @OPS_NOTES.md.

### The build is a copy allowlist — read this before adding a route

`scripts/build.js` wipes `dist/` and copies a **hardcoded list** of paths into it. Nothing else
ships. The list is currently:

```
index.html · assets/ · admin/ · nfc/ · n8n-foundations/ ·
n8n-automation-builder-pathway/ · certified-automation-builder/ · standard/ ·
_redirects · robots.txt · sitemap.xml
```

Plus the rebuild routes declared but not yet built: `thank-you`, `foundations`, `pathway`,
`about`, `verify`, `builder-pool`, `workshops`, `privacy`. `price-by-value` was **retired on
10 August 2026** — folder deleted, dropped from the allowlist, and `/price-by-value` now 301s
to `/` via `_redirects`.

**Any new route added during the rebuild — `/pathway`, `/standard`, `/certified-automation-builder`,
`/verify`, `/about`, `/builder-pool`, `/workshops` — must be added to `publicPaths` in
`scripts/build.js` or it will not deploy.** It will work locally and 404 in production, with no
build error. Also update `sitemap.xml`.

The allowlist is deliberate: it keeps `.git`, `.github`, `supabase/`, `supabase-setup.sql`, README
and docs, and test plans out of the deployed bundle. Keep it that way — add public routes only.

Unbuilt routes may be declared in `publicPaths` before their files exist; the build skips them
with a warning rather than failing.

### Includes and environment (added in the rebuild)

`scripts/build.js` also resolves `<!-- include: header.html nav="bcab" -->` from `partials/`,
substituting `{{param}}`. `stage="2"` sets both the pathway rail's visual state and
`aria-current="step"`. `partials/` is deliberately absent from `publicPaths` so it never ships.

Includes resolve into `dist/` only. Serving the repo root shows raw include comments, so check
work with `npm run build && npx --yes http-server dist -p 8080 -c-1`.

Supabase values are injected at build time: source carries `__SUPABASE_URL__` and
`__SUPABASE_ANON_KEY__`, substituted from `process.env` or a gitignored `.env`. **Never hardcode
the key.** A build with `CF_PAGES` set and the values missing exits 1 rather than shipping a dead
enrollment form.

The live `enrollments` schema is documented in `supabase-enrollments.sql` — that file is
documentation, not a migration, and the database is the source of truth.

### Running it locally

No dev script exists — `package.json` has only `build`. Routes are folder-based (`route/index.html`)
and links are root-absolute (`/standard`), so opening `index.html` over `file://` breaks both
navigation and assets. Serve the repo root over HTTP:

```bash
npx --yes http-server . -p 8080 -c-1    # then http://localhost:8080
```

To check what actually deploys, build first and serve `dist/` instead:

```bash
npm run build && npx --yes http-server dist -p 8080 -c-1
```

Node 22 is what CI uses. The form-backed pages need the Supabase URL and anon key in
`assets/js/main.js` to submit; static pages render without them.

### CI

Three GitHub Actions workflows:

- **CI** (`ci.yml`, on pull requests) — runs `npm run build`, then `html-validate` and a
  `lychee` link check **over `dist/`**, not the source. Source pages are fragments until includes
  resolve, so validating them would always fail. This is what enforces the "every internal
  link resolves" rule above, so open a PR rather than trusting a local check.
- **Secret scanning** (`gitleaks.yml`, on push and PR) — gitleaks over full history.

**Removed 10 August 2026:** the Daily Waitlist Digest workflow (`daily-digest.yml`, cron
`0 10 * * *`). It was the only trigger for the morning digest email, so deleting it stopped the
report. The `daily-digest` Edge Function is still deployed on the old Supabase project and must
be deleted from that dashboard to be fully gone.

There is no deploy workflow in `.github/` — Cloudflare Pages builds from its own repo connection,
so a green CI run is not a deploy and a failing CI run does not block one.
