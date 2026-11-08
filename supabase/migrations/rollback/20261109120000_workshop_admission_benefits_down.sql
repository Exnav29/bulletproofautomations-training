-- Rollback of 20261109120000_workshop_admission_benefits.sql. Run it BEFORE
-- 20261103120000_workshops_down.sql. It drops only what release 2 added and
-- restores, verbatim from 20261103120000, the three functions it replaced.
-- Export workshop_referral_payouts first: it is the record of commissions paid.

create or replace function public.workshop_seats_in_use(p_session_id uuid, p_except uuid default null)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int
  from public.workshop_registrations r
  join public.workshop_sessions s on s.id = r.session_id
  where r.session_id = p_session_id
    and r.id is distinct from p_except
    and (
      r.status in ('confirmed', 'payment_received_review', 'refund_pending')
      or (r.status = 'pending_payment' and exists (
        select 1 from public.workshop_payment_attempts a
        where a.registration_id = r.id and a.status = 'initialized'
          and a.created_at > now() - make_interval(mins => s.hold_minutes)))
    )
$$;

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
    return jsonb_build_object('outcome', 'existing', 'registration_id', r.id, 'status', r.status,
      'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', s.price_ghs);
  end if;

  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  -- The page states a price and a time. If the database disagrees, nobody is
  -- registered against a number they did not see.
  if p_displayed_price is not null and p_displayed_price <> s.price_ghs then
    return jsonb_build_object('outcome', 'stale_page');
  end if;
  if p_displayed_starts_at is not null and p_displayed_starts_at <> s.starts_at then
    return jsonb_build_object('outcome', 'stale_page');
  end if;
  if s.capacity is not null and public.workshop_seats_in_use(s.id) >= s.capacity then
    return jsonb_build_object('outcome', 'full');
  end if;

  free := s.price_ghs = 0;
  insert into public.workshop_registrations (
    session_id, email_normalized, full_name, whatsapp, whatsapp_consent, terms_ack, terms_version,
    status, payment_status, amount_ghs,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_path, referrer_host,
    ad_consent, fbclid, fbc, fbp, client_ip, client_user_agent)
  values (
    s.id, email, btrim(p_full_name), nullif(btrim(coalesce(p_whatsapp, '')), ''), coalesce(p_whatsapp_consent, false),
    true, p_terms_version,
    case when free then 'confirmed' else 'pending_payment' end,
    case when free then 'not_required' else 'pending' end,
    s.price_ghs,
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
    'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', s.price_ghs);
end $$;

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
  if r.status <> 'pending_payment' or s.price_ghs = 0 or r.payment_status = 'needs_review' then
    return jsonb_build_object('outcome', 'not_payable', 'status', r.status);
  end if;
  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  if s.capacity is not null and public.workshop_seats_in_use(s.id, r.id) >= s.capacity then
    return jsonb_build_object('outcome', 'full');
  end if;

  insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, currency, mode)
  values (r.id, p_reference, round(s.price_ghs * 100)::bigint, 'GHS', p_mode)
  returning * into att;

  perform public.workshop_enqueue_meta(r, 'InitiateCheckout', 'ic_' || r.id, s.price_ghs);

  return jsonb_build_object('outcome', 'started', 'attempt_id', att.id, 'reference', att.reference,
    'amount_minor', att.amount_minor, 'currency', att.currency, 'session_id', s.id);
end $$;

drop function if exists public.workshop_admin_referral(text, text, text, uuid, text);
drop function if exists public.workshop_admin_admission(text, uuid, text, text);
drop function if exists public.workshop_set_attend_email(uuid, text);
drop function if exists public.workshop_graduate_seats_in_use(uuid);
drop function if exists public.workshop_benefit_tier(text, text);
drop function if exists public.workshop_obligations_met(uuid);
drop table if exists public.workshop_referral_payouts;
drop table if exists public.workshop_referrers;
alter table public.workshop_registrations
  drop column if exists referral_code,
  drop column if exists benefit_credential_id,
  drop column if exists price_tier,
  drop column if exists invite_removed_at,
  drop column if exists invited_at,
  drop column if exists invited_email,
  drop column if exists attend_email;
alter table public.workshop_sessions
  drop column if exists referral_commission_ghs,
  drop column if exists reserved_graduate_seats,
  drop column if exists graduate_free,
  drop column if exists foundations_discount_pct,
  drop column if exists calendar_event_id,
  drop column if exists admission;
