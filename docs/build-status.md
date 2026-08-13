# Build status — site rebuild

**Updated:** 13 August 2026 · **Branch:** `site-rebuild` · **Nothing merged to `main` yet.**

Read this with `CLAUDE.md`, `docs/project-brief.md` (confirmed decisions in §12) and
`docs/competency-framework.md`. This file records where the build actually is, so a new
session can continue without re-deriving it.

---

## 1. What is built

| Page | Status |
|---|---|
| Global shell — header, pathway rail, footer | **Built, approved** |
| `/` homepage | **Built, approved** ("okay with the design for now") |
| `/certified-automation-builder` | **Built**, not yet reviewed. Enrollment form works end to end; Paystack checkout built and switched off pending business activation — see §6 |
| `/standard` | **Built**, not yet reviewed. No placeholders — the first page in the rebuild that ships clean |
| `/thank-you` | **Rebuilt 10 August 2026** as the Paystack return page: confirmation, the dated sequence to Week 1, the training/certification separation, instalments, and a route for payment problems |
| `/foundations` | **Built 10 August 2026** in State 2. Notify-me capture tested end to end against the live table |
| `/pathway` | **Built 10 August 2026.** Three stages, two entry routes, BCAE named |
| `/about` | **Built 10 August 2026.** Bio supplied by Johnathan. Photo still a placeholder |
| `/verify` | **Built 10 August 2026.** Explains why nothing can be verified yet rather than saying "coming soon" |
| `/builder-pool` | **Built 10 August 2026**, deliberately thin. Non-guarantee wording verbatim in the hero |
| `/workshops` | **Dropped 10 August 2026.** Price by Value was its only occupant and is retired. Removed from nav, footer and `publicPaths` |
| `/privacy` | **Built 10 August 2026** from `docs/Privacy Policy.txt`, 20 sections |
| `/refund-policy` | **Built 10 August 2026** from `docs/Refund and Cancellation Policy.txt`, 22 sections. Linked beside the pricing block, not only in the footer |
| `404.html` | **Built 10 August 2026.** Root of `dist/`, in `publicPaths`. Cloudflare Pages serves it with a real 404 status |
| `_redirects` | **Created 10 August 2026.** Carries `/price-by-value` → `/` only; the other two wait for their targets |
| `/admin` | **Rebuilt 10 August 2026** against `enrollments` on the current project. Policies, auth user and sign-up lockdown all verified live. Not yet clicked through in a browser |

Build reports **11 of 19 declared paths**; the eight unbuilt routes are already declared in
`publicPaths` and are skipped with a warning until their files exist. `price-by-value` was
dropped from the allowlist entirely on 10 August 2026, taking the count from 20 to 19.

`sitemap.xml` now lists `/`, `/certified-automation-builder` and `/standard`. Add each new
route as it is built.

---

## 1a. `/verify` rebuilt — 11 August 2026

Credential lookup, an admin register behind it, and the first real credentials issued.

**Two surfaces, gated differently.** `/verify` is a gated search box: name, email and reason before
you can look anyone up, kept 30 days per browser. `/verify/<credential-id>` and `/v/<credential-id>`
are **ungated** — that is the URL a holder puts in LinkedIn's Credential URL field, which LinkedIn
renders as a "Show credential" button, and a form in front of it would break every holder's
credential for exactly the audience it exists to convince.

**The browser no longer talks to Supabase on this page.** The anon key is public by design, so a
lookup the browser can make is a lookup an attacker can make — and Cloudflare protects our domain,
not supabase.co. Everything goes through Pages Functions on our own origin.

**The lookup is a FUNCTION, not a readable view.** An earlier draft granted a view to anon; a view
granted to anon can be dumped with one `?select=*`. `verify_credential()` has no "return everything"
form. Exact matching, minimum input lengths, `allow_name_lookup` and `publish_consent` are all
enforced in SQL rather than trusted to the client. Full reasoning in `supabase-credentials.sql`.

### Four things that were measured, not assumed

1. **`_redirects` 200-rewrites are silently ignored.** `/verify/*  /verify/index.html  200` looked
   right and did nothing — every `/verify/<id>` fell through to `404.html`. Only symptom would have
   been a dead credential on somebody's LinkedIn. Routing is now
   `functions/verify/[[path]].js` + `functions/v/[[path]].js`. **Do not put the rewrite back.**
2. **Turnstile on the ID path made a real credential read as missing.** A browser that could not
   obtain a token got 403 and the page rendered "no credential matches". Turnstile + gate pass are
   now required for **name** lookups only; an ID lookup needs neither, because the ID *is* the access
   control — the same model Cisco and Credly use. Brute force is bounded by the rate-limiting rule.
3. **A service failure must never render as "not found".** Those are opposite claims: one says the
   register was checked and is empty, the other says it could not be reached. Saying the first when
   the second is true tells a recruiter a real holder is lying. There is now a separate `#failed`
   state that says so explicitly.
4. **`focus()` scrolls by default**, so the deep link jumped the page during load. Focus now uses
   `preventScroll`, and scrolling only happens after someone has actually submitted something.

### Two bugs found only by a person using the real thing (11 August 2026)

Both were invisible to every check that came before them, including the CDP run.

**5. Duplicate CSP headers made every narrower policy in `_headers` inert.**
Cloudflare applies EVERY matching rule, not the most specific one, so `/verify`
received two `Content-Security-Policy` headers — and a browser given two
enforces the INTERSECTION. `script-src 'self'` from `/*` intersected with
`script-src 'self' https://challenges.cloudflare.com` came out as `'self'`,
Turnstile was blocked, no token was ever produced, and the gate failed for
everyone. **`/nfc` had the same fault from the day `_headers` was written** — its
inline scripts and Google Fonts were blocked in production the whole time. Both
now `! Content-Security-Policy` before setting their own. The reasoning is at the
top of `_headers`, because each rule reads correctly on its own and the failure
only shows in the response.

**6. The Turnstile widget was rendered inside a hidden container.** `#ts-bar`
started `hidden` and was only revealed when a request began, so the widget could
never solve. The symptom was maddening and diagnostic: the first submit failed,
and the failure itself unhid the widget, so the second submit worked. In a
private window it failed every time, because with no clearance cookie Turnstile
needs an interactive challenge and cannot show one in a `display:none` box. The
widget is now revealed before it is rendered and stays visible.

