-- ---------------------------------------------------------------------------
-- Workshop release 3: automatic Google Calendar invitations.
--
-- STATUS: NOT APPLIED. Apply only with the owner's explicit approval, after
-- release 2 (20261109120000). Rollback:
-- supabase/migrations/rollback/20261110120000_workshop_calendar_sync_down.sql
--
-- Additive only. It replaces no existing function and touches no payment,
-- enrollment or cohort object. The admission records release 2 added
-- (attend_email, invited_email, invited_at, invite_removed_at) stay the record
-- of who is on each session's Google Calendar event; the dispatcher
-- (functions/api/_calendar.js, run by the existing workshop-dispatch job) now
-- keeps the event in step with them instead of the admin doing it by hand.
--
--   workshop_calendar_plan      what the event should change, with the same
--                               rules the admin panel and
--                               workshop_admin_admission already use
--   workshop_calendar_record    what Google confirmed, or why it failed
--   workshop_calendar_retry     the admin's "retry" on the exception queue
--
-- A registration that fails 5 times (or once, on a permanent error such as a
-- missing event or an address Google refuses) stops being retried and shows in
-- /admin/workshops/ until the admin retries it.
-- ---------------------------------------------------------------------------

alter table public.workshop_registrations
  add column if not exists calendar_sync_failures integer not null default 0 check (calendar_sync_failures >= 0),
  add column if not exists calendar_sync_error text,
  add column if not exists calendar_sync_at timestamptz;

-- One row per registration whose Google Calendar invitation must change:
--   add_email     the account to add (confirmed and paid, or a still-eligible
--                 complimentary graduate place)
--   remove_email  the account to remove (refunded, cancelled, refund requested,
--                 or replaced by an approved change of account)
--   blocked       a reason nothing can be sent (a graduate place whose
--                 entitlement lapsed): recorded as an exception, never invited
-- Test and live never mix: p_test selects test sessions only, or live only.
create or replace function public.workshop_calendar_plan(p_test boolean, p_limit integer default 10)
returns table (registration_id uuid, session_id uuid, calendar_event_id text, add_email text, remove_email text, blocked text)
language sql stable security definer set search_path = '' as $$
  with candidates as (
    select r.id, r.session_id, s.calendar_event_id, r.created_at,
      (r.status = 'confirmed' and r.payment_status in ('paid', 'partially_refunded', 'not_required')) as entitled,
      -- coalesce: a lapsed certificate's tier is null, which must read as "not eligible", never as unknown.
      coalesce(r.price_tier <> 'graduate' or public.workshop_credential_tier(r.benefit_credential_id) = 'graduate', false) as eligible,
      r.attend_email, r.invited_email
    from public.workshop_registrations r
    join public.workshop_sessions s on s.id = r.session_id
    where s.admission = 'invite' and s.calendar_event_id is not null and s.is_test = p_test
      and s.status <> 'draft' and s.starts_at > now() - interval '1 day'
      and r.calendar_sync_failures < 5
  ), wanted as (
    select c.*,
      case when c.entitled and c.eligible and c.attend_email is not null
                and c.attend_email is distinct from c.invited_email
                -- One invitation per account per session, to the earliest registration.
                and not exists (select 1 from public.workshop_registrations o
                                 where o.session_id = c.session_id and o.id <> c.id and o.invited_email = c.attend_email)
                and c.id = (select o.id from public.workshop_registrations o
                             where o.session_id = c.session_id and o.attend_email = c.attend_email
                               and o.status = 'confirmed' order by o.created_at, o.id limit 1)
           then c.attend_email end as add_email,
      case when c.invited_email is not null
                and (not c.entitled or c.attend_email is distinct from c.invited_email)
           then c.invited_email end as remove_email,
      case when c.entitled and not c.eligible and c.invited_email is null and c.attend_email is not null
           then 'graduate_not_eligible' end as blocked
    from candidates c
  )
  select w.id, w.session_id, w.calendar_event_id, w.add_email, w.remove_email, w.blocked
    from wanted w
   where w.add_email is not null or w.remove_email is not null or w.blocked is not null
   order by w.created_at
   limit greatest(1, least(p_limit, 50))
$$;

-- Records the outcome of one sync attempt. On success the invitation fields
-- describe exactly what is on the event now; on failure the count rises, and a
-- permanent error stops retries at once.
create or replace function public.workshop_calendar_record(
  p_registration_id uuid, p_ok boolean, p_added text default null, p_removed text default null,
  p_error text default null, p_permanent boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.workshop_registrations;
  stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC calendar-sync ';
begin
  select * into r from public.workshop_registrations where id = p_registration_id for update;
  if not found then return; end if;
  if p_ok then
    update public.workshop_registrations set
      invited_email = case when p_added is not null then p_added
                           when p_removed is not null and invited_email = p_removed then null
                           else invited_email end,
      invited_at = case when p_added is not null then now() else invited_at end,
      invite_removed_at = case when p_removed is not null then now() else invite_removed_at end,
      calendar_sync_failures = 0, calendar_sync_error = null, calendar_sync_at = now(),
      admin_notes = concat_ws(E'\n', admin_notes,
        case when p_removed is not null then stamp || 'removed (' || p_removed || ')' end,
        case when p_added is not null then stamp || 'added (' || p_added || ')' end)
    where id = r.id;
  else
    update public.workshop_registrations set
      calendar_sync_failures = case when p_permanent then 5 else least(calendar_sync_failures + 1, 5) end,
      calendar_sync_error = left(coalesce(p_error, 'unknown error'), 300), calendar_sync_at = now()
    where id = r.id;
  end if;
end $$;

-- The admin's retry from the exception queue: clears the count and the error,
-- so the next dispatcher run (within a minute) tries again.
create or replace function public.workshop_calendar_retry(p_actor_email text, p_registration_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;
  update public.workshop_registrations set calendar_sync_failures = 0, calendar_sync_error = null,
    admin_notes = concat_ws(E'\n', admin_notes, to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC calendar-sync retry requested')
   where id = p_registration_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'workshop_calendar_plan(boolean,integer)',
    'workshop_calendar_record(uuid,boolean,text,text,text,boolean)',
    'workshop_calendar_retry(text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;
