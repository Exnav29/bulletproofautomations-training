-- ===========================================================================
-- Release 7: streamlined workshop administration.
--
--   * Series defaults (workshop_series.defaults): a workshop created in a series
--     takes its price, places, discounts, length, start time and joining method
--     from the series unless told otherwise. Stored on the workshop when it is
--     created or scheduled, never looked up at payment time, so changing a
--     default never alters a workshop that exists (Workshop 01 included).
--   * Duplicate (workshop_admin_session 'copy'): content and settings, as a
--     draft with a new address and no date, registrations, event or Meet link.
--   * Automatic Google Calendar events: the admin API creates the event and its
--     Meet link and records them with workshop_admin_calendar(). The Meet link
--     is private (meet_link), never selected for a public page.
--   * A changed date or length marks the event as needing an update, and
--     registration cannot open on an event that does not match the date.
--
-- Additive and reversible: rollback/20261114120000_workshop_admin_streamline_down.sql.
-- Nothing here changes a registration, a payment, a price rule or a seat count.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Series defaults
-- ---------------------------------------------------------------------------
alter table public.workshop_series
  add column if not exists defaults jsonb not null default '{}'::jsonb check (jsonb_typeof(defaults) = 'object');

-- The Get Paid for Automation series: Workshop 01's settings, which 02 to 10 already carry.
update public.workshop_series set defaults = '{"kind": "workshop", "duration_minutes": 180, "start_time": "11:30",
  "format": "live online", "price_ghs": 350, "capacity": 25, "reserved_graduate_seats": 5,
  "foundations_discount_pct": 20, "graduate_free": true, "admission": "invite"}'::jsonb
where slug = 'get-paid-for-automation' and defaults = '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. Google Calendar state on the workshop
-- ---------------------------------------------------------------------------
alter table public.workshop_sessions
  add column if not exists meet_link text check (meet_link is null or meet_link ~ '^https://meet\.google\.com/[a-z0-9-]{3,60}$'),
  add column if not exists calendar_managed boolean not null default false,
  add column if not exists calendar_status text not null default 'none'
    check (calendar_status in ('none', 'ready', 'failed', 'needs_update')),
  add column if not exists calendar_error text check (calendar_error is null or length(calendar_error) <= 500),
  add column if not exists calendar_synced jsonb check (calendar_synced is null or jsonb_typeof(calendar_synced) = 'object');

