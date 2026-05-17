# Bulletproof Automations Training

Standalone static site for `https://training.bulletproofautomations.com`.

This project is separate from the live Bulletproof Automations main website at `https://bulletproofautomations.com`. Do not deploy this repository over the main website, do not reuse the main website Cloudflare Pages project, and do not modify the main site navigation from here.

The only required connection is an outbound navigation link from this training site to:

`Main Site -> https://bulletproofautomations.com`

The main website can later add:

`Training -> https://training.bulletproofautomations.com`

## Routes

- `/` training hub homepage
- `/price-by-value` workshop landing page and waitlist form
- `/thank-you` post-signup confirmation page
- `/admin` private waitlist admin dashboard

## Stack

- Cloudflare Pages for the static frontend
- Supabase Free for database, auth, and edge functions
- Resend Free for confirmation, VIP alert, and digest emails
- GitHub Actions for the daily digest cron trigger

## Configuration

Frontend JavaScript may only use:

- Supabase project URL
- Supabase anon public key

Private keys belong only in Supabase Edge Function secrets or GitHub Actions secrets.

See [README_DEPLOYMENT.md](README_DEPLOYMENT.md) for setup steps.
