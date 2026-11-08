-- ---------------------------------------------------------------------------
-- Workshop release 2: admission by Google Calendar invitation (part 1) and
-- prices, certificate benefits, reserved graduate seats and referrals (part 2).
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
-- Part 2. Prices, certificate benefits, reserved graduate seats, referrals.
--
--   standard     the session's price_ghs
--   foundations  a valid, issued Foundations certificate whose holder_email is
--                the registration email: price less foundations_discount_pct
--   graduate     a valid, issued Intermediate certificate with an ACTIVE
--                entitlement in private.studio_graduate_webinar_entitlements
--                (PR #54), holder_email = registration email, and the
--                training enrollment paid in full with no installment owing:
--                free when graduate_free, in one of reserved_graduate_seats
--
-- capacity keeps its meaning for every existing code path: the GENERAL seats.
-- Graduate registrations are counted only against reserved_graduate_seats, so
-- capacity 25 + reserved 5 is 30 in all. The certificate register is read,
-- never written: no parallel certificate system, no new credential.
--
-- Referrals: an eligible Intermediate graduate may be given one code. A paid
-- (non-graduate) registration that arrived with an active code earns the
-- session's referral_commission_ghs. Commission is DERIVED, never stored as
-- owed; only a manual payout is recorded, once per registration. No money
-- moves here and nothing is split in Paystack.
--
-- workshop_register, workshop_start_attempt and workshop_seats_in_use are
-- replaced IN PLACE with the same signatures; the certificate ID and referral
-- code travel in p_attribution. The rollback restores their original bodies.
-- ===========================================================================

alter table public.workshop_sessions
  add column if not exists foundations_discount_pct integer not null default 0
    check (foundations_discount_pct between 0 and 100),
  add column if not exists graduate_free boolean not null default false,
  add column if not exists reserved_graduate_seats integer not null default 0
    check (reserved_graduate_seats >= 0),
  add column if not exists referral_commission_ghs numeric(10,2) not null default 0
    check (referral_commission_ghs >= 0);

alter table public.workshop_registrations
  add column if not exists price_tier text not null default 'standard'
    check (price_tier in ('standard', 'foundations', 'graduate')),
  add column if not exists benefit_credential_id text,
  add column if not exists referral_code text;

create table if not exists public.workshop_referrers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{8}$'),
  credential_id text not null unique,
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_by text not null,
  created_at timestamptz not null default now(),
  notes text
);

create table if not exists public.workshop_referral_payouts (
  -- One payout per registration, ever: a commission cannot be paid twice.
  registration_id uuid primary key references public.workshop_registrations(id) on delete restrict,
  referrer_id uuid not null references public.workshop_referrers(id) on delete restrict,
  amount_ghs numeric(10,2) not null check (amount_ghs > 0),
  payout_reference text not null check (length(payout_reference) between 3 and 120),
  paid_at timestamptz not null default now(),
  recorded_by text not null
);

alter table public.workshop_referrers enable row level security;
alter table public.workshop_referral_payouts enable row level security;
revoke all on public.workshop_referrers, public.workshop_referral_payouts from public, anon, authenticated;
grant all on public.workshop_referrers, public.workshop_referral_payouts to service_role;
grant select on public.workshop_referrers, public.workshop_referral_payouts to authenticated;
drop policy if exists "Admin reads workshop referrers" on public.workshop_referrers;
create policy "Admin reads workshop referrers" on public.workshop_referrers for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop referral payouts" on public.workshop_referral_payouts;
create policy "Admin reads workshop referral payouts" on public.workshop_referral_payouts for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

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

