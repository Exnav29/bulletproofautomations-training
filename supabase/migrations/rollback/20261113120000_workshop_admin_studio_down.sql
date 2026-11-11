-- Rollback of release 6 (20261113120000_workshop_admin_studio.sql). Run as one transaction.
-- Restores workshop_price and workshop_benefit_request verbatim from release 2, drops the
-- functions, tables and columns release 6 added. Fails, deliberately, if a draft session
-- has no date or a referral code has no certificate: those rows only exist under release 6
-- and must be dated, removed or reassigned by hand first.

drop function if exists public.workshop_admin_referrer(text, text, uuid, jsonb);
drop function if exists public.workshop_admin_series(text, jsonb);
drop function if exists public.workshop_admin_session(text, text, uuid, jsonb, text);
drop function if exists public.workshop_session_problems(public.workshop_sessions);
drop function if exists public.workshop_benefit_request(text, text, text, text, text);

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
revoke all on function public.workshop_benefit_request(text, text, text, text) from public, anon, authenticated;
grant execute on function public.workshop_benefit_request(text, text, text, text) to service_role;

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
    if not found or not (x.status = 'active' or (x.status = 'prepared' and s.is_test))
       or (x.expires_at is not null and x.expires_at <= now())
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

alter table public.workshop_referrers drop constraint if exists workshop_referrers_identified;
alter table public.workshop_referrers drop column if exists payout_method, drop column if exists email, drop column if exists name;
alter table public.workshop_referrers alter column credential_id set not null;

drop index if exists public.workshop_sessions_series_number_once;
alter table public.workshop_sessions drop constraint if exists workshop_sessions_dated;
alter table public.workshop_sessions alter column starts_at set not null;
alter table public.workshop_sessions drop column if exists admin_notes, drop column if exists announce,
  drop column if exists series_number, drop column if exists series_slug, drop column if exists content;

drop table if exists public.workshop_settings;
drop table if exists public.workshop_series;
