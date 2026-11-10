# Local integration stack (non-production)

Runs the webinar journey end to end on one machine, with no real service involved:

- **Browser:** real Chromium (Playwright).
- **Pages Functions:** the real ones, under `wrangler pages dev`, on :8788. A second instance on
  :8789 is wired to the mail stand-in.
- **Database:** real SQL in PGlite, with production's ledger schema (`tests/fixtures/payment-ledger.sql`)
  and the workshop migration. Seeded with two test sessions and a part-paid cohort student who uses
  the **same email** as the webinar tester.
- **Webhook:** the webinar business's own webhook (`supabase/functions/workshop-paystack-webhook/index.ts`). The training webhook (v9) is not involved.
- **Paystack and the mail API:** local stand-ins. They are not the real services and prove nothing
  about them.

```bash
# 1. Build the fixture pages with local values (never deployed)
WORKSHOP_CONTENT_DIR=tests/fixtures/workshops SUPABASE_URL=http://127.0.0.1:54350 \
  SUPABASE_ANON_KEY=local-anon TURNSTILE_SITE_KEY=local npm run build

# 2. Database, Paystack stand-in, webinar webhook, mail stand-in, state endpoint
deno run --node-modules-dir=none -A tests/local-stack/stack.ts &

# 3. The real Pages Functions (wrangler 4.x)
B="--binding SUPABASE_URL=http://127.0.0.1:54350 --binding SUPABASE_SERVICE_ROLE_KEY=local-service-role \
   --binding WORKSHOP_PAYSTACK_SECRET_KEY=sk_test_webinar_local_stack_000000000000000000 \
   --binding WORKSHOP_PAYSTACK_API_BASE=http://127.0.0.1:54351 \
   --binding PAYSTACK_SECRET_KEY=sk_test_training_business_local_never_used_00"
npx wrangler pages dev dist --port 8788 --ip 127.0.0.1 $B &
npx wrangler pages dev dist --port 8789 --ip 127.0.0.1 --inspector-port 9230 $B \
  --binding HOSTINGER_MAIL_API_TOKEN=local-mail-token --binding MAIL_API_BASE=http://127.0.0.1:54353 &

# 4. The journeys (prints PASS/FAIL per check; exits non-zero on failure)
node tests/local-stack/journey.js /tmp/journey-shots
```

`WORKSHOP_PAYSTACK_API_BASE` is honoured only under a test key, and `MAIL_API_BASE` only for
127.0.0.1/localhost, so neither can redirect real payments or real email.

## Release 2: the five workshop 01 prices in the browser

The same stack with release 2 applied and the workshop 01 rehearsal session seeded from
`docs/workshops-rehearsal/rehearsal-what-to-charge.json` (a test session, because wrangler holds a
test key). The certificate records are made up: two Foundations holders and two Intermediate
graduates with fees paid. The referral code `KWAME50` is issued as `prepared`, exactly as the admin
would issue it.

```bash
WORKSHOP_CONTENT_DIR=docs/workshops-rehearsal SUPABASE_URL=http://127.0.0.1:54350 \
  SUPABASE_ANON_KEY=local-anon TURNSTILE_SITE_KEY=local npm run build
RELEASE2=1 deno run --node-modules-dir=none -A tests/local-stack/stack.ts &
npx wrangler pages dev dist --port 8789 --ip 127.0.0.1 --inspector-port 9231 $B \
  --binding HOSTINGER_MAIL_API_TOKEN=local-mail-token --binding MAIL_API_BASE=http://127.0.0.1:54353 &
node tests/local-stack/journey-release2.js /tmp/release2-shots
```

It runs GHS 350, 300 (link and typed code), 280, 280 with a referral, and the free graduate place
through the real form, with the codes read from the mail stand-in. It then runs the dispatcher and
opens the real `/admin/workshops/`, signed in through a local stand-in for Supabase Auth. The admin
context bypasses CSP only because production's policy names `*.supabase.co`, not `127.0.0.1`. The
checks cover the reports, the invitation list and a refused test payout. Restart the stack between
runs: the database lives in memory.