Lesson for the rest of this build: **a challenge widget must be laid out before
it is asked to solve**, and header rules must be checked in the response rather
than read in the file.

### Browser verification — the gap in §6 is now partly closed

`npx wrangler pages dev dist` against a local mock Supabase, driven in headless Chrome over the
DevTools Protocol (`scratchpad/drive-form.js`). **16 checks pass**: gate submit, pass stored, search
revealed, both credentials rendered, LinkedIn block populated, partial-name rejected, no uncaught
JavaScript errors. Turnstile refuses to solve in headless by design, so the widget alone is stubbed —
everything downstream is the real code path.

Screenshots at 360/390px confirmed the deep link, the gate and the not-found state.

### Live security posture, verified by curl against the live project

| Check | Result |
|---|---|
| anon `GET /credentials` | **401** |
| anon `GET /verification_lookups` | **401** |
| anon `POST /rpc/verify_credential` | **401** |
| anon `POST /rpc/verify_credentials_for` | **401** |
| `service_role` occurrences in `dist/` | **0** |
| `credentials` table contents | 2 rows, both real, no test data |

### The first credentials are issued, and they need a decision

`BPA-FND-2026-4GGY96` (Foundations) and `BPA-BCAB-2026-39VF9Z` (BCAB), both to Johnathan Lightfoot,
both dated **15 June 2026**, both **non-expiring** by an explicit founder exception recorded in the
row's `notes`. Three tensions, flagged and deliberately not resolved unilaterally:

- The Foundations certificate is a **certificate of completion** awarded on participation, portfolio
  and capstone (§3.3), issued to the person who taught the programme.
- BCAB is assessed and failable, public conferral opens 1 November 2026, and §6 makes second review
  mandatory where the assessor taught the candidate. There is no second assessor yet.
- 15 June 2026 predates both the cohort (11 July) and this framework's publication (14 July).

The cleanest fix if they are to stand: have the second assessor assess him once appointed, and say
so publicly. That converts the weakness into the rigour claim.

### Still to do on this feature

- **Certificate PDF generation is NOT built.** It is blocked on Kim's two fillable templates, and
  the code fills fields *by name* — building it before the field names exist would be guesswork.
  The spec to send her (field names, the 22mm QR box, the three-part verification block) is in the
  plan file. `pdf_path`/`preview_path` columns and the storage buckets are designed and documented;
  the result panel already renders a certificate when one exists and omits it cleanly when it does
  not.
- **Six environment values** must be set on the Pages project, for **Production and Preview
  separately**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `TURNSTILE_SITE_KEY` (build-time, and the build
  now **exits 1** without it under `CF_PAGES`), plus `SUPABASE_SERVICE_ROLE_KEY`,
  `TURNSTILE_SECRET_KEY`, `GATE_SECRET` (read by the Functions at runtime).
- **Dashboard state, not in version control:** Turnstile keys, Bot Fight Mode, and one rate-limiting
  rule on `/api/*`.
- **Verify `functions/` is picked up on a preview deploy before merging.** If the directory is
  missed, `/api/verify` 404s and every lookup fails, including the LinkedIn path.
- The credential page's **Open Graph card is generic** — it renders client-side, so a pasted link
  unfurls as "Verify a credential", not as the individual's credential.

---

## 2. Build order still to run

Per the approved plan, driven by the 12 September cohort start:

1. ~~`/standard`~~ — **built 10 August 2026.** All four BCAB links to it now resolve.
2. ~~`/thank-you`~~ — **built 10 August 2026.**
3. ~~`/foundations`~~ — **built 10 August 2026** in State 2.
4. ~~`/pathway`~~, ~~`/about`~~ — **built 10 August 2026.**
5. Tier 3: `/verify`, `/builder-pool`, `/workshops`, `/privacy`. **Next** — these four are the last routes the shell links to that do not exist.

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

~~**One test row to delete**~~ — **gone.** Confirmed against the database on 10 August 2026:
`enrollments` holds 0 rows.

**Already fixed against the live schema** (verified through the API, not assumed): `whatsapp` not
`whatsapp_number`; `chosen_option` not `option`; `amount_ghs` not `amount_due`; `cohort` not
`cohort_slug`; `payment_plan` is a **boolean**; `consent_given` needed a real checkbox.

~~**Paystack** is in review~~ ~~the integration is built and switched off~~ — **LIVE since 13 August 2026.** The business was approved, the whole go-live list was worked through, and one real GHS 150 transaction was paid and refunded end to end. See §6b.
The account is still awaiting business activation and holds test keys. The whole checkout path is
in place behind `PAYSTACK_SECRET_KEY`: unset gives the reservation flow that runs today, a
`sk_test_` key gives an opt-in-only test checkout, and pasting the `sk_live_` key is the entire
activation step. Full detail, including the go-live list, in §6.

---

## 5. Placeholders on built pages

Every one renders in conspicuous dashed marigold. **Nothing ships with one still visible.**

**As of 10 August 2026 there are none. The build contains zero placeholders.**

| Placeholder | Where | Needed from |
|---|---|---|
| ~~`[WHATSAPP NUMBER]`~~ | — | **Supplied 10 August 2026: +233 54 652 7779.** Given as `+233 054 652 7779`; the trunk `0` is dropped in international format, so links use `wa.me/233546527779`. **Confirm the digits** |
| ~~`[CONTACT EMAIL]`~~ | — | **Supplied 10 August 2026: `info@bulletproofautomations.com`** (not `training@`, as the brief had assumed) |
| ~~`[REFUND AND CANCELLATION POLICY]`~~ | — | **Resolved 10 August 2026.** Policy supplied and published at `/refund-policy` |
| ~~`[MISSED-SESSION POLICY]`~~ | — | **Resolved 10 August 2026: does not apply to BCAB.** It is a paid 25-person cohort, so a missed week is handled individually. The policy belongs to Foundations only |
| ~~`[WEBHOOK METHOD]`~~ | — | **Hidden 10 August 2026** at Johnathan's request. Both pages now say the method is confirmed at the setup clinic |
| ~~`[INSTRUCTOR PHOTO]`~~ | — | **Resolved 10 August 2026.** Photo supplied; AVIF/WebP/JPEG generated at three widths each, art-directed wide and tall |

