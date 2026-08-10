# Operational Notes

## Current Hosting

- Production site: `https://training.bulletproofautomations.com`
- Hosting provider: Cloudflare Pages
- DNS provider: Namecheap
- GitHub repo: `Exnav29/bulletproofautomations-training`
- Production branch: `main`
- Build command: `npm run build`
- Output directory: `dist`

## Do Not Do

- Do not reconnect Netlify.
- Do not deploy the repository root.
- Do not use `npx wrangler deploy` for this site.
- Do not upload `.git`, `.github`, `.wrangler`, `supabase`, SQL setup files, README/docs, test plans, or backend/dev files.

## Deployment Flow

1. GitHub `main` branch
2. `npm run build`
3. `dist/`
4. Cloudflare Pages
5. Namecheap CNAME for `training`
6. `training.bulletproofautomations.com`

## Recovery Notes

The site was previously hosted on Netlify. Netlify was removed because it was consuming credits/limits.

A broken Netlify 404 means DNS is still pointing to Netlify or the custom domain is not attached to Cloudflare Pages.

## The catch-all 404 (open, 10 August 2026)

Production currently answers **HTTP 200 with the homepage for every unmatched path**, including ones
that have never existed:

```
/standard                     -> 200, old homepage
/nonsense-does-not-exist      -> 200, old homepage
```

`_redirects` did not exist in the repo before 10 August 2026, so this comes from **outside the
build** — most likely a `/*` catch-all left over from the Netlify era, in Cloudflare's Redirect
Rules or the Pages project settings. Check there.

Two consequences, both bad. Search engines are told every mistyped URL is a real page. And the CI
link check runs with `--base-url` pointing at production, so it can never fail on a missing route —
its green tick is meaningless until this is fixed.

`404.html` now ships at the root of `dist/`, which is where Cloudflare Pages looks. **While the
catch-all exists it wins and that file is never reached.** After the next deploy, confirm with a
status code rather than by eye:

```bash
curl -o /dev/null -w '%{http_code}
' https://training.bulletproofautomations.com/does-not-exist
```

Fix it by confirming the Cloudflare Pages custom domain setup and the Namecheap CNAME target for `training`.
