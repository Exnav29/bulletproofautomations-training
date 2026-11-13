-- Graduate webinar access belongs to the completed training record; after certificate
-- issuance, the join supplies the actual immutable certificate ID automatically.
-- This avoids inventing a certificate ID before Studio has approved and issued it.
create table if not exists private.studio_graduate_webinar_entitlements (
  graduate_id uuid primary key references private.studio_graduates(id) on delete restrict,
  entitlement_code text not null default 'graduate_webinars'
    check (entitlement_code = 'graduate_webinars'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  notes text not null default 'Complimentary access to upcoming graduate webinars'
);
alter table private.studio_graduate_webinar_entitlements enable row level security;
revoke all on table private.studio_graduate_webinar_entitlements from public, anon, authenticated;

-- Read internally by certificate ID after issuance. Unissued graduates remain
-- pending; revocations deactivate the eligibility. No public API or PII release.
create or replace view private.studio_graduate_webinar_entitlements_by_certificate
with (security_invoker = true) as
select
  w.graduate_id,
  g.credential_id,
  g.data ->> 'full_name' as holder_name,
  w.entitlement_code,
  case
    when c.issuance_state = 'issued' and c.status = 'valid'
      and g.state = 'issued' then 'active'
    else 'pending_issuance'
  end as entitlement_status,
  w.created_at,
  w.notes
from private.studio_graduate_webinar_entitlements w
join private.studio_graduates g on g.id = w.graduate_id
left join public.credentials c on c.credential_id = g.credential_id;
revoke all on private.studio_graduate_webinar_entitlements_by_certificate from public, anon, authenticated;
comment on table private.studio_graduate_webinar_entitlements is 'Graduate webinar benefits for Studio graduates, joined to official certificate ID on issuance.';
