# Test Plan

Manual scenarios for the rebuilt site. The pre-rebuild plan tested the Price by Value waitlist, the
duplicate-prevention rules on `waitlist_signups`, the VIP alert and the daily digest — all of which
were retired on 10 August 2026. Nothing from it survived.

**Test against the build, never the source.** Includes resolve into `dist/` only, and links are
root-absolute, so opening a source file directly shows raw include comments and no styling:

```bash
npm run build && npx --yes http-server dist -p 8080 -c-1
```

---

## 1. Enrollment writes a real row

Open `/certified-automation-builder#enroll`, complete the form, and submit.

Expect: the form is replaced by the confirmed state without a page change. A row appears in
`enrollments` with `chosen_option` matching the option picked, `amount_ghs` matching the published
price, `payment_plan` as a boolean, `cohort = intermediate_2026_09`, `source = website`, and
**`consent_given = true`**.

`consent_given` defaults to false, so a form that fails to send it records no consent while the page
promises WhatsApp contact. Check it explicitly every time.

## 2. Enrollment rejects a duplicate

Submit the same email a second time for the same cohort. Expect a 409 and the message about already
holding a place — not a generic failure, and not a second row.

## 3. The roll cannot be read from the browser

With the site open, request `enrollments` using the anon key from the browser console or curl.
Expect `[]`, never data. Anon has insert-only RLS; a readable roll is a serious regression.

## 4. A build with no Supabase values refuses to ship

```bash
env -u SUPABASE_URL -u SUPABASE_ANON_KEY CF_PAGES=1 npm run build
```

Expect exit 1 and `Missing environment values`. Without `CF_PAGES` it must warn and continue, and
the form must then refuse politely and point at WhatsApp rather than posting into the void.

## 5. Paystack payment reaches the ledger

Once `paystack-webhook` is deployed, run a Paystack test charge for an email that exists in
`enrollments`.

Expect: a row in `payment_events` with `signature_valid = true` and `matched = true`; the matching
enrollment updated with `amount_paid_ghs`, `payment_status`, `paystack_reference` and
`paystack_payment_date`. Amounts are sent in minor units — GHS 750 arrives as 75000 — so confirm
`amount_ghs` reads 750, not 75000.

## 6. A replayed webhook does not double-charge

Resend the same Paystack event. Expect a 200 response, **no second `payment_events` row**, and
`amount_paid_ghs` unchanged. Paystack retries on any non-2xx, so this guard is what stops a retry
being counted as a second payment.

## 7. A forged webhook is recorded and ignored

POST an unsigned or wrongly-signed body to the function URL. Expect a `payment_events` row with
`signature_valid = false`, and **no change to any enrollment**. The attempt must be logged, not
silently dropped.

## 8. Instalments accumulate

For an enrollment with `payment_plan = true`, apply two payments (GHS 400, then GHS 350). Expect
`amount_paid_ghs` to reach 750 and `payment_status` to move `partially_paid` → `paid`. If the second
payment replaces the first rather than adding to it, the accumulation logic has regressed.

## 9. /thank-you shows a reference and writes nothing

Open `/thank-you?reference=TEST_ABC123`. Expect the reference displayed. Then open
`/thank-you?reference=<script>alert(1)</script>` and `/thank-you?status=success` — expect no script
execution, no reference shown for a malformed value, and **no database write of any kind**. The
browser is not in the payment path.

## 10. Admin sign-in and the roll

Sign in at `/admin` with the Supabase Auth admin account. Expect the seat board, the money figures,
the queues and the roll to populate. Confirm a wrong password fails, and that signing out clears the
session.

If it signs in but the roll is empty, the `authenticated` select policy does not match the account's
email.

## 11. Admin edits save

Open an enrollment, change payment status and amount paid, save. Expect the change to persist after
a refresh, and the seat board and queues to recompute.

## 12. 404 returns a real 404

Request a path that does not exist. Expect the 404 page **and an HTTP 404 status** — not 200. A
catch-all that returns 200 tells search engines every mistyped URL is a real page.

```bash
curl -o /dev/null -w '%{http_code}\n' https://training.bulletproofautomations.com/does-not-exist
```

## 13. Every internal link resolves

**Do not rely on the CI link check.** It runs with `--base-url` pointing at production, which
answers 200 for every path, so it cannot fail on a missing route. List `dist/` against the links
instead:

```bash
grep -rho 'href="/[^"#]*"' dist --include='*.html' | sed 's/href="//;s/"//' | sort -u
```

## 14. Placeholders and terminology

No page ships with a visible `[PLACEHOLDER]`. Audit copy against the terminology table in
`CLAUDE.md` — no "Beginner Certificate", no "n8n certification", no "coming soon", no pricing that
implies the credential is bought. Confirm the independence statement is in every footer, and the
non-guarantee wording on every page mentioning the hiring standard.

## 15. Responsive, keyboard and motion

Check every built route at **360px**, 768px and 1280px. Nothing may scroll horizontally; wide tables
scroll inside their own container. Tab through each page: focus must be visible at every stop, and
the skip link must work. With `prefers-reduced-motion: reduce` set, animated elements must show
their finished state — never missing content.
