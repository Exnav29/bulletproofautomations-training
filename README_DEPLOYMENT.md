# Deployment Guide

## 1. Create the Supabase project

Create a new Supabase project for the training subdomain. Do not reuse production resources from the main Bulletproof Automations website unless you intentionally want shared infrastructure.

## 2. Run the SQL setup

Open the Supabase SQL editor and run `supabase-setup.sql`. This creates `waitlist_signups`, duplicate-prevention indexes, constraints, and RLS policies.

When deploying updates to the n8n Foundations interest list, rerun `supabase-setup.sql` so the existing `waitlist_signups` table has `interested_class`, `preferred_setup`, and the expanded experience-level constraint.

## 3. Find Supabase URL and anon key

In Supabase, go to Project Settings -> API and copy:

- Project URL
- anon public key

## 4. Update frontend config

Edit `assets/js/main.js` and replace:

- `https://YOUR_PROJECT_REF.supabase.co`
- `YOUR_SUPABASE_ANON_PUBLIC_KEY`

Never place the service role key in frontend code.

## 5. Create a Supabase Auth admin user

Create an admin user in Supabase Auth. The `/admin` dashboard signs in with Supabase Auth only. There is no fallback password.

For stronger production access control, restrict the authenticated RLS policies in `supabase-setup.sql` to your admin user UUID.

## 6. Create or use a Resend account

Create a Resend account or use an existing one.

## 7. Verify the sending domain

Verify `bulletproofautomations.com` in Resend and configure the DNS records Resend provides. Use a sender such as `training@bulletproofautomations.com`.

## 8. Set Supabase Edge Function secrets

Set these in Supabase for the functions:

- `PROJECT_URL`
- `SERVICE_ROLE_KEY`
- `RESEND_API_KEY`
- `FROM_EMAIL`
- `OWNER_EMAIL`

## 9. Deploy Supabase Edge Functions

Deploy:

- `confirm-email`
- `vip-alert`

Example:

```bash
supabase functions deploy confirm-email
supabase functions deploy vip-alert
```

`daily-digest` is **retired**. Its GitHub Actions trigger was deleted on 10 August 2026 and the
morning report has stopped. The function source is kept only as a record of what is still
deployed on the old Supabase project; delete it from that dashboard to remove it entirely.

Redeploy `confirm-email` after n8n Foundations interest-list changes so confirmation emails include the new class fields.

## 10. Deploy the static site to Cloudflare Pages

Create a new Cloudflare Pages project connected to this standalone training repo.

- Build command: `npm run build`
- Output directory: `dist`
- Project: separate from the main website

The build copies only browser-public files into `dist`. Do not deploy the repository root.
This is a static HTML site with no framework preset.

## 11. Add the custom domain

Add `training.bulletproofautomations.com` to the Cloudflare Pages project.

DNS for `bulletproofautomations.com` is managed at Namecheap. Point the `training` DNS record to Cloudflare Pages, not Netlify. Do not use a Worker custom domain for this site, and do not change the existing `bulletproofautomations.com` deployment.

## 12. Add GitHub Actions secrets

Add repository secrets:

- `SUPABASE_DAILY_DIGEST_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

These GitHub Actions secret names can keep the `SUPABASE_` prefix. The reserved-prefix restriction applies to Supabase Edge Function custom secrets, where this project uses `PROJECT_URL` and `SERVICE_ROLE_KEY`.

## 13. The daily digest (removed)

Deleted on 10 August 2026 at the owner's request. `.github/workflows/daily-digest.yml` was the
only trigger — there is no `pg_cron` job — so removing it stopped the 10:00 AM report. Nothing
here needs running. The Edge Function remains deployed on the old Supabase project until it is
deleted from that dashboard.

## 14. Test the enrollment flow

Use `/certified-automation-builder#enroll`, submit a reservation, and confirm the row lands in
`public.enrollments` on the current project with `consent_given` true. Verify `/admin` login and
CSV export — note that `/admin` still reads `waitlist_signups` on the **old** project and has yet
to be repointed.

The Price by Value waitlist flow it replaced was retired on 10 August 2026 along with
`/price-by-value` and the old `/thank-you` page.

## 15. Validate the deployment output

Run:

```bash
npm run build
```

Confirm `dist` contains the public site files and route folders:

- `index.html`
- `assets/`
- `admin/`
- `nfc/`
- `n8n-foundations/`
- `n8n-automation-builder-pathway/`
- `certified-automation-builder/`
- `standard/`
- `_redirects`
- `robots.txt`
- `sitemap.xml`

Confirm `dist` does not contain `.git`, `.github`, `.wrangler`, `supabase`, `supabase-setup.sql`, README/deployment docs, test plans, gitleaks config, or backend/dev files.

## Environment variables (required)

The Supabase values are injected into the bundle at build time. They are not committed —
source files carry `__SUPABASE_URL__` / `__SUPABASE_ANON_KEY__` tokens, and `scripts/build.js`
substitutes them while writing `dist/`.

Set both in the Cloudflare Pages project, under **Settings -> Environment variables**:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | The training project URL, `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | The anon/public key for that project |

**Set them for Production *and* Preview.** Cloudflare keeps the two scopes separate, and the
build guard fires in both. Setting only Production leaves every pull-request preview build
failing, which is what makes a red check on an open PR look like a code problem when it is not.

Newer Supabase projects label this key **publishable** and issue it in the `sb_publishable_…`
form rather than the older `eyJ…` JWT. Either works — `SUPABASE_ANON_KEY` is just the name this
build gives whatever public key the project hands out.

The anon key is public by design — it reaches the browser either way — and row-level security
limits it to inserting into `public.enrollments`. It cannot read the roll or mark anyone paid.

**A production build with either value missing fails.** `scripts/build.js` exits non-zero when
`CF_PAGES` is set and the values are absent, because a deploy that silently shipped a dead
enrollment form would cost seats. This is the guard working, not a bug — the fix is always to
supply the variables, never to relax the check. To reproduce a Cloudflare build locally,
including the guard:

```bash
CF_PAGES=1 npm run build      # passes only when both values are resolvable
``` Locally, and in CI — which only validates HTML and has no
business holding secrets — the build warns instead and the form politely refuses, directing
visitors to WhatsApp.

For local development, put the same two values in a `.env` at the repo root. It is gitignored.
See `.env.example`.