---

## 6. Other open items

- **Second audit (browser-driven) run 11 August 2026 — findings triaged.** It caught a genuine
  launch blocker my static audit could not: the enrollment form's second acknowledgement was
  `name="ack_cert"` while the JS read `form.elements.ack_certification`, so submit threw
  `Cannot read properties of undefined` **before any request**, with no error shown. I had verified
  the payload against Supabase directly and never driven the form, which is exactly the gap a
  browser closes. Fixed, plus a `ticked()` helper so a renamed field degrades to `false` instead
  of crashing the form.

  Also fixed from that audit: touch targets below the 24px floor (menu button was ~20px tall),
  and the stale `.gitleaks.toml` description. `supabase/functions/daily-digest` is deleted —
  documentation already records that it existed, and keeping deployable source for something the
  owner asked to be gone is a redeploy risk. `confirm-email` and `vip-alert` remain and are now
  equally dead, since the pages that called them are retired — **awaiting a decision.**

- **Mobile overflow — `/nfc` and `/nfc/resources` FIXED 11 August 2026; `/standard` diagnosed, see below.**
  Johnathan supplied precise measurements from a local browser.

  **`/foundations` (closed by measurement).** 0 delta at 320, 375 and 430 after the same pass.
  The original audit finding does not reproduce; the pathway rail stages sit inside
  `.rail__track`, which owns its own scroll. Nothing to fix.

  **NFC (fixed).** The decorative Ananse Ntontan `.web-mark` SVG is absolutely positioned with
  `right: -140px` on purpose, and `.hero` even declared `overflow: visible`. At 430px that put its
  right edge at 546px — a constant +116px on every phone size, on both pages. Both containers now
  use `overflow-x: clip`, which contains it without creating a scroll container or touching
  vertical overflow. The decoration is unchanged; it is simply clipped at the edge, which is what
  bleeding a watermark off the page was always meant to look like.

  **`/standard` — diagnosed 11 August 2026 as a reporting artifact, not a visible defect.**
  An isolation pass supplied by Johnathan settled it. Three measurements at 320px, only one of
  which reports a problem: `offenders: []` (no element's bounding box passes the viewport),
  `bodyScrollWidth: 320` (nothing overflows the body box), and `documentElement.scrollWidth: 409`.

  The number is the tell. **409px is not a width that exists in the stylesheet** — the wide
  `.dtable` are `min-width: 34rem` (544) and `.dtable--matrix` is `26rem` (416) — and it does not
  move between 320 and 375 viewports. A *used* width tracks the viewport; an *intrinsic* one does
  not. 409 is the tables' min-content contribution reported on the root while `.dtable-wrap` clips
  the paint correctly. That also explains the isolation results: `overflow-x: hidden` on `html`,
  `body` and the wrap each changed nothing, while `display: none` on the tables changed everything
  — hiding a box removes its intrinsic contribution, clipping it does not. `.dtable-wrap` itself
  measures width 280, scrollWidth 544, clientWidth 278: a scroll container working as designed.

  **Outstanding confirmation.** Whether the page actually scrolls has not been checked. Run on
  `/standard` at 320px:

  ```js
  window.scrollTo(9999, 0);
  const after = document.documentElement.scrollLeft;
  window.scrollTo(0, 0);
  ({ actuallyScrolls: after > 0, offset: after });
  ```

  `false` means the 409 is an artifact and there is nothing to fix. Expected, but unverified.

  **Two real phone defects were fixed in the same pass (`d0c3c23`), and neither moves the 409.**
  `.dtable-wrap` and `.rail__track` now set `overscroll-behavior-x: contain`, so a sideways flick
  past the end of a table stays in the table instead of chaining to the document — on touch that
  chaining reads as the page itself sliding sideways, and is the likeliest source of the original
  report. And each wrapper now carries a `.dtable-hint` below it, outside the scroll container so
  it does not scroll away: a table clipped at 278px with no affordance hides those columns
  outright. Two breakpoints, because the matrix starts scrolling later than the rest — 36.5rem for
  the 544px tables, 28.5rem for the matrix. Hidden in the print stylesheet, where tables print
  whole and the hint would be false. Five wrappers: four on `/standard`, one on `/pathway`.

- ~~Unresolved and needing a browser: mobile horizontal overflow.~~ (superseded by the entry above)
  **Original note:** The second audit measured
  document widths exceeding the viewport on `/foundations` (320/375/430), `/standard` (320/375),
  and `/nfc` + `/nfc/resources` (320/375/430, reaching 546px). I could not reproduce or diagnose
  it — `box-sizing: border-box` is global, `.shell` is sound, every grid collapses at small
  widths, and both `.rail__track` and `.dtable-wrap` contain their own scroll. **I deliberately
  did not blind-patch layout I cannot see**, because a wrong fix would be undetectable from here.
  This needs someone with devtools open.

- **Pre-launch audit fixes applied 11 August 2026.** The blocker (acknowledgement columns present
  but unpopulated) is closed. Also fixed: Open Graph metadata site-wide with a 1200×630 card;
  a `_headers` file carrying CSP, HSTS, frame-ancestors and Permissions-Policy; both WCAG 1.4.11
  border-contrast failures; the 24px acknowledgement targets; sitemap completeness; the stale
  developer comment on `/nfc/resources`; admin escaping hardened; and honeypots on both public
  forms.

  **The legacy pages were retired in the same pass**, now that `/foundations` and `/pathway` exist
  to receive their traffic. That single change removed the old project's anon key from the bundle,
  two Google Fonts CDN pages, `main.js`, `style.css` and ~8 MB of PNGs. **`dist/` went from
  10.9 MB to 2.2 MB.**

  `/admin`'s script was externalised to `assets/js/admin.js` so the strict CSP holds rather than
  being weakened to accommodate an inline block. `/nfc` keeps a scoped, looser policy because it
  still has inline scripts and posts to the external n8n webhook.

- **Two audit items cannot be fixed from this repo:**
  1. **The production catch-all returning HTTP 200 for unknown paths.** Measured before `404.html`
     existed. Serving `404.html` from the root of the output directory is Cloudflare Pages'
     **native, free** behaviour, so the next deploy is expected to fix this without any dashboard
     change and without a paid plan (Johnathan is on the free plan and staying there). **Verify
     immediately after deploy:**
     `curl -o /dev/null -w '%{http_code}' https://training.bulletproofautomations.com/does-not-exist`
     — `404` means solved. If it still returns `200`, look for a leftover rule under Rules →
     Redirect Rules, which the free plan does include. **Do not add a `/*` catch-all to
     `_redirects` as a workaround** — depending on evaluation order it can shadow real routes.
  2. **No browser-based verification has ever been run** — no viewport was tested, no console
     inspected, no Lighthouse. This remains the largest unverified risk.

- ~~Locked showcase copy duplicated~~ — **resolved 11 August 2026 by Johnathan: it belongs on `/`.**
  The homepage keeps it verbatim (re-verified word-for-word against the brief: 180 words, exact
  match). `/foundations` now carries a short pointer in the site's own voice plus the Luma link,
  rather than a second copy. Rule 7 is intact — the locked text was moved off a page, never
  rewritten.

- **Two required acknowledgements now gate registration**, directly above the button rather than in
  fine print, each a separate checkbox so it is always clear which term a person agreed to. Wording
  supplied verbatim by Johnathan. A third can be added later for Terms of Service.

  **Not yet recorded in the database.** The page enforces them; nothing stores that they were
  ticked. For the defensibility argument that motivated them, a timestamp per acknowledgement on
  `enrollments` would be the difference between "the page had a checkbox" and "this person agreed
  at this time". Additive and reversible — awaiting a decision.

- **The company is US-based, not Ghanaian. Corrected site-wide 10 August 2026.** Every page had
  described Bulletproof Automations as being in Accra — the footer colophon on *every* page, the
  homepage hero eyebrow, the BCAB provider line, and two meta descriptions. **Bulletproof
  Automations is a United States company based in Jacksonville, Florida.** Its learners are in
  Ghana, it prices in cedis and it delivers online; none of that makes the company Ghanaian, and
  copy that blurred the two created real regulatory exposure. Now an immutable rule in `CLAUDE.md`
  so it cannot drift back.

  **Still to check, and outside what copy can fix:** `/nfc` carries the tagline "Woven in Ghana
  spirit" — a carried page with its own design, left alone pending a decision. More importantly,
  **Paystack is a Ghanaian processor settling in GHS**, which is a far stronger signal of local
  activity than any wording on a page. That is a question for an accountant or attorney familiar
  with US–Ghana cross-border trade, not something this repo can resolve.

- **Foundations cohort cap and schedule are no longer open.** The teaching guide states **25
  participants**, Saturdays 11:30–13:00 GMT, Cohort 1 running 11 July – 29 August 2026.
  `docs/project-brief.md` §9 still lists the cap as undecided; it is not.

- **The locked showcase copy now appears twice** — the homepage `.wall` and `/foundations`. Both are
  verbatim (diffed word-for-word against the brief, 180 words, exact match). The brief assigns it to
  the Foundations page and the homepage borrowed it first. Decide whether the homepage keeps the
  full text or drops to a pull quote; do not rewrite either, per rule 7.

- **Paystack checkout — built 13 August 2026, and live the same day. See §6b for activation.** Written while the account was in test mode
  while the business activation request is pending, so the whole path was built now and gated on
  one variable. **Activation is a single key swap; no code, copy, or price change.**

  **The key is the mode switch.** There is no `PAYSTACK_MODE` variable, deliberately — Paystack
  keys are prefixed `sk_test_` / `sk_live_`, so a separate flag could only ever disagree with the
  key. `functions/api/_paystack.js` reads the prefix:

  | `PAYSTACK_SECRET_KEY` | Behaviour |
  |---|---|
  | unset | The reservation flow, exactly as production runs today. This is the current state |
  | `sk_test_…` | Checkout **only** for a request carrying `testOptIn`, which the page sends only when loaded as `?paystack=test` |
  | `sk_live_…` | Checkout for everyone |

  **Test mode is opt-in because the alternative is a dispute.** A visitor sent to a test checkout
  sees a real-looking Paystack page, completes it, and believes they have paid. Nothing arrives.
  So a test key alone charges nobody: `/certified-automation-builder?paystack=test` is the ask,
  and a conspicuous dashed banner appears once the *server* confirms the keys are test keys —
  it cannot be summoned from the address bar and cannot survive the live key going in.

  **The integration shape changed from the brief.** `docs/project-brief.md` §6 specified hosted
  Paystack Payment Pages, chosen when there was no server. `functions/` now exists. Two facts
  settled it: **payment pages created in test mode do not exist in live mode** (Paystack keeps the
  environments fully separate), so hosted pages would mean building every page twice and swapping
  every URL at activation; and a hosted page mints its own reference, which left the webhook
  joining on email. Now `/api/enroll` calls Transaction Initialize server-side.

  **What that bought, and why each part matters:**
  - **The amount is decided server-side**, from the table in `_paystack.js`. It used to live in
    `assets/js/shell.js`, which was survivable when the browser only wrote a row and a hosted page
    carried its own price. It is not survivable when the posted amount is the charged amount —
    the devtools console would be a discount code. Verified: a request with `"amount_ghs": 1`
    injected still records and charges 1,050.
  - **We mint the reference**, so the webhook joins exactly instead of on email.
  - **The mode is encoded in the reference prefix** — `BPA-CAB-` live, `BPA-TEST-` test. This is
    what makes testing safe: the webhook applies an event only when the reference's mode matches
    `data.domain`, so a test charge can only ever settle a test enrollment.

  **`/api/enroll` must never lose an enrollment**, because the cap is 25 and enrollment closes
  8 September. Every failure ends with the row written and the visitor told they are on the list:
  Paystack unconfigured → `reserve`; Paystack refuses or times out → row written, status rolled
  back to `reserved`, reason recorded in `notes`, `reserve` returned; **the Function not deployed
  at all → the page falls back to the old direct anon insert.** That last one is deliberate:
  Cloudflare's discovery of `functions/` has still never been confirmed on a real deploy (see the
  open item below), and without the fallback a missed directory would silently break every
  enrollment on the site's only selling page.

  **The page's copy switches with the mode.** "Card and mobile money checkout is not open yet" and
  "Nothing is charged on this page" are only true while checkout is closed. Both sentences exist
  twice in the markup as `data-pay="off"` / `data-pay="live"`, and `shell.js` picks one from
  `GET /api/enroll`. The "off" version is what ships and what a visitor without JavaScript sees —
  under-promising is the safe direction. Without this, activation day needs a deploy to fix copy,
  and the failure mode if forgotten is a page promising nothing will be charged while charging.

  **Test rows are real rows.** A test checkout writes to `enrollments` with `notes` starting
  `[TEST]`. `/admin` excludes them from every figure on the board — seats taken, expected,
  collected, queues, mix — because a test row counted against a cap of 25 is the one number on
  that page nobody can afford to be wrong. They still appear in the roll, flagged
  "TEST — delete before launch". **Delete them before the live key goes in.**

  **`PAYSTACK_API_BASE`** overrides the API host **only under a test key**; a live key always talks
  to `api.paystack.co`. It exists so the checkout path could be driven against a stand-in rather
  than shipped on the strength of having read it.

