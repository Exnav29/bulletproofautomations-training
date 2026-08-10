# Deployment Checklist

Run through this before merging to `main`. **Merging deploys immediately.**

## Build

- [ ] `npm run build` succeeds and reports the expected path count
- [ ] Every new route is in `publicPaths` — a missing one works locally and 404s in production
- [ ] `npx html-validate "dist/**/*.html"` is clean
- [ ] `sitemap.xml` lists every built public route
- [ ] Checked through `dist/`, not the source — includes only resolve in the build

## Content

- [ ] **No visible `[PLACEHOLDER]` anywhere.** Nothing ships with one
- [ ] Terminology audited against the table in `CLAUDE.md`
- [ ] Independence statement in every footer
- [ ] Non-guarantee wording on every page mentioning the hiring standard
- [ ] Training and certification described as separate products wherever BCAB appears
- [ ] No pricing phrased as buying the credential
- [ ] No invented dates, prices, testimonials or statistics

## Routes

- [ ] Home page loads at `/`
- [ ] `/certified-automation-builder`, `/standard`, `/thank-you` load
- [ ] `/price-by-value` 301s to `/` (workshop retired 10 August 2026)
- [ ] An unknown path returns the 404 page **with an HTTP 404 status, not 200**
- [ ] Every internal link resolves — checked by listing `dist/`, not by the CI link check

## Enrollment

- [ ] `SUPABASE_URL` and `SUPABASE_ANON_KEY` set on Cloudflare Pages for **Production and Preview**
- [ ] Enrollment form submits and writes a row with `consent_given = true`
- [ ] Duplicate enrollment returns the already-reserved message, not a second row
- [ ] Anon cannot read the roll back — returns `[]`

## Payments

- [ ] `paystack-webhook` deployed with `--no-verify-jwt`
- [ ] `PAYSTACK_SECRET_KEY`, `PROJECT_URL`, `SERVICE_ROLE_KEY` set as Edge Function secrets
- [ ] Paystack webhook URL points at the function
- [ ] A test charge lands in `payment_events` with `signature_valid = true` and updates the roll
- [ ] A replayed event does not double-count
- [ ] An unsigned request is logged and applies nothing

## Admin

- [ ] Admin signs in with Supabase Auth and the roll populates
- [ ] Public sign-up is **disabled** on the Supabase project
- [ ] Edits save and persist
- [ ] CSV export works

## Quality

- [ ] 360px, 768px, 1280px — nothing scrolls horizontally
- [ ] Keyboard-only pass: visible focus everywhere, skip link works
- [ ] `prefers-reduced-motion` shows finished states, never missing content
- [ ] Main Site link opens `https://bulletproofautomations.com`
- [ ] The main website remains untouched
