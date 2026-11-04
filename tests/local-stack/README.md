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