### What was measured, not assumed (13 August 2026)

Three harnesses, all in the session scratchpad, against `wrangler pages dev dist` with mock
Supabase and mock Paystack:

| Suite | Result |
|---|---|
| Browser, real form over CDP (`drive-enroll.js`) | **12/12** — copy swap both ways, banner gating, button label, submit → confirmed state, submit → redirect to checkout, no uncaught errors |
| Browser, `functions/` absent (`drive-fallback.js`) | **8/8** — `/api/enroll` 404s, the direct anon insert fires, confirmed state shown |
| Webhook, real HMAC (`drive-webhook.mjs`) | **16/16** — see below, and §6a |

Webhook cases, each with a genuine SHA-512 signature: unsigned refused; wrong key refused;
**test key signing a `live` charge refused**; **test charge cannot settle a real seat by email**;
**live charge with a test reference refused**; live charge applied and matched on reference;
replay does not double-count; test charge *does* settle a test enrollment; a second instalment
accumulates rather than replaces; reaching the full amount flips to `paid`.

Also verified by curl against the endpoint: client-injected `amount_ghs` ignored; honeypot returns
success without inserting; missing acknowledgements refused; unknown `chosen_option` refused; 409
resumes an abandoned checkout instead of telling a paying customer they already have a place; a
paid person gets `already_paid`; amounts reach Paystack in minor units (105000 / 40000 / 15000
pesewas for bundle / first instalment / Path B) with `channels: ["mobile_money", "card"]`.