-- 'graduate' | 'foundations' | null for one email and one certificate ID.
-- Both must match: certificate IDs are public (they are on LinkedIn), so an ID
-- alone proves nothing. Read-only against the certificate register.
create or replace function public.workshop_benefit_tier(p_email text, p_credential_id text)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when exists (
      select 1 from private.studio_graduate_webinar_entitlements_by_certificate e
        join public.credentials c on c.credential_id = e.credential_id
       where e.credential_id = upper(btrim(p_credential_id))
         and e.entitlement_status = 'active'
         and c.status = 'valid' and c.issuance_state = 'issued'
         and (c.expires_on is null or c.expires_on >= current_date)
         and lower(btrim(c.holder_email)) = lower(btrim(p_email))
         and public.workshop_obligations_met(c.enrollment_id)) then 'graduate'
    when exists (
      select 1 from public.credentials c
       where c.credential_id = upper(btrim(p_credential_id))
         and c.credential = 'foundations'
         and c.status = 'valid' and c.issuance_state = 'issued'
         and (c.expires_on is null or c.expires_on >= current_date)
         and lower(btrim(c.holder_email)) = lower(btrim(p_email))) then 'foundations'
  end
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

-- Same signature and outcomes as before, plus benefit_not_matched and
-- benefit_not_available. The price is decided here, once, under the session
-- lock, and stored on the registration; checkout charges that stored price.
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
  cred text := upper(btrim(coalesce(a->>'benefit_credential_id', '')));
  ref text := upper(btrim(coalesce(a->>'referral_code', '')));
  tier text := 'standard';
  price numeric(10,2);
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
    -- The registration's own price, not the session's: a discounted or free
    -- registration resumes at the price it was created with.
    return jsonb_build_object('outcome', 'existing', 'registration_id', r.id, 'status', r.status,
      'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', r.amount_ghs, 'price_tier', r.price_tier);
  end if;

  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  -- The page states the standard price and a time. If the database disagrees,
  -- nobody is registered against a number they did not see.
  if p_displayed_price is not null and p_displayed_price <> s.price_ghs then
    return jsonb_build_object('outcome', 'stale_page');
  end if;
  if p_displayed_starts_at is not null and p_displayed_starts_at <> s.starts_at then
    return jsonb_build_object('outcome', 'stale_page');
  end if;

  if cred <> '' then
    tier := public.workshop_benefit_tier(email, cred);
    if tier is null then return jsonb_build_object('outcome', 'benefit_not_matched'); end if;
    if (tier = 'graduate' and not s.graduate_free) or (tier = 'foundations' and s.foundations_discount_pct = 0) then
      return jsonb_build_object('outcome', 'benefit_not_available');
    end if;
  end if;
  price := case tier
    when 'graduate' then 0
    when 'foundations' then round(s.price_ghs * (100 - s.foundations_discount_pct) / 100.0, 2)
    else s.price_ghs end;

  if tier = 'graduate' then
    if public.workshop_graduate_seats_in_use(s.id) >= s.reserved_graduate_seats then
      return jsonb_build_object('outcome', 'full');
    end if;
  elsif s.capacity is not null and public.workshop_seats_in_use(s.id) >= s.capacity then
    return jsonb_build_object('outcome', 'full');
  end if;

  -- A referral counts only for an active code, never the referrer's own
  -- registration, and never a complimentary graduate place.
  if ref <> '' and tier <> 'graduate' and not exists (
       select 1 from public.workshop_referrers x
         join public.credentials c on c.credential_id = x.credential_id
        where x.code = ref and x.status = 'active' and lower(btrim(c.holder_email)) <> email) then
    ref := '';
  end if;
  if tier = 'graduate' then ref := ''; end if;

  free := price = 0;
  insert into public.workshop_registrations (
    session_id, email_normalized, full_name, whatsapp, whatsapp_consent, terms_ack, terms_version,
    status, payment_status, amount_ghs, price_tier, benefit_credential_id, referral_code,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_path, referrer_host,
    ad_consent, fbclid, fbc, fbp, client_ip, client_user_agent)
  values (
    s.id, email, btrim(p_full_name), nullif(btrim(coalesce(p_whatsapp, '')), ''), coalesce(p_whatsapp_consent, false),
    true, p_terms_version,
    case when free then 'confirmed' else 'pending_payment' end,
    case when free then 'not_required' else 'pending' end,
    price, tier, nullif(cred, ''), nullif(ref, ''),
    left(a->>'utm_source', 120), left(a->>'utm_medium', 120), left(a->>'utm_campaign', 200),
    left(a->>'utm_content', 200), left(a->>'utm_term', 200), left(a->>'landing_path', 200), left(a->>'referrer_host', 200),
    coalesce(p_ad_consent, false),
    case when p_ad_consent then left(a->>'fbclid', 500) end,
    case when p_ad_consent then left(a->>'fbc', 600) end,
    case when p_ad_consent then left(a->>'fbp', 200) end,
    case when p_ad_consent then left(a->>'client_ip', 64) end,
    case when p_ad_consent then left(a->>'client_user_agent', 400) end)
  returning * into r;

  if p_token_hash is not null then
    insert into public.workshop_status_tokens (token_hash, registration_id) values (p_token_hash, r.id);
  end if;

  if free then
    insert into public.workshop_notifications (registration_id, kind) values (r.id, 'confirmation');
    perform public.workshop_enqueue_meta(r, 'CompleteRegistration', 'cr_' || r.id, 0);
  end if;

  return jsonb_build_object('outcome', 'created', 'registration_id', r.id, 'status', r.status,
    'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', r.amount_ghs, 'price_tier', r.price_tier);
