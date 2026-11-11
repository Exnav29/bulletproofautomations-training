-- Rollback of 20261114120000_workshop_admin_streamline.sql. Restores the release 6
-- session and series functions verbatim and drops the release 7 objects. A Calendar
-- event created by release 7 stays on Google Calendar and its ID stays on the
-- workshop row, so invitations keep working after a rollback.
drop function if exists public.workshop_admin_calendar(text, uuid, jsonb);

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

revoke all on function public.workshop_admin_session(text, text, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.workshop_admin_session(text, text, uuid, jsonb, text) to service_role;
revoke all on function public.workshop_admin_series(text, jsonb) from public, anon, authenticated;
grant execute on function public.workshop_admin_series(text, jsonb) to service_role;

alter table public.workshop_sessions
  drop column if exists calendar_synced,
  drop column if exists calendar_error,
  drop column if exists calendar_status,
  drop column if exists calendar_managed,
  drop column if exists meet_link;
alter table public.workshop_series drop column if exists defaults;