`npm run build` clean, `html-validate` clean, no `sk_test_`/`sk_live_` string anywhere in `dist/`.

### To go live — the whole list

1. **Cloudflare Pages → the training project → Settings → Environment variables.** Set
   `PAYSTACK_SECRET_KEY` for **Production and Preview separately** (Cloudflare scopes them apart).
   Test key now, live key on activation. Nothing else changes.
2. **Supabase → Edge Functions → Secrets:** `PAYSTACK_SECRET_KEY` (live), `PAYSTACK_TEST_SECRET_KEY`
   (test — setting it is how test webhooks are switched on), `PROJECT_URL`, `SERVICE_ROLE_KEY`.
3. `supabase functions deploy paystack-webhook --project-ref <ref> --no-verify-jwt`
   (`--no-verify-jwt` is required — Paystack sends no Supabase JWT; the HMAC signature is the auth).
4. **Paystack dashboard → API Keys & Webhooks.** Test and live webhook URLs are set separately and
   both can point at the same function:
   `https://<ref>.supabase.co/functions/v1/paystack-webhook`. Set the test one now.
5. **Paystack dashboard → Preferences → channels:** confirm mobile money is enabled for MTN,
   Telecel/Vodafone Cash and AirtelTigo. `channels` in the initialize call narrows what is offered;
   it cannot enable a channel the account does not have.
6. **Run one test transaction** at `/certified-automation-builder?paystack=test` with Paystack's
   test MoMo details, and confirm the row reaches `paid` in `/admin`.
7. **On activation:** delete every `[TEST]` row from `enrollments`, swap the Cloudflare variable to
   the live key, and confirm `GET /api/enroll` reports `live` and the page copy has switched.

**Still open, and outside this repo:** whether GHS test transactions are permitted before business
activation completes — worth checking first, since it is the one thing that could block step 6.
The Paystack account's own state (live/test, MoMo channels, callback URL) was already an open
decision in `docs/project-brief.md` §9 and still is.

- ~~`/admin` has no payments view yet~~ — **it does.** `assets/js/admin.js` renders the
  `payment_events` ledger and exports it. Since 13 August 2026 it also excludes `[TEST]`-marked
  enrollments from every board figure, so a test transaction cannot report a seat as taken.

- **The catch-all 404 is only half fixed.** `404.html` now ships at the root of `dist/`, which is
  where Cloudflare Pages looks. But production currently answers **200 with the old homepage for
  every unmatched path**, and `_redirects` did not exist in the repo before 10 August 2026 — so
  that behaviour comes from somewhere outside the build. **Check Cloudflare → Rules → Redirect
  Rules and the Pages project settings for a `/*` catch-all left over from the Netlify era.**
  While one exists it wins, and `404.html` will never be reached. Confirm after the next deploy
  by requesting a nonsense path and checking for a 404 status, not just a 404-looking page.

- **The CI link check still points at production.** `lychee` runs with
  `--base-url https://training.bulletproofautomations.com`, which is why it cannot fail on a
  missing route (§7). It should check `dist/` directly. Worth doing in the same pass as the
  catch-all, or the green tick stays meaningless even once every page exists.

