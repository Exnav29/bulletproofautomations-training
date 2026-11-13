# Graduate webinar entitlement linked to Certificate Studio

The internal `private.studio_graduate_webinar_entitlements` table grants complimentary access to upcoming Bulletproof Automations graduate webinars. Each entitlement is recorded against one **Studio graduate ID** before issuance. The `private.studio_graduate_webinar_entitlements_by_certificate` view automatically resolves the official `BPA-TRN-YYYY-XXXXXX` identifier once the approved Studio issuance process assigns it.

## Lifecycle and verification

- Before issuance: `credential_id = NULL`, `entitlement_status = pending_issuance`.
- After the approved signed PDF, archive and public credential become valid and `studio_graduates.state = issued`: status becomes `active`, linked to the immutable certificate ID.
- If the credential becomes revoked, status returns to `pending_issuance`. This is a safety default; future product rules can introduce an explicit suspended/revoked entitlement status.
- No entitlement automatically confers BCAB certification or includes paid certification assessment fees.
- No expiration or number of webinars is defined. Confirm registration mechanics before each event.
- The table and view are private and have no `anon` or `authenticated` privileges. Do not expose an open enumeration endpoint.

### Internal certificate-ID check

```sql
select credential_id, holder_name, entitlement_code, entitlement_status
from private.studio_graduate_webinar_entitlements_by_certificate
where credential_id = :certificate_id;
```

A successful result with `entitlement_status = active` authorizes complimentary graduate webinar access. Do not rely solely on a QR code; verify the ID through the official credential register before admitting an attendee.

## Issuance checklist

1. Confirm tuition and completion requirements independently.
2. Confirm **new** public certificate and exact-name-lookup consent; `public.enrollments.consent_given` covers WhatsApp cohort contact, **not** public credential lookup. Prior Foundations publication consent is not automatically consent for another certificate.
3. Review each unsigned Studio proof against the final spelling, dates and course wording.
4. Only then approve and issue, which allocates IDs and generates signed, archived PDF/PNG.
5. Verify the official QR-code URL, the ID search, and (where authorized) the exact-name search which should show Foundations and Intermediate.
6. Confirm `active` entitlement by the issued certificate ID.
7. Send a **personalized** email to each graduate from `johnathan@bulletproofautomations.com`, each with only their matching official PDF attached, after verification and explicit send approval. Reconcile any uncertain delivery before retrying.
8. Keep BCAB prepaid-assessment status separate; completion certificates do not imply BCAB award.

This migration does not issue certificates, approve PDFs, expose private data, or send mail.