-- Events attached by hand before release 7 (Workshop 01's) are in step with their
-- workshop and are the owner's own: kept exactly as they are.
update public.workshop_sessions set calendar_status = 'ready'
where calendar_event_id is not null and calendar_status = 'none';

-- ---------------------------------------------------------------------------
-- 3. Session actions: series defaults on create, Calendar bookkeeping, copy
-- ---------------------------------------------------------------------------
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
  n int;
  c public.workshop_sessions;
  old_starts timestamptz;
  old_duration int;
  old_title text;
  old_event text;
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
      -- Release 7: a workshop created in a series takes the series defaults for
      -- anything not sent. Sent values always win.
      d := (coalesce((select x.defaults from public.workshop_series x where x.slug = nullif(d ->> 'series_slug', '')), '{}'::jsonb) - 'start_time') || d;
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
      old_starts := s.starts_at; old_duration := s.duration_minutes; old_title := s.title;
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
    old_event := s.calendar_event_id;
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

    -- Release 7: Google Calendar bookkeeping. An event ID typed in by hand is the
    -- owner's own event: never treated as one this system created. A changed date,
    -- length or (for an event this system created) title marks the event as
    -- needing an update, which the admin API makes straight after the save.
    if s.calendar_event_id is distinct from old_event then
      update public.workshop_sessions set calendar_managed = false, meet_link = null, calendar_synced = null, calendar_error = null,
        calendar_status = case when calendar_event_id is null then 'none' else 'ready' end
      where id = s.id returning * into s;
    elsif s.calendar_event_id is not null and p_session_id is not null and (s.starts_at is distinct from old_starts
          or s.duration_minutes is distinct from old_duration or (s.calendar_managed and s.title is distinct from old_title)) then
      update public.workshop_sessions set calendar_status = 'needs_update' where id = s.id returning * into s;
    end if;

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
    -- Release 7: never open registration on an event that does not match the date.
    if s.admission = 'invite' and s.calendar_event_id is not null and s.calendar_status in ('needs_update', 'failed') then
      problems := array_append(coalesce(problems, '{}'::text[]), 'calendar_not_updated');
    end if;
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

  elsif p_action = 'copy' then
    -- Release 7: a duplicate is a draft with the same page content and settings,
    -- a new page address, no date, no registrations, no Calendar event, no Meet
    -- link and no joining instructions (those carry the original's meeting).
    select * into cfg from public.workshop_settings where id;
    new_slug := left(s.slug, 70) || '-copy'; n := 2;
    while exists (select 1 from public.workshop_sessions where slug = new_slug) loop
      new_slug := left(s.slug, 70) || '-copy-' || n; n := n + 1;
    end loop;
    insert into public.workshop_sessions (slug, kind, title, starts_at, duration_minutes, format, price_ghs, capacity, status,
      admission, reserved_graduate_seats, foundations_discount_pct, graduate_free, referral_discount_ghs, referral_commission_ghs,
      is_test, admin_notes, content, series_slug, series_number, announce)
    values (new_slug, s.kind, left(s.title || ' (copy)', 160), null, s.duration_minutes, s.format, s.price_ghs, s.capacity, 'draft',
      s.admission, s.reserved_graduate_seats, s.foundations_discount_pct, s.graduate_free,
      coalesce(cfg.referral_discount_ghs, s.referral_discount_ghs), coalesce(cfg.referral_commission_ghs, s.referral_commission_ghs),
      s.is_test, stamp || ' from ' || s.slug, s.content, s.series_slug, null, false)
    returning * into c;
    return jsonb_build_object('ok', true, 'id', c.id, 'slug', c.slug, 'status', c.status);

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
    insert into public.workshop_series (slug, name, presenter, positioning, intro, standalone, disclaimer, defaults, updated_at)
    values (d ->> 'slug', btrim(d ->> 'name'), btrim(coalesce(d ->> 'presenter', 'Bulletproof Automations')),
      btrim(coalesce(d ->> 'positioning', '')), coalesce(d -> 'intro', '[]'::jsonb), btrim(coalesce(d ->> 'standalone', '')),
      btrim(coalesce(d ->> 'disclaimer', '')),
      case when jsonb_typeof(d -> 'defaults') = 'object' then d -> 'defaults' else '{}'::jsonb end, now())
    on conflict (slug) do update set name = excluded.name, presenter = excluded.presenter, positioning = excluded.positioning,
      intro = excluded.intro, standalone = excluded.standalone, disclaimer = excluded.disclaimer,
      -- Release 7: defaults change only when sent, and never touch an existing workshop.
      defaults = case when jsonb_typeof(d -> 'defaults') = 'object' then d -> 'defaults' else public.workshop_series.defaults end,
      updated_at = now();
  exception when check_violation or not_null_violation then
    return jsonb_build_object('ok', false, 'error', 'invalid', 'detail', sqlerrm);
  end;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Recording what Google Calendar did (called by the admin API only)
-- ---------------------------------------------------------------------------
create or replace function public.workshop_admin_calendar(p_actor_email text, p_session_id uuid, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  d jsonb := coalesce(p_data, '{}'::jsonb);
  stamp text;
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;
  select * into s from public.workshop_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  stamp := to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC calendar ' || coalesce(d ->> 'result', '?');

  if d ->> 'result' = 'ready' then
    -- An event already attached is never replaced by a different one.
    if s.calendar_event_id is not null and s.calendar_event_id <> d ->> 'event_id' then
      return jsonb_build_object('ok', false, 'error', 'calendar_event_taken');
    end if;
    begin
      update public.workshop_sessions set
        calendar_event_id = d ->> 'event_id',
        meet_link = case when d ? 'meet_link' then nullif(d ->> 'meet_link', '') else meet_link end,
        calendar_managed = case when d ? 'managed' then (d ->> 'managed')::boolean else calendar_managed end,
        calendar_status = 'ready', calendar_error = null,
        calendar_synced = case when jsonb_typeof(d -> 'synced') = 'object' then d -> 'synced' else calendar_synced end,
        admin_notes = concat_ws(E'\n', admin_notes, stamp)
      where id = s.id;
    exception
      when unique_violation then return jsonb_build_object('ok', false, 'error', 'calendar_event_taken');
      when check_violation then return jsonb_build_object('ok', false, 'error', 'invalid', 'detail', sqlerrm);
    end;
  elsif d ->> 'result' = 'failed' then
    update public.workshop_sessions set
      calendar_status = case when calendar_event_id is null then 'failed' else 'needs_update' end,
      calendar_error = left(coalesce(d ->> 'error', 'Google Calendar did not respond as expected'), 500),
      admin_notes = concat_ws(E'\n', admin_notes, stamp || ': ' || left(coalesce(d ->> 'error', ''), 200))
    where id = s.id;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_action');
  end if;
  return jsonb_build_object('ok', true, 'id', s.id);
end $$;

revoke all on function public.workshop_admin_calendar(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.workshop_admin_calendar(text, uuid, jsonb) to service_role;
revoke all on function public.workshop_admin_session(text, text, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.workshop_admin_session(text, text, uuid, jsonb, text) to service_role;
revoke all on function public.workshop_admin_series(text, jsonb) from public, anon, authenticated;
grant execute on function public.workshop_admin_series(text, jsonb) to service_role;
