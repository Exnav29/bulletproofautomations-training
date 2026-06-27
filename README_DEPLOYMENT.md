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
- `daily-digest`

Example:

```bash
supabase functions deploy confirm-email
supabase functions deploy vip-alert
supabase functions deploy daily-digest
```

Redeploy `confirm-email` and `daily-digest` after n8n Foundations interest-list changes so confirmation emails and the 10:00 AM GMT digest include the new class fields.

## 10. Deploy the static site to Cloudflare Pages

Create a new Cloudflare Pages project connected to this standalone training repo.

- Build command: blank
- Output directory: `/`
- Project: separate from the main website

## 11. Add the custom domain

Add `training.bulletproofautomations.com` to the Cloudflare Pages project.

Do not change the existing `bulletproofautomations.com` deployment.

## 12. Add GitHub Actions secrets

Add repository secrets:

- `SUPABASE_DAILY_DIGEST_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

These GitHub Actions secret names can keep the `SUPABASE_` prefix. The reserved-prefix restriction applies to Supabase Edge Function custom secrets, where this project uses `PROJECT_URL` and `SERVICE_ROLE_KEY`.

## 13. Manually trigger the daily digest

In GitHub Actions, open `Daily Waitlist Digest` and run `workflow_dispatch`.

The scheduled digest runs at 10:00 AM GMT / UTC and groups signups by workshop/class.

## 14. Test the full waitlist flow

Use `/price-by-value?source=manual-test`, submit a signup, confirm redirect to `/thank-you`, confirm the database row exists, confirm email delivery, test VIP alert with VIP interest set to `Yes`, and verify `/admin` login and CSV export.
