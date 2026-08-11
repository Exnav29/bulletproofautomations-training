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
   into waitlist_signups from n8n-foundations/index.html. The admin dashboard and
   the remaining Edge Functions read these. (price-by-value/index.html was deleted
   on 10 August 2026 when that workshop was retired.)
4. The daily digest is gone. .github/workflows/daily-digest.yml was deleted on
   10 August 2026 at the owner's request — the morning report is no longer wanted.
   Do not reinstate it.
5. Keep the site framework-free and build-free: plain HTML/CSS/JS, folder-based
   routes (route/index.html). Do not introduce bundlers, npm dependencies for the
   site itself, or a build command.
6. All changes must be backward-compatible until explicitly told otherwise.
   Prefer additive changes. One concern per PR.
7. Do not resize, rename, or delete files under assets/ unless the task says to.
8. supabase-setup.sql must remain idempotent (safe to re-run).
