-- The production records the workshop benefits read, reduced to the columns
-- they use: the public credential register, Certificate Studio graduates, and
-- PR #54's graduate webinar entitlement table and view (verbatim). Test data
-- only; nothing here is applied anywhere but the test database.
create schema if not exists private;
create table if not exists auth.users (id uuid primary key);

create table if not exists public.credentials (
  id uuid primary key default gen_random_uuid(),
  credential_id text not null unique,
  holder_name text not null,
  holder_email text,
  credential text not null,
  issued_on date not null default current_date,
  expires_on date,
  status text not null default 'valid',
  issuance_state text not null default 'issued',
  enrollment_id uuid
);

create table if not exists private.studio_graduates (
  id uuid primary key default gen_random_uuid(),
  data jsonb not null default '{}'::jsonb,
  credential_id text,
  state text not null default 'draft'
);
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
