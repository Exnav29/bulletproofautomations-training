# Bulletproof Automations Training

## Project Overview

This repository contains the Bulletproof Automations training website for `https://training.bulletproofautomations.com`.

It is a plain static HTML/CSS/JavaScript site with pages for training programs, the Price by Value waitlist, thank-you/admin routes, and an NFC lead-capture plus resources flow.

This project is separate from the main Bulletproof Automations website at `https://bulletproofautomations.com`.

## Site Structure / Routes

- `/` - training hub homepage
- `/price-by-value` - Price by Value workshop landing page and waitlist form
- `/n8n-automation-builder-pathway` - n8n training pathway overview
- `/n8n-foundations` - n8n Foundations cohort page and interest list
- `/thank-you` - post-signup confirmation page
- `/admin` - private waitlist admin dashboard
- `/nfc` - NFC lead-capture entry page
- `/nfc/resources` - post-submit resource hub

Routes are folder-based, using files like `route/index.html`.

## NFC Lead Capture Flow

The NFC flow is used by NFC cards and NFC-enabled coffee cups.

1. A visitor taps the NFC item and opens `/nfc`.
2. The visitor submits their name, email, optional phone/WhatsApp, what they are looking for, and optional email opt-in.
3. The form posts to the n8n webhook configured in `nfc/index.html`.
4. n8n creates an Airtable lead record for every submission.
5. If email opt-in is checked, n8n creates a Hostinger Reach contact.
6. n8n updates Airtable Reach Status after successful Reach contact creation.
7. The visitor is redirected to `/nfc/resources`.

## Campaign Tracking

The `/nfc` page supports a `campaign` query parameter that overrides the hidden campaign field.

- Coffee cup: `/nfc?campaign=n8n-ambassador-cup`
- NFC card: `/nfc?campaign=n8n-ambassador-card`
- Default campaign: `n8n-ambassador`

The `source` field remains `nfc-card`, and `entry_page` remains `/nfc`.

## NFC Resources Page

`/nfc/resources` links to:

- n8n training registration
- n8n community resources
- GitHub profile
- Bulletproof Automations homepage
- ScriptureFlow demo app
- ScriptureFlow developer pages
- downloadable vCard
- Calendly booking page

The downloadable vCard is stored at `assets/johnathan-lightfoot.vcf`.

## Integrations

At a high level, the site connects to:

- n8n self-hosted workflow for NFC form submissions
- Airtable base/table for lead logging
- Hostinger Reach for opted-in contacts
- Supabase and Resend for the existing training waitlist system
- GitHub Actions for the existing daily digest trigger

Do not commit API tokens, Airtable credentials, Hostinger credentials, Supabase service role keys, Resend keys, or other private secrets.

## Development / Deployment Notes

This appears to be a static site suitable for static hosting such as Cloudflare Pages.

There is no framework or build system required for the current pages. Shared styling lives in `assets/css/style.css`, shared JavaScript lives in `assets/js/main.js`, and standalone pages may include page-local CSS when needed.

Frontend JavaScript may only use public browser-safe values. Private keys belong only in backend services, Supabase Edge Function secrets, or GitHub Actions secrets.

See [README_DEPLOYMENT.md](README_DEPLOYMENT.md) for deployment setup notes.

## Privacy / Consent Note

All NFC form submissions are logged to Airtable.

Only visitors who explicitly check the email opt-in box are added to Hostinger Reach.
