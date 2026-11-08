-- ---------------------------------------------------------------------------
-- Workshop release 2: admission by Google Calendar invitation (part 1) and
-- prices, certificate benefits, reserved graduate places and referrals (part 2).
-- Applied as ONE migration with ONE rollback.
--
-- Part 1. Admission by Google Calendar invitation.
--
-- Additive only: new nullable or defaulted columns on two workshop tables and
-- new functions. Nothing outside the workshop_* tables is written, and no
-- trigger is added to the payment path.
--
-- A session with admission = 'invite' is joined only by Google accounts on its
-- Google Calendar event (calendar_event_id, an event that already exists on
-- the host's calendar; nothing here creates one). Per registration:
--   attend_email   the Google account the participant asked us to invite
--   invited_email  the account that is on the event right now
-- What to do next is derived, never stored:
--   to invite  status = 'confirmed' and attend_email is distinct from invited_email
--   to remove  invited_email is not null and (status <> 'confirmed' or attend_email is distinct from invited_email)
-- so a refund, cancellation or change of account surfaces as a removal without
-- anything in the payment path having to remember it.
-- ---------------------------------------------------------------------------

alter table public.workshop_sessions
  add column if not exists admission text not null default 'link'
    check (admission in ('link', 'invite')),
  -- Private, like join_instructions: anon and authenticated have no grant on this table.
  add column if not exists calendar_event_id text
    check (calendar_event_id is null or calendar_event_id ~ '^[A-Za-z0-9_]{5,1024}$');

alter table public.workshop_registrations
  add column if not exists attend_email text
    check (attend_email is null or (attend_email = lower(btrim(attend_email)) and attend_email like '%_@_%')),
  add column if not exists invited_email text
    check (invited_email is null or (invited_email = lower(btrim(invited_email)) and invited_email like '%_@_%')),
  add column if not exists invited_at timestamptz,
  add column if not exists invite_removed_at timestamptz;

-- Called by /api/workshops/register right after a registration is created.
-- First write wins: re-submitting the form with somebody else's payment email
-- cannot redirect their invitation. Later changes go through the admin.
create or replace function public.workshop_set_attend_email(p_registration_id uuid, p_email text)
returns void language sql security definer set search_path = '' as $$
  update public.workshop_registrations
     set attend_email = lower(btrim(p_email))
   where id = p_registration_id
     and attend_email is null
     and lower(btrim(p_email)) like '%_@_%';
$$;

-- workshop_admin_admission is defined in part 2, where it also knows about
-- complimentary graduate places.


revoke all on function public.workshop_set_attend_email(uuid, text) from public, anon, authenticated;
grant execute on function public.workshop_set_attend_email(uuid, text) to service_role;

-- ===========================================================================
-- Part 2. Prices, certificate benefits, reserved graduate places, referrals.
--
-- Advertised price: workshop_sessions.price_ghs (GHS 350). One discount at most,
-- never stacked; the customer gets the larger:
--   referral     referral_discount_ghs off (GHS 50), from an eligible graduate's code
--   foundations  foundations_discount_pct off (20% = GHS 70), verified certificate
--   graduate     free (graduate_free), verified certificate, reserved place
-- A valid referral is kept for attribution even when the Foundations discount is
-- larger, and earns referral_commission_ghs (GHS 50) on a paid, confirmed sale.
-- A graduate's own free place carries no referral and no commission.
--
-- Certificate benefits need more than an ID and an email (certificate IDs are
-- public). The holder asks for a one-time code, which goes ONLY to the email
-- recorded on the certificate (or to an address the admin authorised for that
-- certificate and session, for a holder whose address changed). The code
-- expires in 10 minutes and allows 5 tries; a correct code yields a 30-minute,
-- single-use token that registration consumes. One redemption per certificate
-- per session, enforced under the session lock and by a unique index.
--
-- Read, never written: public.credentials (the certificate register) and PR
-- #54's private.studio_graduate_webinar_entitlements_by_certificate.
--
-- Capacity: capacity = the GENERAL places (25); graduates count only against
-- reserved_graduate_seats (5); 30 in all. Reserved places are never released.
--
-- Prices are snapshotted on the registration (list price, discount and kind,
-- price charged, commission). Checkout charges the snapshot; any other amount
-- is a mismatch held for review. Commission is DERIVED from the snapshot and
-- the payment state, never stored as owed; only a manual payout is recorded.
-- ===========================================================================

alter table public.workshop_sessions
  add column if not exists foundations_discount_pct integer not null default 0
    check (foundations_discount_pct between 0 and 100),
  add column if not exists graduate_free boolean not null default false,
  add column if not exists reserved_graduate_seats integer not null default 0
    check (reserved_graduate_seats >= 0),
  add column if not exists referral_discount_ghs numeric(10,2) not null default 0
    check (referral_discount_ghs >= 0),
  add column if not exists referral_commission_ghs numeric(10,2) not null default 0
    check (referral_commission_ghs >= 0);

create table if not exists public.workshop_referrers (
  id uuid primary key default gen_random_uuid(),
  -- A public code. Never a certificate number or any private identifier.
  code text not null unique check (code ~ '^[A-Z0-9]{4,16}$'),
  credential_id text not null unique,
  status text not null default 'active' check (status in ('active', 'suspended')),
  expires_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  notes text
);

alter table public.workshop_registrations
  add column if not exists price_tier text not null default 'standard'
    check (price_tier in ('standard', 'foundations', 'graduate')),
  add column if not exists benefit_credential_id text,
  add column if not exists list_price_ghs numeric(10,2),
  add column if not exists discount_kind text check (discount_kind is null or discount_kind in ('referral', 'foundations', 'graduate')),
  add column if not exists discount_ghs numeric(10,2) not null default 0 check (discount_ghs >= 0),
  add column if not exists referral_code text,
  add column if not exists referrer_id uuid references public.workshop_referrers(id) on delete restrict,
  add column if not exists commission_ghs numeric(10,2) not null default 0 check (commission_ghs >= 0),
  add column if not exists commission_voided_at timestamptz,
  add column if not exists commission_void_reason text;

-- One redemption of a certificate per session (cancelled and refunded
-- registrations release it).
create unique index if not exists workshop_registrations_benefit_once
  on public.workshop_registrations (session_id, benefit_credential_id)
  where benefit_credential_id is not null and status not in ('cancelled', 'refunded');

create table if not exists public.workshop_referral_payouts (
  -- One payout per registration, ever.
  registration_id uuid primary key references public.workshop_registrations(id) on delete restrict,
  referrer_id uuid not null references public.workshop_referrers(id) on delete restrict,
  amount_ghs numeric(10,2) not null check (amount_ghs > 0),
  payout_reference text not null check (length(payout_reference) between 3 and 120),
  paid_at timestamptz not null default now(),
  recorded_by text not null
);

create table if not exists public.workshop_benefit_verifications (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.workshop_sessions(id) on delete cascade,
  credential_id text not null,
  email text not null,
  tier text not null check (tier in ('foundations', 'graduate')),
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0,
  expires_at timestamptz not null,
  verified_at timestamptz,
  token_hash text unique check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  token_expires_at timestamptz,
  consumed_at timestamptz,
  registration_id uuid references public.workshop_registrations(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists workshop_benefit_verifications_cred_idx on public.workshop_benefit_verifications (credential_id, created_at);
create index if not exists workshop_benefit_verifications_email_idx on public.workshop_benefit_verifications (email, created_at);

-- Admin recovery for a holder whose recorded email changed: lets ONE other
-- address claim ONE certificate for ONE session, for 7 days. Audited.
create table if not exists public.workshop_benefit_email_grants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.workshop_sessions(id) on delete cascade,
  credential_id text not null,
  email text not null check (email = lower(btrim(email)) and email like '%_@_%'),
  reason text not null check (length(reason) between 5 and 300),
  granted_by text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.workshop_referrers enable row level security;
alter table public.workshop_referral_payouts enable row level security;
alter table public.workshop_benefit_verifications enable row level security;
alter table public.workshop_benefit_email_grants enable row level security;
revoke all on public.workshop_referrers, public.workshop_referral_payouts, public.workshop_benefit_verifications,
  public.workshop_benefit_email_grants from public, anon, authenticated;
grant all on public.workshop_referrers, public.workshop_referral_payouts, public.workshop_benefit_verifications,
  public.workshop_benefit_email_grants to service_role;
-- The signed-in admin reads referrers, payouts and grants; never code or token hashes.
grant select on public.workshop_referrers, public.workshop_referral_payouts, public.workshop_benefit_email_grants to authenticated;
drop policy if exists "Admin reads workshop referrers" on public.workshop_referrers;
create policy "Admin reads workshop referrers" on public.workshop_referrers for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop referral payouts" on public.workshop_referral_payouts;
create policy "Admin reads workshop referral payouts" on public.workshop_referral_payouts for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop benefit grants" on public.workshop_benefit_email_grants;
create policy "Admin reads workshop benefit grants" on public.workshop_benefit_email_grants for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

-- ---------------------------------------------------------------------------
-- Eligibility, read-only against the certificate register and PR #54.
-- ---------------------------------------------------------------------------

-- Every training payment obligation met: the enrollment is paid in full and
-- no installment is still owed (a cancelled installment is not owed).
create or replace function public.workshop_obligations_met(p_enrollment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select e.payment_status = 'paid'
       and coalesce(e.amount_paid_ghs, 0) >= coalesce(e.amount_ghs, 0)
       and not exists (select 1 from public.payment_plan_installments i
                        where i.enrollment_id = e.id and i.status not in ('paid', 'cancelled'))
    from public.enrollments e where e.id = p_enrollment_id), false)
$$;

-- 'graduate' | 'foundations' | null: what a certificate is eligible for today.
create or replace function public.workshop_credential_tier(p_credential_id text)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when exists (
      select 1 from private.studio_graduate_webinar_entitlements_by_certificate e
        join public.credentials c on c.credential_id = e.credential_id
       where e.credential_id = upper(btrim(p_credential_id))
         and e.entitlement_status = 'active'
         and c.status = 'valid' and c.issuance_state = 'issued'
         and (c.expires_on is null or c.expires_on >= current_date)
         and public.workshop_obligations_met(c.enrollment_id)) then 'graduate'
    when exists (
      select 1 from public.credentials c
       where c.credential_id = upper(btrim(p_credential_id))
         and c.credential = 'foundations'
         and c.status = 'valid' and c.issuance_state = 'issued'
         and (c.expires_on is null or c.expires_on >= current_date)) then 'foundations'
  end
$$;

-- May this email claim this certificate for this session? Only the email on
-- the certificate, or one the admin authorised for this certificate and session.
create or replace function public.workshop_email_may_claim(p_credential_id text, p_email text, p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.credentials c
                  where c.credential_id = upper(btrim(p_credential_id))
                    and lower(btrim(c.holder_email)) = lower(btrim(p_email)))
      or exists (select 1 from public.workshop_benefit_email_grants g
                  where g.credential_id = upper(btrim(p_credential_id)) and g.email = lower(btrim(p_email))
                    and g.session_id = p_session_id and g.revoked_at is null and g.expires_at > now())
$$;

create or replace function public.workshop_graduate_seats_in_use(p_session_id uuid)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int from public.workshop_registrations
   where session_id = p_session_id and price_tier = 'graduate'
     and status in ('confirmed', 'payment_received_review', 'refund_pending')
$$;

-- GENERAL seats in use. Identical to the original except that graduate
-- registrations, which have their own reserved seats, are not counted here.
create or replace function public.workshop_seats_in_use(p_session_id uuid, p_except uuid default null)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int
  from public.workshop_registrations r
  join public.workshop_sessions s on s.id = r.session_id
  where r.session_id = p_session_id
    and r.id is distinct from p_except
    and r.price_tier <> 'graduate'
    and (
      r.status in ('confirmed', 'payment_received_review', 'refund_pending')
      or (r.status = 'pending_payment' and exists (
        select 1 from public.workshop_payment_attempts a
        where a.registration_id = r.id and a.status = 'initialized'
          and a.created_at > now() - make_interval(mins => s.hold_minutes)))
    )
$$;

-- ---------------------------------------------------------------------------
-- Certificate verification by one-time code. The Pages Function generates the
-- code, hashes it, mails the code to the address returned here, and never
-- tells the browser whether the certificate or the email matched.
-- ---------------------------------------------------------------------------
create or replace function public.workshop_benefit_request(p_slug text, p_email text, p_credential_id text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  cred text := upper(btrim(coalesce(p_credential_id, '')));
  addr text := lower(btrim(coalesce(p_email, '')));
  tier text;
begin
  select * into s from public.workshop_sessions where slug = p_slug;
  if not found or not public.workshop_session_open(s) then return jsonb_build_object('send', false, 'why', 'session'); end if;
  -- Throttle per certificate and per address, whether or not they match.
  if (select count(*) from public.workshop_benefit_verifications where credential_id = cred and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.workshop_benefit_verifications where email = addr and created_at > now() - interval '1 hour') >= 3 then
    return jsonb_build_object('send', false, 'why', 'rate');
  end if;
  tier := public.workshop_credential_tier(cred);
  if tier is null then return jsonb_build_object('send', false, 'why', 'not_eligible'); end if;
  if (tier = 'graduate' and not s.graduate_free) or (tier = 'foundations' and s.foundations_discount_pct = 0) then
    return jsonb_build_object('send', false, 'why', 'not_offered');
  end if;
  if not public.workshop_email_may_claim(cred, addr, s.id) then return jsonb_build_object('send', false, 'why', 'email'); end if;
  if exists (select 1 from public.workshop_registrations r where r.session_id = s.id and r.benefit_credential_id = cred
              and r.status not in ('cancelled', 'refunded')) then
    return jsonb_build_object('send', false, 'why', 'already_used');
  end if;
  insert into public.workshop_benefit_verifications (session_id, credential_id, email, tier, code_hash, expires_at)
  values (s.id, cred, addr, tier, p_code_hash, now() + interval '10 minutes');
  return jsonb_build_object('send', true, 'to', addr, 'tier', tier);
end $$;

create or replace function public.workshop_benefit_confirm(p_slug text, p_email text, p_credential_id text, p_code_hash text, p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.workshop_benefit_verifications;
  cred text := upper(btrim(coalesce(p_credential_id, '')));
  addr text := lower(btrim(coalesce(p_email, '')));
begin
  select bv.* into v from public.workshop_benefit_verifications bv
    join public.workshop_sessions s on s.id = bv.session_id
   where s.slug = p_slug and bv.credential_id = cred and bv.email = addr
     and bv.verified_at is null and bv.expires_at > now() and bv.attempts < 5
   order by bv.created_at desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'remaining', 0); end if;
  update public.workshop_benefit_verifications set attempts = attempts + 1 where id = v.id;
  if v.code_hash <> p_code_hash then
    return jsonb_build_object('ok', false, 'remaining', greatest(0, 4 - v.attempts));
  end if;
  update public.workshop_benefit_verifications
     set verified_at = now(), token_hash = p_token_hash, token_expires_at = now() + interval '30 minutes'
   where id = v.id;
  return jsonb_build_object('ok', true, 'tier', v.tier);
end $$;

-- ---------------------------------------------------------------------------
-- The one price calculation. Used by the quote shown on the page and by
-- registration, so what the customer sees is what is charged.
-- ---------------------------------------------------------------------------
create or replace function public.workshop_price(p_session_id uuid, p_email text, p_referral_code text, p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  v public.workshop_benefit_verifications;
  x public.workshop_referrers;
  addr text := lower(btrim(coalesce(p_email, '')));
  ref text := upper(btrim(coalesce(p_referral_code, '')));
  tier text := 'standard';
  cred text;
  ref_ok boolean := false;
  list numeric(10,2);
  fnd numeric(10,2) := 0;
  rd numeric(10,2) := 0;
  kind text;
  disc numeric(10,2) := 0;
begin
  select * into s from public.workshop_sessions where id = p_session_id;
  list := s.price_ghs;

  if coalesce(p_token_hash, '') <> '' then
    select * into v from public.workshop_benefit_verifications
     where token_hash = p_token_hash and session_id = s.id and email = addr
       and verified_at is not null and consumed_at is null and token_expires_at > now();
    if not found then return jsonb_build_object('ok', false, 'error', 'benefit_not_valid'); end if;
    -- Re-checked now: a certificate revoked or an installment missed since the
    -- code was sent no longer qualifies.
    if public.workshop_credential_tier(v.credential_id) is distinct from v.tier then
      return jsonb_build_object('ok', false, 'error', 'benefit_not_valid');
    end if;
    if exists (select 1 from public.workshop_registrations r where r.session_id = s.id and r.benefit_credential_id = v.credential_id
                and r.status not in ('cancelled', 'refunded')) then
      return jsonb_build_object('ok', false, 'error', 'benefit_already_used');
    end if;
    tier := v.tier;
    cred := v.credential_id;
  end if;

  if ref <> '' and tier <> 'graduate' then
    select * into x from public.workshop_referrers where code = ref;
    if not found or x.status <> 'active' or (x.expires_at is not null and x.expires_at <= now())
       or public.workshop_credential_tier(x.credential_id) is distinct from 'graduate' then
      return jsonb_build_object('ok', false, 'error', 'referral_invalid');
    end if;
    -- Self-referral: the referrer's own certificate email, or a recovery
    -- address authorised for that certificate.
    if public.workshop_email_may_claim(x.credential_id, addr, s.id) then
      return jsonb_build_object('ok', false, 'error', 'referral_self');
    end if;
    ref_ok := true;
  end if;

  if tier = 'graduate' then
    kind := 'graduate'; disc := list;
  else
    if tier = 'foundations' then fnd := round(list * s.foundations_discount_pct / 100.0, 2); end if;
    if ref_ok then rd := least(s.referral_discount_ghs, list); end if;
    -- Never stacked: the larger single discount.
    if fnd > 0 and fnd >= rd then kind := 'foundations'; disc := fnd;
    elsif rd > 0 then kind := 'referral'; disc := rd;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'tier', tier, 'credential_id', cred, 'verification_id', v.id,
    'list_price_ghs', list, 'discount_kind', kind, 'discount_ghs', disc, 'price_ghs', list - disc,
    'referral_code', case when ref_ok then x.code end, 'referrer_id', case when ref_ok then x.id end,
    'commission_ghs', case when ref_ok and tier <> 'graduate' then s.referral_commission_ghs else 0 end);
end $$;

-- What the page shows before checkout. Writes nothing.
create or replace function public.workshop_quote(p_slug text, p_email text, p_referral_code text, p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
begin
  select * into s from public.workshop_sessions where slug = p_slug and status <> 'draft';
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return public.workshop_price(s.id, p_email, p_referral_code, p_token_hash);
end $$;

-- Same signature and outcomes as before, plus benefit_not_valid,
-- benefit_already_used, referral_invalid, referral_self and price_changed.
-- The certificate token, the referral code and the price the customer was
-- shown travel in p_attribution.
create or replace function public.workshop_register(
  p_slug text, p_email text, p_full_name text, p_whatsapp text, p_whatsapp_consent boolean,
  p_terms_version text, p_token_hash text, p_attribution jsonb default '{}'::jsonb,
  p_ad_consent boolean default false, p_displayed_price numeric default null,
  p_displayed_starts_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  r public.workshop_registrations;
  email text := lower(btrim(p_email));
  a jsonb := coalesce(p_attribution, '{}'::jsonb);
  q jsonb;
  shown numeric;
  free boolean;
begin
  select * into s from public.workshop_sessions where slug = p_slug for update;
  if not found or s.status = 'draft' then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into r from public.workshop_registrations where session_id = s.id and email_normalized = email;
  if found then
    if p_token_hash is not null then
      insert into public.workshop_status_tokens (token_hash, registration_id) values (p_token_hash, r.id)
      on conflict do nothing;
    end if;
    -- An existing registration resumes at the price it was created with.
    return jsonb_build_object('outcome', 'existing', 'registration_id', r.id, 'status', r.status,
      'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', r.amount_ghs, 'price_tier', r.price_tier);
  end if;

  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  -- The page states the advertised price and a time. If the database
  -- disagrees, nobody is registered against a number they did not see.
  if p_displayed_price is not null and p_displayed_price <> s.price_ghs then
    return jsonb_build_object('outcome', 'stale_page');
  end if;
  if p_displayed_starts_at is not null and p_displayed_starts_at <> s.starts_at then
    return jsonb_build_object('outcome', 'stale_page');
  end if;

  q := public.workshop_price(s.id, email, a->>'referral_code', a->>'benefit_token_hash');
  if not (q->>'ok')::boolean then return jsonb_build_object('outcome', q->>'error'); end if;
  -- The final price the page showed. If it differs, the customer re-quotes.
  shown := nullif(a->>'expected_price', '')::numeric;
  if shown is not null and shown <> (q->>'price_ghs')::numeric then
    return jsonb_build_object('outcome', 'price_changed', 'price_ghs', (q->>'price_ghs')::numeric);
  end if;

  if q->>'tier' = 'graduate' then
    if public.workshop_graduate_seats_in_use(s.id) >= s.reserved_graduate_seats then
      return jsonb_build_object('outcome', 'full');
    end if;
  elsif s.capacity is not null and public.workshop_seats_in_use(s.id) >= s.capacity then
    return jsonb_build_object('outcome', 'full');
  end if;

  free := (q->>'price_ghs')::numeric = 0;
  insert into public.workshop_registrations (
    session_id, email_normalized, full_name, whatsapp, whatsapp_consent, terms_ack, terms_version,
    status, payment_status, amount_ghs,
    price_tier, benefit_credential_id, list_price_ghs, discount_kind, discount_ghs,
    referral_code, referrer_id, commission_ghs,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_path, referrer_host,
    ad_consent, fbclid, fbc, fbp, client_ip, client_user_agent)
  values (
    s.id, email, btrim(p_full_name), nullif(btrim(coalesce(p_whatsapp, '')), ''), coalesce(p_whatsapp_consent, false),
    true, p_terms_version,
    case when free then 'confirmed' else 'pending_payment' end,
    case when free then 'not_required' else 'pending' end,
    (q->>'price_ghs')::numeric,
    q->>'tier', q->>'credential_id', (q->>'list_price_ghs')::numeric, q->>'discount_kind', (q->>'discount_ghs')::numeric,
    q->>'referral_code', (q->>'referrer_id')::uuid, (q->>'commission_ghs')::numeric,
    left(a->>'utm_source', 120), left(a->>'utm_medium', 120), left(a->>'utm_campaign', 200),
    left(a->>'utm_content', 200), left(a->>'utm_term', 200), left(a->>'landing_path', 200), left(a->>'referrer_host', 200),
    coalesce(p_ad_consent, false),
    case when p_ad_consent then left(a->>'fbclid', 500) end,
    case when p_ad_consent then left(a->>'fbc', 600) end,
    case when p_ad_consent then left(a->>'fbp', 200) end,
    case when p_ad_consent then left(a->>'client_ip', 64) end,
    case when p_ad_consent then left(a->>'client_user_agent', 400) end)
  returning * into r;

  -- The certificate token is spent with the registration, in the same transaction.
  if q->>'verification_id' is not null then
    update public.workshop_benefit_verifications set consumed_at = now(), registration_id = r.id
     where id = (q->>'verification_id')::uuid;
  end if;

  if p_token_hash is not null then
    insert into public.workshop_status_tokens (token_hash, registration_id) values (p_token_hash, r.id);
  end if;

  if free then
    insert into public.workshop_notifications (registration_id, kind) values (r.id, 'confirmation');
    perform public.workshop_enqueue_meta(r, 'CompleteRegistration', 'cr_' || r.id, 0);
  end if;

  return jsonb_build_object('outcome', 'created', 'registration_id', r.id, 'status', r.status,
    'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', r.amount_ghs, 'price_tier', r.price_tier,
    'list_price_ghs', r.list_price_ghs, 'discount_kind', r.discount_kind, 'discount_ghs', r.discount_ghs);
end $$;

-- Same as before, except the amount is the registration's stored price.
create or replace function public.workshop_start_attempt(p_registration_id uuid, p_reference text, p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.workshop_registrations;
  s public.workshop_sessions;
  att public.workshop_payment_attempts;
begin
  select * into r from public.workshop_registrations where id = p_registration_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  select * into s from public.workshop_sessions where id = r.session_id for update;
  select * into r from public.workshop_registrations where id = p_registration_id for update;

  if r.status in ('confirmed', 'payment_received_review', 'refund_pending') or r.payment_status = 'paid' then
    return jsonb_build_object('outcome', 'already_paid', 'status', r.status);
  end if;
  if r.status <> 'pending_payment' or r.amount_ghs = 0 or r.payment_status = 'needs_review' then
    return jsonb_build_object('outcome', 'not_payable', 'status', r.status);
  end if;
  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  if s.capacity is not null and public.workshop_seats_in_use(s.id, r.id) >= s.capacity then
    return jsonb_build_object('outcome', 'full');
  end if;

  insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, currency, mode)
  values (r.id, p_reference, round(r.amount_ghs * 100)::bigint, 'GHS', p_mode)
  returning * into att;

  perform public.workshop_enqueue_meta(r, 'InitiateCheckout', 'ic_' || r.id, r.amount_ghs);

  return jsonb_build_object('outcome', 'started', 'attempt_id', att.id, 'reference', att.reference,
    'amount_minor', att.amount_minor, 'currency', att.currency, 'session_id', s.id);
end $$;

-- A commission is payable only on a confirmed registration whose single
-- verified payment is held in full (no refund, duplicate or mismatch), made
-- with a valid referral, not voided, and not a complimentary place.
create or replace function public.workshop_commission_payable(r public.workshop_registrations)
returns boolean language sql stable set search_path = '' as $$
  select r.commission_ghs > 0 and r.referrer_id is not null and r.price_tier <> 'graduate'
     and r.status = 'confirmed' and r.payment_status = 'paid' and r.commission_voided_at is null
     and r.amount_paid_minor = round(r.amount_ghs * 100)::bigint
     and exists (select 1 from public.workshop_payment_attempts a where a.registration_id = r.id and a.status = 'succeeded')
     and not exists (select 1 from public.workshop_payment_attempts a where a.registration_id = r.id
                      and a.status in ('duplicate_payment', 'mismatch'))
$$;

-- Admission: confirmed AND either paid or a legitimately free place. A
-- complimentary graduate place is re-checked against the certificate register
-- and entitlement at the moment of invitation.
create or replace function public.workshop_admin_admission(
  p_actor_email text, p_registration_id uuid, p_action text, p_email text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.workshop_registrations;
  s public.workshop_sessions;
  addr text := lower(btrim(coalesce(p_email, '')));
  stamp text;
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;
  select * into r from public.workshop_registrations where id = p_registration_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into s from public.workshop_sessions where id = r.session_id;
  if s.admission <> 'invite' then return jsonb_build_object('ok', false, 'error', 'not_invite_session'); end if;
  stamp := to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC admission ' || p_action;

  if p_action = 'mark_invited' then
    if r.status <> 'confirmed' or r.payment_status not in ('paid', 'partially_refunded', 'not_required') then
      return jsonb_build_object('ok', false, 'error', 'not_confirmed');
    end if;
    if r.price_tier = 'graduate' and public.workshop_credential_tier(r.benefit_credential_id) is distinct from 'graduate' then
      return jsonb_build_object('ok', false, 'error', 'graduate_not_eligible');
    end if;
    if r.attend_email is null then return jsonb_build_object('ok', false, 'error', 'no_attend_email'); end if;
    if r.invited_email is not distinct from r.attend_email then return jsonb_build_object('ok', true, 'already', true); end if;
    if r.invited_email is not null then return jsonb_build_object('ok', false, 'error', 'remove_old_first'); end if;
    if exists (select 1 from public.workshop_registrations o
                where o.session_id = r.session_id and o.id <> r.id and o.invited_email = r.attend_email) then
      return jsonb_build_object('ok', false, 'error', 'account_on_other_registration');
    end if;
    update public.workshop_registrations set invited_email = attend_email, invited_at = now(),
      admin_notes = concat_ws(E'\n', admin_notes, stamp || ' (' || r.attend_email || ')') where id = r.id;
  elsif p_action = 'mark_removed' then
    if r.invited_email is null then return jsonb_build_object('ok', true, 'already', true); end if;
    update public.workshop_registrations set invited_email = null, invite_removed_at = now(),
      admin_notes = concat_ws(E'\n', admin_notes, stamp || ' (' || r.invited_email || ')') where id = r.id;
  elsif p_action = 'set_attend_email' then
    if addr !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then return jsonb_build_object('ok', false, 'error', 'bad_email'); end if;
    update public.workshop_registrations set attend_email = addr,
      admin_notes = concat_ws(E'\n', admin_notes, stamp || ' (' || coalesce(r.attend_email, 'none') || ' -> ' || addr || ')') where id = r.id;
  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Referrals and certificate recovery, admin only:
--   create_referrer      p_credential_id, optional p_value = the code (A-Z, 0-9, 4-16)
--   suspend_referrer / activate_referrer   p_credential_id
--   record_payout        p_registration_id, p_value = MoMo or bank reference
--   void_commission      p_registration_id, p_value = reason (fraud, error)
--   grant_email          p_credential_id, p_email, p_value = reason, p_session_slug
--   revoke_grant         p_grant_id
create or replace function public.workshop_admin_referral(
  p_actor_email text, p_action text, p_credential_id text default null, p_registration_id uuid default null,
  p_value text default null, p_email text default null, p_session_slug text default null, p_grant_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cred text := upper(btrim(coalesce(p_credential_id, '')));
  val text := btrim(coalesce(p_value, ''));
  x public.workshop_referrers;
  r public.workshop_registrations;
  s public.workshop_sessions;
  new_code text;
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;

  if p_action = 'create_referrer' then
    select * into x from public.workshop_referrers where credential_id = cred;
    if found then return jsonb_build_object('ok', true, 'already', true, 'code', x.code); end if;
    if public.workshop_credential_tier(cred) is distinct from 'graduate' then
      return jsonb_build_object('ok', false, 'error', 'not_eligible_graduate');
    end if;
    if val <> '' then
      new_code := upper(val);
      -- Public by design, so it must not be, or contain, the certificate number.
      if new_code !~ '^[A-Z0-9]{4,16}$'
         or position(regexp_replace(cred, '[^A-Z0-9]', '', 'g') in new_code) > 0
         or position(new_code in regexp_replace(cred, '[^A-Z0-9]', '', 'g')) > 0
         or (split_part(cred, '-', 4) <> '' and position(split_part(cred, '-', 4) in new_code) > 0) then
        return jsonb_build_object('ok', false, 'error', 'bad_code');
      end if;
      if exists (select 1 from public.workshop_referrers where code = new_code) then
        return jsonb_build_object('ok', false, 'error', 'code_taken');
      end if;
    else
      loop
        new_code := '';
        for i in 1..6 loop
          new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
        end loop;
        new_code := new_code || '50';
        exit when not exists (select 1 from public.workshop_referrers where code = new_code);
      end loop;
    end if;
    insert into public.workshop_referrers (code, credential_id, created_by) values (new_code, cred, lower(p_actor_email))
    returning * into x;
    return jsonb_build_object('ok', true, 'code', x.code);

  elsif p_action in ('suspend_referrer', 'activate_referrer') then
    update public.workshop_referrers set status = case when p_action = 'suspend_referrer' then 'suspended' else 'active' end
     where credential_id = cred returning * into x;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    return jsonb_build_object('ok', true);

  elsif p_action = 'record_payout' then
    select * into r from public.workshop_registrations where id = p_registration_id for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if not public.workshop_commission_payable(r) then return jsonb_build_object('ok', false, 'error', 'not_qualifying'); end if;
    if length(val) < 3 then return jsonb_build_object('ok', false, 'error', 'reference_required'); end if;
    insert into public.workshop_referral_payouts (registration_id, referrer_id, amount_ghs, payout_reference, recorded_by)
    values (r.id, r.referrer_id, r.commission_ghs, left(val, 120), lower(p_actor_email))
    on conflict (registration_id) do nothing;
    if not found then return jsonb_build_object('ok', true, 'already', true); end if;
    return jsonb_build_object('ok', true);

  elsif p_action = 'void_commission' then
    if length(val) < 5 then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
    update public.workshop_registrations
       set commission_voided_at = now(), commission_void_reason = left(val, 300),
           admin_notes = concat_ws(E'\n', admin_notes, to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC commission voided: ' || left(val, 300))
     where id = p_registration_id and referrer_id is not null returning * into r;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    return jsonb_build_object('ok', true);

  elsif p_action = 'grant_email' then
    select * into s from public.workshop_sessions where slug = p_session_slug;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    if public.workshop_credential_tier(cred) is null then return jsonb_build_object('ok', false, 'error', 'not_eligible'); end if;
    if lower(btrim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then return jsonb_build_object('ok', false, 'error', 'bad_email'); end if;
    if length(val) < 5 then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
    insert into public.workshop_benefit_email_grants (session_id, credential_id, email, reason, granted_by, expires_at)
    values (s.id, cred, lower(btrim(p_email)), left(val, 300), lower(p_actor_email), now() + interval '7 days');
    return jsonb_build_object('ok', true);

  elsif p_action = 'revoke_grant' then
    update public.workshop_benefit_email_grants set revoked_at = now() where id = p_grant_id and revoked_at is null;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'unknown_action');
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'workshop_obligations_met(uuid)', 'workshop_credential_tier(text)', 'workshop_email_may_claim(text,text,uuid)',
    'workshop_graduate_seats_in_use(uuid)', 'workshop_benefit_request(text,text,text,text)',
    'workshop_benefit_confirm(text,text,text,text,text)', 'workshop_price(uuid,text,text,text)',
    'workshop_quote(text,text,text,text)', 'workshop_commission_payable(public.workshop_registrations)',
    'workshop_admin_admission(text,uuid,text,text)',
    'workshop_admin_referral(text,text,text,uuid,text,text,text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;