end $$;

-- Same as before, except the amount is the registration's stored price
-- (standard or Foundations) rather than the session's.
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

-- Admission, replacing the part 1 version: confirmed AND either paid or a
-- legitimately free place. A complimentary graduate place is re-checked
-- against the certificate register and entitlement at the moment of
-- invitation, so a revoked certificate or a lapsed entitlement cannot be invited.
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
    if r.price_tier = 'graduate'
       and public.workshop_benefit_tier(r.email_normalized, r.benefit_credential_id) is distinct from 'graduate' then
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

-- Referral administration: create or suspend a referrer, record a payout.
create or replace function public.workshop_admin_referral(
  p_actor_email text, p_action text, p_credential_id text default null,
  p_registration_id uuid default null, p_reference text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cred text := upper(btrim(coalesce(p_credential_id, '')));
  x public.workshop_referrers;
  r public.workshop_registrations;
  s public.workshop_sessions;
  holder text;
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
    select holder_email into holder from public.credentials where credential_id = cred;
    if holder is null or public.workshop_benefit_tier(holder, cred) is distinct from 'graduate' then
      return jsonb_build_object('ok', false, 'error', 'not_eligible_graduate');
    end if;
    loop
      new_code := '';
      for i in 1..8 loop
        new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      end loop;
      exit when not exists (select 1 from public.workshop_referrers where code = new_code);
    end loop;
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
    select * into s from public.workshop_sessions where id = r.session_id;
    select * into x from public.workshop_referrers where code = r.referral_code;
    -- Qualifying: a confirmed registration paid in full, not complimentary,
    -- that arrived with a referrer's code.
    if x.id is null or r.status <> 'confirmed' or r.payment_status <> 'paid' or r.price_tier = 'graduate'
       or r.amount_paid_minor <= 0 or s.referral_commission_ghs <= 0 then
      return jsonb_build_object('ok', false, 'error', 'not_qualifying');
    end if;
    if length(btrim(coalesce(p_reference, ''))) < 3 then return jsonb_build_object('ok', false, 'error', 'reference_required'); end if;
    insert into public.workshop_referral_payouts (registration_id, referrer_id, amount_ghs, payout_reference, recorded_by)
    values (r.id, x.id, s.referral_commission_ghs, left(btrim(p_reference), 120), lower(p_actor_email))
    on conflict (registration_id) do nothing;
    if not found then return jsonb_build_object('ok', true, 'already', true); end if;
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'unknown_action');
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'workshop_obligations_met(uuid)', 'workshop_benefit_tier(text,text)', 'workshop_graduate_seats_in_use(uuid)',
    'workshop_admin_referral(text,text,text,uuid,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

revoke all on function public.workshop_admin_admission(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.workshop_admin_admission(text, uuid, text, text) to service_role;