- **The 11 Foundations notify-me signups were migrated on 10 August 2026**, from the old
  project's `waitlist_signups` into a new `public.foundations_interest` table on the current
  project. Documented in `supabase-foundations-interest.sql`. They were **not** put into
  `enrollments`: `/admin` counts rows there as seats taken, so importing eleven leads would have
  read "11 of 25 seats gone" with invented money owed. Original signup dates preserved, every row
  stamped with `migrated_from`, insert is `on conflict (email) do nothing` so it is safe to
  re-run. **The source rows were deliberately left in the old project** as a fallback until it is
  decommissioned. When `/foundations` is built, its notify-me capture writes here.

- **PR #22** is open as a draft: https://github.com/Exnav29/bulletproofautomations-training/pull/22
  Five commits. Do not merge — merging deploys immediately and the placeholders are still visible.
- **The Cloudflare Pages build fails** — cause confirmed by reproduction on 10 August 2026, not
  inferred. `CF_PAGES=1 npm run build` with the values resolvable exits 0; with them absent it
  exits 1 on `Missing environment values: SUPABASE_URL, SUPABASE_ANON_KEY`. The guard reads
  `process.env` only, so **this has nothing to do with the legacy form, `main.js`, or the old
  Supabase project** — retiring any of those will not turn the build green.
  **The fix is setting both variables on the Pages project, for Production _and_ Preview.**
  Cloudflare scopes them separately and the guard fires in both. Do not relax the guard to get a
  green check — it exists so a deploy cannot silently ship a dead enrollment form.

  **Owner confirmed on 10 August 2026 that the variables are now set, and a manual deploy
  succeeds.** Automatic production deploys will stay quiet regardless until something merges to
  `main` — Cloudflare's production branch is `main` and all rebuild work is on `site-rebuild`,
  so a push to the branch produces a *preview* build, not a production one. If a preview build
  still fails, the variables are set for Production but not Preview.
- ~~`/admin` RLS and auth~~ — **all closed and verified against the database on 10 August 2026**,
  not inferred. `/admin` was rebuilt with no CDN (Chart.js and supabase-js gone; it uses plain
  `fetch` against Supabase Auth and PostgREST), no `main.js`, build-time tokens, and the site's
  own design tokens. Verified live:

  | Check | State |
  |---|---|
  | `enrollments` policies | `anon` INSERT · `service_role` ALL · `authenticated` SELECT and UPDATE, both restricted to `email = 'johnathan@bulletproofautomations.com'` |
  | Admin Auth user | `johnathan@bulletproofautomations.com`, confirmed, created 10 August 2026 |
  | Policy email vs user | exact match |
  | Public sign-up | `disable_signup: true` — closed. Email sign-in still enabled |
  | `anon` reading the roll | returns `[]` — sealed |
  | `anon` inserting | still permitted, so the enrollment form is unaffected |
  | `ZZ TEST ROW` | **gone.** `enrollments` holds 0 rows |
  | `supabase-enrollments.sql` vs live table | all 24 columns match; nothing undocumented |

  The blanket `using (true)` policies were replaced by the email allowlist. Extend the check when
  a second assessor is appointed; if the list grows, move it to an `admins` table.

- **`assets/js/main.js` still hardcodes the OLD project's anon key** (`ftqcex…`, a legacy `eyJ…`
  JWT) and serves the retiring legacy routes. The current project is a different one entirely,
  with an `sb_publishable_…` key. **Leave it as it is until the legacy routes retire together
  with it** — tokenising it would repoint those pages at the new project, where
  `waitlist_signups` does not exist, silently breaking two live forms. Adding indirection to code
  scheduled for deletion buys nothing.

- **Retiring the legacy forms is blocked, and it is a sequencing problem, not a decision.**
  Checked 10 August 2026: both Supabase projects return `401` from `/rest/v1/`, so **both are
  alive and the old forms are still capturing**. They are the only live capture for Foundations
  notify-me, and every replacement route is missing — `/foundations`, `/pathway`. The new shell
  never links to any legacy route, so they are already orphaned from navigation and reachable
  only by direct URL or an old link. **Price by Value was retired outright on 10 August 2026**,
  which removed one of the three legacy routes without waiting for a replacement. Retirement
  order for the remaining two, once Tier 2 lands:

  1. Build `/foundations` and `/pathway`.
  2. Add `_redirects` for the three legacy URLs.
  3. Point `/admin` at `enrollments` on the current project.
  4. Delete the three legacy folders, drop them from `publicPaths`, and delete `main.js` and
     `assets/css/style.css` with them.

  Steps 1 and 2 must land together: a redirect to a route that does not exist is a 404 where a
  working page used to be.
- **The Daily Waitlist Digest action** points at an Edge Function in the old Supabase project.
  It will keep digesting old data or start failing. `supabase/functions/` are deployed to the old
  project too.
- ~~The standard PDF~~ — **resolved 10 August 2026: there will not be one.** `/standard` carries a
  `@media print` stylesheet instead, and the BCAB page's "Download the standard (PDF)" link becomes
  "Print or save the standard as PDF". No dependency added, and nothing to regenerate when the
  framework changes.
- ~~Framework placeholders~~ — **resolved 10 August 2026** and written into
  `docs/competency-framework.md`: issued 14 July 2026, n8n 2.31.6, next review 10 December 2026,
  revision history 26 May / 1 July / 14 July 2026. Version 2.0 is now **published**, not Draft.
  **`docs/Bulletproof_Automation_Builder_Pathway_Framework_v2.docx` is now out of date and needs
  regenerating from the `.md`.**
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
3. Open a PR. **The lychee link check cannot catch a missing route. Do not rely on it.**
   It runs with `--base-url https://training.bulletproofautomations.com`, so root-relative links
   resolve against production — and production answers **HTTP 200 with the old homepage for every
   path**, including ones that have never existed. Measured 10 August 2026:

   ```
   /standard                     -> 200, old homepage
   /certified-automation-builder -> 200, old homepage
   /nonsense-does-not-exist      -> 200, old homepage
   ```

   So lychee is not merely unreliable here, it is structurally incapable of failing on a missing
   route. PR #22's green check was meaningless rather than lucky. **Check routes by listing
   `dist/` against the links in the shell** — the loop in §7 of this file does it in one command.
   Worth fixing the catch-all separately: a 404 that returns 200 also tells search engines every
   mistyped URL is a real page.
   Check unbuilt routes by hand, or by listing `dist/` against the links in the shell.
