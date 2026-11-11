# Paystack business review: private webinar demonstration

This branch exists to exercise the existing workshop platform in the Cloudflare Pages Preview (Paystack test mode), without touching production checkout.

- Demo session slug: `customer-enquiry-automation-webinar`
- Public-facing title: Automate Customer Enquiries with n8n: From First Message to Follow-Up
- Test price: GHS 10.00
- Scheduled for display: 10 December 2026 at 11:30 GMT (150 minutes)
- Source of content: the existing `workshop_sessions` database row marked `is_test=true`
- Page: `/workshops/customer-enquiry-automation-webinar/`
- Administration: `/admin/workshops/`
- When filming for Paystack, disclose that this is an example workshop and test-mode payment/refund. Do not claim a real event occurred.
- Do not record live credentials, secret keys, customer data, private attendee details or actual personally identifiable data.
- The admin allows **Delete** only with no registrations or waitlist entries. After test payments, **Cancel workshop** is the safe cleanup path; retain payment/refund records for traceability.
- Refund money in the Paystack Webinars **Test** dashboard, not through the internal admin's **Request refund**, which records intent only.
- This branch is temporary and should not merge into `main`.

No production keys or customer records are stored here.
