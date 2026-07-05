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

Fix it by confirming the Cloudflare Pages custom domain setup and the Namecheap CNAME target for `training`.