4. 360px, 768px, 1280px. Keyboard-only pass. Contrast. `prefers-reduced-motion`.
5. Terminology audit against the `CLAUDE.md` table.
6. Independence statement in every footer; non-guarantee wording on every page mentioning the
   hiring standard.
7. No fabricated dates, prices, testimonials or statistics — placeholders visible instead.

**Merging to `main` deploys immediately.**

---

## 6a. Three database failures reported as normal results — fixed 13 August 2026

Found while writing the go-live checks, not by a test. All three are the same
fault the `/verify` work already learned once: **a service failure must never be
reported as a normal negative result.** There it made a real credential read as
missing. Here it loses money.

Paystack retries only on a non-2xx response. Every one of these answered **200**,
so Paystack marked the event delivered and never came back.

| Where | Was reported as | Consequence |
|---|---|---|
| `payment_events` insert fails | `{"ok":true,"duplicate":true}` | Payment never applied, never retried |
| Enrollment lookup fails | `matched:false`, "No enrollment matched this reference or email" | Real payment stranded as unmatched for ever |
| Enrollment PATCH fails — the money write | `{"ok":true,"applied":true}` | Response claimed the seat was paid when nothing was written |

All three now return **503** so the retry happens.

**The 503s alone would have been theatre.** On retry the event is already in
`payment_events`, so `on_conflict=ignore-duplicates` returns nothing and the
duplicate guard would have dropped the payment on the second pass instead of the
first. So a duplicate now reads the prior row back and branches on `matched`:
already applied stops, logged-but-never-applied is driven through. That branch is
what makes the retry worth anything.

**One deliberate exception.** If the enrollment write succeeds and only the
`payment_events` note fails, the function still answers **200**. The money has
already moved, and a retry would find the event unmatched and add the amount a
second time. Losing the ledger note is recoverable by hand from `/admin`; losing
the money is not.

### Residual risk, stated rather than papered over

`amount_paid_ghs` is written by **increment**, not derived, so retry safety rests
on `matched` being an accurate record of whether the money moved. One window
remains: if the enrollment PATCH is sent and the response is lost, the function
reads it as failed and returns 503, and the retry adds the amount twice. Closing
it properly means deriving `amount_paid_ghs` from the sum of matched
`payment_events` rows rather than incrementing — worth doing, not worth blocking
activation on, and the ledger makes it visible if it ever happens.

### Verification

`drive-webhook.mjs` gained failure injection — the stand-in PostgREST can now
503 on demand, which is why these branches had never been reached.

**16/16 against the fix. 11/16 against the code as it was**, with the five
failures being exactly the new cases, including
`Paystack's retry then applies it exactly once — paid 0`. The tests were
confirmed to fail before they were confirmed to pass.

---

## 6b. Live payments switched on — 13 August 2026

Paystack approved the business for live payments. The whole list in §6 was worked
through in order, and **one real GHS 150 transaction was paid on the live site
and refunded**, which is the only thing that proves the chain end to end.

### The order mattered, and it was not the obvious one

The instinct is to configure the dashboards before merging. That is backwards
here. `PAYSTACK_SECRET_KEY` unset gives the reservation flow, so **merging
changes nothing a visitor sees** — whereas setting the Cloudflare key first
leaves it inert until the merge, at which point live checkout opens with no
verification window at all. Merge first, verify each piece against a
deployed-but-off system, and put the key in last.

Underneath that: **the webhook must be deployed and registered with Paystack
before the live key goes in.** It is the only thing allowed to mark someone
paid. Without it a customer pays, Paystack keeps the money, and the database
never hears.

### What was verified, and how

| Step | Verified by |
|---|---|
| Merge deployed, `functions/` discovered | `GET /api/enroll` → `{"ok":true,"paystack":"off"}` |
| Supabase secrets correct, on the RIGHT project | Unsigned probe → `signature_valid:false`. The function logs before it verifies, so a successful write proves `PROJECT_URL` and `SERVICE_ROLE_KEY` without spending anything |
| No function on the old project | `POST` to `ftqcex…` → `404 NOT_FOUND` |
| Live mode active | `GET /api/enroll` → `"paystack":"live"`, and the reference minted `BPA-CAB-` |
| The whole payment chain | One real GHS 150 Path B transaction reaching `paid` in `/admin` and in `enrollments`, then refunded |

**The unsigned probe is worth keeping.** It costs nothing, needs no Paystack
involvement, and it distinguishes a wrong-project misconfiguration from a
correct one — which is exactly the mistake that was made and caught during
activation.

**Deploying the same event twice distinguishes the code versions**, too:
pre-§6a answers `duplicate:true` on the second delivery, post-§6a answers
`signature_valid:false` because the read-back branch runs. That is how the
deployed function was confirmed to carry the fix while `main` still did not.

### Cloudflare Pages variables need a redeploy

A Pages environment variable only reaches deployments made **after** it was
saved. Setting `PAYSTACK_SECRET_KEY` and stopping there does nothing at all. Set
it for **Production and Preview separately**, then redeploy.

### Rollback

Delete `PAYSTACK_SECRET_KEY` from the Pages project and redeploy. The page
returns to the reservation flow, enrollments still record, nobody is charged,
and the honest copy comes back on its own. No revert, no Supabase change, no
Paystack change.

### Still open

- **The old project's Edge Function secrets.** Secrets are project-scoped and
  live independently of functions, so values saved against `ftqcex…` during the
  mix-up are still there even though no function was deployed to it. Delete
  them. If the live Paystack key was ever saved there, roll it.
- **`BPA-PROBE-` rows in `payment_events`** from the activation checks, and the
  refunded GHS 150 enrollment row.
- ~~Whether the refund shows correctly on the roll~~ — **refund handling built
  13 August 2026, see §6d.** The refunded row will not correct itself
  retroactively, because the webhook that would have applied it had not been
  written when Paystack sent it. Adjust that one row by hand.

