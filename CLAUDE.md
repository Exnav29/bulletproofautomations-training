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
3. **No waitlists and no "Coming Soon" cards.** Every course that exists gets a real signup
   with dates, price, and a payment path. Courses that do not exist yet are not listed.
4. **Never invent dates, prices, testimonials, learner names, or outcome statistics.**
   Use clearly bracketed placeholders like `[START DATE]`, `[GHS 0,000]`. Flag them in a
   summary at the end of your turn so they can be filled in.
5. **Training and certification are separate products.** Completing the cohort qualifies a
   learner to attempt the assessment; it does not award the credential. Any page describing
   BCAB must say this.

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
- Deploys to training.bulletproofautomations.com via [Netlify / Vercel / Pages — fill in]
- Local preview: [command]
- Work on a branch; do not commit directly to main.
