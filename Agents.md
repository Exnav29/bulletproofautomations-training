# Agent Guidelines for this Repository

This is a PRODUCTION static site deployed to Cloudflare Pages at
training.bulletproofautomations.com. Merging to main deploys immediately.

Hard rules:
1. NEVER commit secrets. The only credentials allowed in frontend code are the
   Supabase project URL and anon public key already present in assets/js/main.js.
2. NEVER change the form field `name` attributes, hidden input values, or the
   action URL in nfc/index.html — an external n8n workflow depends on them exactly
   as they are (field names: name, email, phone, looking_for, email_opt_in,
   source, campaign, entry_page; action: the n8n.bulletproofautomations.com webhook).
3. NEVER change column names in supabase-setup.sql or the payload keys inserted
   into waitlist_signups from price-by-value/index.html and n8n-foundations/index.html.
   The admin dashboard, three Edge Functions, and the daily digest all read these.
4. NEVER modify .github/workflows/daily-digest.yml behavior (cron 0 10 * * *,
   secrets SUPABASE_DAILY_DIGEST_URL and SUPABASE_SERVICE_ROLE_KEY) unless the
   task explicitly says to.
5. Keep the site framework-free and build-free: plain HTML/CSS/JS, folder-based
   routes (route/index.html). Do not introduce bundlers, npm dependencies for the
   site itself, or a build command.
6. All changes must be backward-compatible until explicitly told otherwise.
   Prefer additive changes. One concern per PR.
7. Do not resize, rename, or delete files under assets/ unless the task says to.
8. supabase-setup.sql must remain idempotent (safe to re-run).