---

## 6c. /thank-you told people they had bought the cohort — fixed 13 August 2026

Found by the live GHS 150 transaction above. A Path B readiness-review buyer was
shown the founding Intermediate cohort's confirmation page: enrollment closing
8 September, the proof-of-setup task, the setup clinic, Week 1 on 12 September,
and webhooks reachable by Week 2. "What you have paid for" read **"the five-week
Intermediate cohort"** — precisely what it was not — and the instalments section
does not apply to GHS 150 paid in one go.

**What ships is the neutral version.** Every offering-specific block starts
`hidden`; `shell.js` reveals one only after `GET /api/enroll?reference=…`
confirms which offering the reference belongs to. Same rule as the `data-pay`
copy on the enrollment page: the version that ships is the one that cannot be
wrong. No JavaScript, or an unresolvable reference, leaves a confirmation that is
true for any purchase.

**The reference is used to ask the question, never to answer it.** Carrying the
offering in the callback URL would have been three lines and no endpoint, but it
would have meant `/thank-you` trusting a query string — the one thing that page
has always refused to do — and it would not survive the link being shared.

**One field, and not a sensitive one.** The endpoint returns `chosen_option` and
nothing else: which of three published prices somebody picked. No name, no
email, no amount, and deliberately no payment status, because the response is
reachable by anyone holding the reference. The value is checked against the
price table rather than returned as stored. Without a reference the endpoint is
byte-for-byte the mode probe it always was.

Path B copy is drawn from the framework, not written fresh: advisory and not a
gate (§4.12), GHS 150 credited against the GHS 450 fee leaving GHS 300, no
training purchase required. The training/certification separation callout stays
visible in **every** variant.

**Verification — `drive-offering.mjs`, 20/20.** Functions concatenated with
imports stripped and loaded from a `data:` URL, so the code under test is the
deployed code. Covers both `reference` and `trxref`, all three options, an
unknown reference, a junk column value refused rather than echoed, a malformed
reference never reaching the database, and the lookup failing, throwing or being
absent all falling back to neutral. The page's swap is driven against a stand-in
DOM **built from the real markup's own attributes**, which proves the shipped
hidden state rather than asserting it.

Confirmed against production after merge: real reference →
`"option":"path_b_readiness"`, bare probe unchanged, unknown reference → `null`,
and the page shipping 4 neutral blocks visible with 5 cohort and 5 path_b
hidden.

---

## 6d. Refunds — built 13 August 2026

The webhook applied `charge.success` and nothing else, so a refunded learner
still read `paid` and still occupied one of the 25 seats. Harmless for the one
activation transaction, which was refunded knowingly; not harmless the first
time it happens to somebody else, because `/admin` is what decides whether the
cohort is full.

`refund.processed` now reverses the amount. `refund.pending`,
`refund.processing` and `refund.failed` are recorded and applied to nothing — a
pending refund has not left the account, and acting on one frees a seat that is
still paid for.

| Reversal | Resulting status |
|---|---|
| Full | `cancelled` — the honest word, and the value `/admin` already excludes from seats taken, so the seat returns to the pool |
| Partial | `partially_paid` |
| Nothing to reverse | Unchanged. A refund against an unpaid row is not evidence of anything |

### The payload shape is NOT verified, and the code says so

Paystack's documentation is not reachable from this environment, and
integrations in the wild read `transaction_reference || transaction.reference`
— which tells you the shape is inconsistent enough that people code around it.

So every plausible path is tried in order, and **if none yields a reference the
event is recorded as unmatched rather than guessed at.** An unmatched refund is
a line in the ledger somebody reconciles. A guessed one silently frees a seat
that is still occupied, or fails to free one that is not.

**When a real refund webhook has been seen, read `raw` on its `payment_events`
row and tighten this.** That is the one outstanding task on this feature.

### Two things the shape uncertainty forced

**The reversal is clamped.** `amountGhs` divides by 100, which is verified for
charges by a real transaction and unverified for refunds. If a refund ever
arrives in major units, dividing again under-reverses a hundredfold. Clamping to
what was actually paid bounds the damage: a refund can never drive
`amount_paid_ghs` below zero, nor reverse more than the person paid. A clamp
that fires writes `REFUND OF n EXCEEDED AMOUNT PAID AND WAS CLAMPED; check the
units` into the match note, because it means the units assumption is wrong and
wants a human before the next refund.

**A refund never falls back to matching on email.** A charge does, because a
hosted page or a dashboard-raised charge leaves only an address behind. A refund
that did the same would reverse money on whichever enrollment shares the
address, which is precisely the quiet wrong answer this file exists to avoid.

### The dedupe key had to change

`(provider, event, reference)` was the transaction reference. Two partial
refunds of one transaction would have collided, and the second would have been
silently ignored — the roll then claims more money was kept than actually was.

Refunds are now logged under `<txnref>:refund:<refund id>`, so two partial
refunds are distinct while a replay of either still dedupes. The stored value is
only a dedupe key and something a human reads: the join uses the transaction
reference from the payload, exactly as the charge path already does.

**The §6a read-back had to move with it.** It looks up the prior event by the
stored reference, so it now uses the same composite value it inserted under —
otherwise a retried refund would find nothing, read as a duplicate, and be
dropped.

**A refund does not overwrite `paystack_reference` or `paystack_payment_date`.**
Those record which payment was taken and when, and that stays true after it is
given back. The refund's own record is its `payment_events` row.

### Verification — 30/30

`drive-webhook.mjs` now runs the original 10, the 6 failure-injection cases from
§6a, and 14 refund checks: both reference spellings, pending and failed moving
nothing, partial reversal, a second partial refund applying rather than deduping
away, a replay not reversing twice, the clamp firing and being recorded, an
unresolvable reference going unmatched, no email fallback, the original payment
record surviving, and the mode invariant still refusing a test-signed live
refund.

**22/30 against `main` as it was**, the eight failures being exactly the cases
that require the new behaviour. The six refund checks that pass against the old
code are the "must not do anything" ones, which it satisfied by ignoring refunds
entirely — worth stating rather than counting as evidence.
