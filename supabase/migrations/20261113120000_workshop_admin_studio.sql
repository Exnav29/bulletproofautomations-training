-- ===========================================================================
-- Workshop studio (release 6): workshops are created, edited and removed from
-- /admin/workshops/, and their public pages are rendered from this database.
--
--   * Page content lives on the session row (content jsonb), so a change made
--     in the admin is live without a deploy. Series copy lives in
--     workshop_series. A draft session can be announced: it is listed as
--     "coming soon", with no date, no fee and no form.
--   * Every session change goes through workshop_admin_session(), which
--     enforces the rules (no capacity below the places already taken, no
--     publishing without a date, no deleting a session anyone registered for)
--     and stamps admin_notes.
--   * Referral codes can be given to anyone, not only Intermediate graduates.
--     One set of referral terms (workshop_settings) applies to every workshop.
--   * Certificate prices: an email that may claim the certificate (the address
--     on it, or one the admin authorised) is verified at once. Any other
--     address gets a code sent to the address on the certificate.
--
-- Additive and reversible: rollback/20261113120000_workshop_admin_studio_down.sql.
-- Nothing here changes a registration, a payment or a seat count.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Series
-- ---------------------------------------------------------------------------
create table if not exists public.workshop_series (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 80),
  name text not null check (length(name) between 3 and 120),
  presenter text not null check (length(presenter) between 2 and 120),
  positioning text not null default '' check (length(positioning) <= 400),
  intro jsonb not null default '[]'::jsonb check (jsonb_typeof(intro) = 'array'),
  standalone text not null default '' check (length(standalone) <= 600),
  disclaimer text not null default '' check (length(disclaimer) <= 1200),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. Sessions: page content, series membership, announcing, audit trail
-- ---------------------------------------------------------------------------
alter table public.workshop_sessions
  add column if not exists content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  add column if not exists series_slug text references public.workshop_series(slug) on update cascade on delete set null,
  add column if not exists series_number integer check (series_number is null or series_number between 1 and 99),
  add column if not exists announce boolean not null default false,
  add column if not exists admin_notes text;

-- A draft may not have a date yet. Everything else must.
alter table public.workshop_sessions alter column starts_at drop not null;
alter table public.workshop_sessions drop constraint if exists workshop_sessions_dated;
alter table public.workshop_sessions add constraint workshop_sessions_dated check (status = 'draft' or starts_at is not null);
create unique index if not exists workshop_sessions_series_number_once
  on public.workshop_sessions (series_slug, series_number) where series_slug is not null and series_number is not null and not is_test;

