# Test Plan

## Regular signup

Open `/price-by-value`, submit all required fields with VIP interest set to `No`, and verify the row is created with `status = New`, `ticket_type = Waitlist`, and `payment_status = Unpaid`.

## Duplicate signup

Submit the same email or WhatsApp number again for `price-by-value`. Verify no duplicate row is created and the user sees the already-on-waitlist message.

## VIP signup

Submit a signup with VIP interest set to `Yes`. Verify the row is created and the `vip-alert` function sends an owner notification.

## Source URL signup

Open `/price-by-value?source=linkedin`, submit a signup, and verify `source = linkedin`. Repeat without a source and verify `source = direct`.

## Admin login

Open `/admin`, sign in with a Supabase Auth admin user, and verify dashboard stats and signup rows load.

## Admin status update

Open a signup detail modal, update status, ticket type, payment status, amount paid, payment reference, payment method, and notes. Save and verify the row updates in Supabase.

## CSV export

Apply filters and export CSV. Verify exported rows match the filtered table.

## Daily digest function

Trigger `.github/workflows/daily-digest.yml` manually and confirm the owner email includes total signups, today's signups, VIP counts, paid seats, seats remaining, source breakdown, price range breakdown, and today's pricing challenges.

## Mobile responsiveness

Check `/`, `/price-by-value`, `/thank-you`, and `/admin` on a mobile viewport. Verify navigation, form fields, tables, and buttons remain usable without overlap.