-- ---------------------------------------------------------------------------
-- 3. One set of referral terms for every workshop
-- ---------------------------------------------------------------------------
create table if not exists public.workshop_settings (
  id boolean primary key default true check (id),
  referral_discount_ghs numeric(10,2) not null default 50 check (referral_discount_ghs >= 0),
  referral_commission_ghs numeric(10,2) not null default 50 check (referral_commission_ghs >= 0),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.workshop_settings (id, referral_discount_ghs, referral_commission_ghs)
values (true, 50, 50) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Referral codes for anyone
-- ---------------------------------------------------------------------------
alter table public.workshop_referrers alter column credential_id drop not null;
alter table public.workshop_referrers
  add column if not exists name text check (name is null or length(name) between 2 and 120),
  add column if not exists email text check (email is null or (email = lower(btrim(email)) and email like '%_@_%')),
  add column if not exists payout_method text check (payout_method is null or length(payout_method) between 3 and 200);
alter table public.workshop_referrers drop constraint if exists workshop_referrers_identified;
alter table public.workshop_referrers add constraint workshop_referrers_identified
  check (credential_id is not null or (name is not null and email is not null));

-- ---------------------------------------------------------------------------
-- 5. Access: service role writes; the signed-in admin reads (as for every
--    other workshop table). anon and authenticated get nothing else.
-- ---------------------------------------------------------------------------
alter table public.workshop_series enable row level security;
alter table public.workshop_settings enable row level security;
revoke all on public.workshop_series, public.workshop_settings from anon, authenticated;
grant all on public.workshop_series, public.workshop_settings to service_role;
grant select on public.workshop_series, public.workshop_settings to authenticated;
drop policy if exists "Admin reads workshop series" on public.workshop_series;
create policy "Admin reads workshop series" on public.workshop_series for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop settings" on public.workshop_settings;
create policy "Admin reads workshop settings" on public.workshop_settings for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

-- ---------------------------------------------------------------------------
-- 6. Pricing: referral codes no longer need a graduate behind them
--    (identical to release 2's workshop_price except the referral clause).
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
    -- prepared: an older code not yet switched on, valid on test sessions only.
    if not found or not (x.status = 'active' or (x.status = 'prepared' and s.is_test))
       or (x.expires_at is not null and x.expires_at <= now()) then
      return jsonb_build_object('ok', false, 'error', 'referral_invalid');
    end if;
    -- Nobody earns a commission on their own place: the email the code was
    -- issued to, or (for a graduate's code) the certificate's own addresses.
    if (x.email is not null and x.email = addr)
       or (x.credential_id is not null and public.workshop_email_may_claim(x.credential_id, addr, s.id)) then
      return jsonb_build_object('ok', false, 'error', 'referral_self');
    end if;
    ref_ok := true;
  end if;

  if tier = 'graduate' then
    kind := 'graduate'; disc := list;
  else
    if tier = 'foundations' then fnd := round(list * s.foundations_discount_pct / 100.0, 2); end if;
    if ref_ok then rd := least(s.referral_discount_ghs, list); end if;
    if fnd > 0 and fnd >= rd then kind := 'foundations'; disc := fnd;
    elsif rd > 0 then kind := 'referral'; disc := rd;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'tier', tier, 'credential_id', cred, 'verification_id', v.id,
    'list_price_ghs', list, 'discount_kind', kind, 'discount_ghs', disc, 'price_ghs', list - disc,
    'referral_code', case when ref_ok then x.code end, 'referrer_id', case when ref_ok then x.id end,
    'commission_ghs', case when ref_ok and tier <> 'graduate' then s.referral_commission_ghs else 0 end);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Certificate prices: same email is enough; another email gets a code
--    sent to the address on the certificate.
-- ---------------------------------------------------------------------------
drop function if exists public.workshop_benefit_request(text, text, text, text);
create or replace function public.workshop_benefit_request(p_slug text, p_email text, p_credential_id text,
  p_code_hash text, p_token_hash text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  cred text := upper(btrim(coalesce(p_credential_id, '')));
  addr text := lower(btrim(coalesce(p_email, '')));
  tier text;
  holder text;
begin
  select * into s from public.workshop_sessions where slug = p_slug;
  if not found or not public.workshop_session_open(s) then return jsonb_build_object('send', false, 'why', 'session'); end if;
  if (select count(*) from public.workshop_benefit_verifications where credential_id = cred and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.workshop_benefit_verifications where email = addr and created_at > now() - interval '1 hour') >= 3 then
    return jsonb_build_object('send', false, 'why', 'rate');
  end if;
  tier := public.workshop_credential_tier(cred);
  if tier is null then return jsonb_build_object('send', false, 'why', 'not_eligible'); end if;
  if (tier = 'graduate' and not s.graduate_free) or (tier = 'foundations' and s.foundations_discount_pct = 0) then
    return jsonb_build_object('send', false, 'why', 'not_offered');
  end if;
  if exists (select 1 from public.workshop_registrations r where r.session_id = s.id and r.benefit_credential_id = cred
              and r.status not in ('cancelled', 'refunded')) then
    return jsonb_build_object('send', false, 'why', 'already_used');
  end if;

  -- The address on the certificate (or one the admin authorised for it): verified now.
  if public.workshop_email_may_claim(cred, addr, s.id) and coalesce(p_token_hash, '') ~ '^[0-9a-f]{64}$' then
    insert into public.workshop_benefit_verifications (session_id, credential_id, email, tier, code_hash, expires_at,
      verified_at, token_hash, token_expires_at)
    values (s.id, cred, addr, tier, p_code_hash, now() + interval '10 minutes', now(), p_token_hash, now() + interval '30 minutes');
    return jsonb_build_object('send', false, 'verified', true, 'tier', tier);
  end if;

  -- Any other address: the code goes to the certificate holder, and the price
  -- is bound to the address registering. Someone who copied an ID never sees it.
  select lower(btrim(c.holder_email)) into holder from public.credentials c where c.credential_id = cred;
  if coalesce(holder, '') !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then return jsonb_build_object('send', false, 'why', 'no_holder_email'); end if;
  insert into public.workshop_benefit_verifications (session_id, credential_id, email, tier, code_hash, expires_at)
  values (s.id, cred, addr, tier, p_code_hash, now() + interval '10 minutes');
  return jsonb_build_object('send', true, 'to', holder, 'tier', tier);
end $$;
revoke all on function public.workshop_benefit_request(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.workshop_benefit_request(text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Session administration
-- ---------------------------------------------------------------------------
create or replace function public.workshop_session_problems(s public.workshop_sessions)
returns text[] language plpgsql stable set search_path = '' as $$
declare
  p text[] := '{}';
begin
  if s.starts_at is null then p := p || 'no_date'::text;
  elsif s.starts_at <= now() then p := p || 'date_past'::text; end if;
  if coalesce(btrim(s.content ->> 'summary'), '') = '' then p := p || 'no_summary'::text; end if;
  if s.admission = 'invite' and s.calendar_event_id is null then p := p || 'no_calendar_event'::text; end if;
  if s.graduate_free and s.reserved_graduate_seats = 0 then p := p || 'graduate_free_needs_places'::text; end if;
  return p;
end $$;

create or replace function public.workshop_admin_session(
  p_actor_email text, p_action text, p_session_id uuid default null, p_data jsonb default '{}'::jsonb, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  d jsonb := coalesce(p_data, '{}'::jsonb);
  cfg public.workshop_settings;
  general_used int := 0;
  grad_used int := 0;
  regs int := 0;
  problems text[];
  stamp text;
  reason text := btrim(coalesce(p_reason, ''));
  new_slug text;
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;
  stamp := to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC ' || p_action || coalesce(': ' || nullif(left(reason, 300), ''), '');

  if p_session_id is not null then
    select * into s from public.workshop_sessions where id = p_session_id for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    select count(*) into regs from public.workshop_registrations where session_id = s.id;
    general_used := public.workshop_seats_in_use(s.id, null);
    grad_used := public.workshop_graduate_seats_in_use(s.id);
  elsif p_action <> 'save' then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if p_action = 'save' then
   -- One block: a refusal anywhere in it (an edit that would leave a published
   -- session unpublishable, a taken Calendar event, an invalid value) undoes the
   -- whole save, so a workshop is never left half edited.
   begin
    if p_session_id is null then
      select * into cfg from public.workshop_settings where id;
      new_slug := lower(btrim(coalesce(d ->> 'slug', '')));
      if exists (select 1 from public.workshop_sessions where slug = new_slug) then return jsonb_build_object('ok', false, 'error', 'slug_taken'); end if;
      begin
        insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs, capacity, status,
          admission, reserved_graduate_seats, foundations_discount_pct, graduate_free,
          referral_discount_ghs, referral_commission_ghs, is_test, admin_notes)
        values (new_slug, coalesce(d ->> 'kind', 'workshop'), btrim(coalesce(d ->> 'title', '')), nullif(d ->> 'starts_at', '')::timestamptz,
          coalesce((d ->> 'duration_minutes')::int, 180), coalesce(nullif(btrim(d ->> 'format'), ''), 'live online'),
          coalesce((d ->> 'price_ghs')::numeric, 0), nullif((d ->> 'capacity')::int, 0), 'draft',
          coalesce(d ->> 'admission', 'link'), coalesce((d ->> 'reserved_graduate_seats')::int, 0),
          coalesce((d ->> 'foundations_discount_pct')::int, 0), coalesce((d ->> 'graduate_free')::boolean, false),
          coalesce(cfg.referral_discount_ghs, 0), coalesce(cfg.referral_commission_ghs, 0),
          coalesce((d ->> 'is_test')::boolean, false), stamp)
        returning * into s;
      exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format
                     or datetime_field_overflow or numeric_value_out_of_range then
        raise exception using errcode = 'WS002', message = 'invalid|' || sqlerrm;
      end;
    else
      new_slug := coalesce(nullif(lower(btrim(coalesce(d ->> 'slug', ''))), ''), s.slug);
      -- A page address someone may have shared never changes once registration has opened.
      if new_slug <> s.slug and (s.status <> 'draft' or regs > 0) then return jsonb_build_object('ok', false, 'error', 'slug_locked'); end if;
      if new_slug <> s.slug and exists (select 1 from public.workshop_sessions where slug = new_slug) then return jsonb_build_object('ok', false, 'error', 'slug_taken'); end if;
      if d ? 'capacity' and coalesce((d ->> 'capacity')::int, 0) < general_used then
        return jsonb_build_object('ok', false, 'error', 'capacity_below_taken', 'taken', general_used);
      end if;
      if d ? 'reserved_graduate_seats' and coalesce((d ->> 'reserved_graduate_seats')::int, 0) < grad_used then
        return jsonb_build_object('ok', false, 'error', 'graduate_below_taken', 'taken', grad_used);
      end if;
      if d ? 'starts_at' and s.status <> 'draft' and nullif(d ->> 'starts_at', '') is null then
        return jsonb_build_object('ok', false, 'error', 'date_required');
      end if;
      begin
        update public.workshop_sessions set
          slug = new_slug,
          kind = case when d ? 'kind' then d ->> 'kind' else kind end,
          title = case when d ? 'title' then btrim(d ->> 'title') else title end,
          starts_at = case when d ? 'starts_at' then nullif(d ->> 'starts_at', '')::timestamptz else starts_at end,
          duration_minutes = case when d ? 'duration_minutes' then (d ->> 'duration_minutes')::int else duration_minutes end,
          format = case when d ? 'format' then coalesce(nullif(btrim(d ->> 'format'), ''), format) else format end,
          price_ghs = case when d ? 'price_ghs' then (d ->> 'price_ghs')::numeric else price_ghs end,
          capacity = case when d ? 'capacity' then nullif((d ->> 'capacity')::int, 0) else capacity end,
          admission = case when d ? 'admission' then d ->> 'admission' else admission end,
          reserved_graduate_seats = case when d ? 'reserved_graduate_seats' then (d ->> 'reserved_graduate_seats')::int else reserved_graduate_seats end,
          foundations_discount_pct = case when d ? 'foundations_discount_pct' then (d ->> 'foundations_discount_pct')::int else foundations_discount_pct end,
          graduate_free = case when d ? 'graduate_free' then (d ->> 'graduate_free')::boolean else graduate_free end,
          admin_notes = concat_ws(E'\n', admin_notes, stamp)
        where id = s.id returning * into s;
      exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format
                     or datetime_field_overflow or numeric_value_out_of_range then
        raise exception using errcode = 'WS002', message = 'invalid|' || sqlerrm;
      end;
    end if;

    -- Fields shared by create and update.
    begin
      update public.workshop_sessions set
        calendar_event_id = case when d ? 'calendar_event_id' then nullif(btrim(d ->> 'calendar_event_id'), '') else calendar_event_id end,
        join_instructions = case when d ? 'join_instructions' then nullif(btrim(d ->> 'join_instructions'), '') else join_instructions end,
        content = case when jsonb_typeof(d -> 'content') = 'object' then d -> 'content' else content end,
        series_slug = case when d ? 'series_slug' then nullif(d ->> 'series_slug', '') else series_slug end,
        series_number = case when d ? 'series_number' then nullif((d ->> 'series_number')::int, 0) else series_number end,
        announce = case when d ? 'announce' then coalesce((d ->> 'announce')::boolean, false) else announce end
      where id = s.id returning * into s;
    exception
      when unique_violation then
        raise exception using errcode = 'WS002', message = case when sqlerrm like '%calendar%' then 'calendar_event_taken' else 'series_number_taken' end;
      when check_violation or foreign_key_violation or invalid_text_representation or numeric_value_out_of_range then
        raise exception using errcode = 'WS002', message = 'invalid|' || sqlerrm;
    end;

    -- A published session must stay publishable after every edit.
    if s.status = 'published' then
      problems := public.workshop_session_problems(s);
      if array_length(problems, 1) > 0 then
        raise exception using errcode = 'WS001', message = array_to_string(problems, ',');
      end if;
    end if;
    return jsonb_build_object('ok', true, 'id', s.id, 'slug', s.slug, 'status', s.status);
   exception
    when sqlstate 'WS001' then
     return jsonb_build_object('ok', false, 'error', 'not_publishable', 'problems', to_jsonb(string_to_array(sqlerrm, ',')));
    -- Any other refusal inside the save: everything the save wrote is undone with it.
    when sqlstate 'WS002' then
     return jsonb_build_object('ok', false, 'error', split_part(sqlerrm, '|', 1), 'detail', nullif(split_part(sqlerrm, '|', 2), ''));
   end;

  elsif p_action = 'publish' then
    if s.status not in ('draft', 'closed') then return jsonb_build_object('ok', false, 'error', 'bad_state'); end if;
    problems := public.workshop_session_problems(s);
    if array_length(problems, 1) > 0 then return jsonb_build_object('ok', false, 'error', 'not_publishable', 'problems', to_jsonb(problems)); end if;
    update public.workshop_sessions set status = 'published', announce = false, admin_notes = concat_ws(E'\n', admin_notes, stamp)
     where id = s.id;

  elsif p_action = 'close' then
    if s.status <> 'published' then return jsonb_build_object('ok', false, 'error', 'bad_state'); end if;
    update public.workshop_sessions set status = 'closed', admin_notes = concat_ws(E'\n', admin_notes, stamp) where id = s.id;

  elsif p_action = 'complete' then
    if s.status not in ('published', 'closed') then return jsonb_build_object('ok', false, 'error', 'bad_state'); end if;
    if s.starts_at > now() then return jsonb_build_object('ok', false, 'error', 'not_started'); end if;
    update public.workshop_sessions set status = 'completed', admin_notes = concat_ws(E'\n', admin_notes, stamp) where id = s.id;

  elsif p_action = 'cancel' then
    if s.status in ('cancelled', 'completed') then return jsonb_build_object('ok', false, 'error', 'bad_state'); end if;
    if length(reason) < 5 then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
    -- Registration stops. Paid places stay on record for a refund or a move;
    -- nothing is refunded or emailed here.
    update public.workshop_sessions set status = 'cancelled', announce = false, admin_notes = concat_ws(E'\n', admin_notes, stamp) where id = s.id;

  elsif p_action = 'delete' then
    if regs > 0 or exists (select 1 from public.workshop_waitlist w where w.session_id = s.id) then
      return jsonb_build_object('ok', false, 'error', 'has_registrations');
    end if;
    delete from public.workshop_sessions where id = s.id;
    return jsonb_build_object('ok', true, 'deleted', true);

  else
    return jsonb_build_object('ok', false, 'error', 'bad_action');
  end if;
  return jsonb_build_object('ok', true, 'id', s.id);
end $$;

create or replace function public.workshop_admin_series(p_actor_email text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d jsonb := coalesce(p_data, '{}'::jsonb);
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;
  begin
    insert into public.workshop_series (slug, name, presenter, positioning, intro, standalone, disclaimer, updated_at)
    values (d ->> 'slug', btrim(d ->> 'name'), btrim(coalesce(d ->> 'presenter', 'Bulletproof Automations')),
      btrim(coalesce(d ->> 'positioning', '')), coalesce(d -> 'intro', '[]'::jsonb), btrim(coalesce(d ->> 'standalone', '')),
      btrim(coalesce(d ->> 'disclaimer', '')), now())
    on conflict (slug) do update set name = excluded.name, presenter = excluded.presenter, positioning = excluded.positioning,
      intro = excluded.intro, standalone = excluded.standalone, disclaimer = excluded.disclaimer, updated_at = now();
  exception when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'error', 'invalid', 'detail', sqlerrm);
  end;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Referral codes and terms
-- ---------------------------------------------------------------------------
create or replace function public.workshop_admin_referrer(
  p_actor_email text, p_action text, p_referrer_id uuid default null, p_data jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d jsonb := coalesce(p_data, '{}'::jsonb);
  x public.workshop_referrers;
  r public.workshop_registrations;
  new_code text := upper(btrim(coalesce(d ->> 'code', '')));
  addr text := lower(btrim(coalesce(d ->> 'email', '')));
  ref text := btrim(coalesce(d ->> 'reference', ''));
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  n int := 0;
  total numeric(10,2) := 0;
  i int;
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;

  if p_action = 'create' then
    if length(btrim(coalesce(d ->> 'name', ''))) < 2 then return jsonb_build_object('ok', false, 'error', 'name_required'); end if;
    if addr !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then return jsonb_build_object('ok', false, 'error', 'bad_email'); end if;
    if length(btrim(coalesce(d ->> 'payout_method', ''))) < 3 then return jsonb_build_object('ok', false, 'error', 'payout_required'); end if;
    if new_code = '' then
      loop
        new_code := '';
        for i in 1..6 loop new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1); end loop;
        exit when not exists (select 1 from public.workshop_referrers where code = new_code);
      end loop;
    elsif new_code !~ '^[A-Z0-9]{4,16}$' then return jsonb_build_object('ok', false, 'error', 'bad_code');
    elsif exists (select 1 from public.workshop_referrers where code = new_code) then return jsonb_build_object('ok', false, 'error', 'code_taken');
    end if;
    insert into public.workshop_referrers (code, name, email, payout_method, status, created_by)
    values (new_code, btrim(d ->> 'name'), addr, btrim(d ->> 'payout_method'), 'active', lower(p_actor_email))
    returning * into x;
    return jsonb_build_object('ok', true, 'id', x.id, 'code', x.code);

  elsif p_action = 'update' then
    if addr <> '' and addr !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then return jsonb_build_object('ok', false, 'error', 'bad_email'); end if;
    begin
      update public.workshop_referrers set
        name = coalesce(nullif(btrim(d ->> 'name'), ''), name),
        email = coalesce(nullif(addr, ''), email),
        payout_method = coalesce(nullif(btrim(d ->> 'payout_method'), ''), payout_method)
       where id = p_referrer_id returning * into x;
    exception when check_violation then return jsonb_build_object('ok', false, 'error', 'invalid', 'detail', sqlerrm);
    end;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    return jsonb_build_object('ok', true);

  elsif p_action in ('suspend', 'activate') then
    update public.workshop_referrers set status = case when p_action = 'suspend' then 'suspended' else 'active' end
     where id = p_referrer_id returning * into x;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    return jsonb_build_object('ok', true, 'status', x.status);

  elsif p_action = 'record_payouts' then
    -- Every commission this code has earned and not been paid, under one reference.
    if length(ref) < 3 then return jsonb_build_object('ok', false, 'error', 'reference_required'); end if;
    for r in select * from public.workshop_registrations g
              where g.referrer_id = p_referrer_id
                and not exists (select 1 from public.workshop_referral_payouts p where p.registration_id = g.id)
              for update loop
      if public.workshop_commission_payable(r) then
        insert into public.workshop_referral_payouts (registration_id, referrer_id, amount_ghs, payout_reference, recorded_by)
        values (r.id, r.referrer_id, r.commission_ghs, left(ref, 120), lower(p_actor_email));
        n := n + 1; total := total + r.commission_ghs;
      end if;
    end loop;
    if n = 0 then return jsonb_build_object('ok', false, 'error', 'nothing_due'); end if;
    return jsonb_build_object('ok', true, 'count', n, 'amount_ghs', total);

  elsif p_action = 'set_terms' then
    if coalesce((d ->> 'discount_ghs')::numeric, -1) < 0 or coalesce((d ->> 'commission_ghs')::numeric, -1) < 0 then
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;
    update public.workshop_settings set referral_discount_ghs = (d ->> 'discount_ghs')::numeric,
      referral_commission_ghs = (d ->> 'commission_ghs')::numeric, updated_at = now(), updated_by = lower(p_actor_email)
     where id;
    -- Applies to every workshop still taking or about to take registrations.
    -- Registrations already made keep the terms they were made under.
    update public.workshop_sessions set referral_discount_ghs = least((d ->> 'discount_ghs')::numeric, price_ghs),
      referral_commission_ghs = (d ->> 'commission_ghs')::numeric
     where status in ('draft', 'published', 'closed');
    return jsonb_build_object('ok', true);
  end if;
  return jsonb_build_object('ok', false, 'error', 'bad_action');
end $$;

-- Pages rendering reads through the service role; the admin's own RPCs are
-- called by /api/admin/workshops with the service role after it has checked
-- the signed-in admin. None is callable by anon or authenticated.
revoke all on function public.workshop_session_problems(public.workshop_sessions) from public, anon, authenticated;
revoke all on function public.workshop_admin_session(text, text, uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.workshop_admin_series(text, jsonb) from public, anon, authenticated;
revoke all on function public.workshop_admin_referrer(text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.workshop_session_problems(public.workshop_sessions) to service_role;
grant execute on function public.workshop_admin_session(text, text, uuid, jsonb, text) to service_role;
grant execute on function public.workshop_admin_series(text, jsonb) to service_role;
grant execute on function public.workshop_admin_referrer(text, text, uuid, jsonb) to service_role;
