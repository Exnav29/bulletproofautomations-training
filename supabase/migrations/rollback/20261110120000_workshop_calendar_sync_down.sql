-- Rollback of 20261110120000_workshop_calendar_sync.sql. It drops only what
-- release 3 added. The invitation fields (release 2) keep whatever the sync
-- recorded, so the manual panel in /admin/workshops/ carries on from there.
-- Unset GOOGLE_CALENDAR_REFRESH_TOKEN on Cloudflare Pages first, so the
-- dispatcher stops calling Google before these functions disappear.

-- Registration open until the start again, verbatim from 20261103120000_workshops.sql.
create or replace function public.workshop_session_open(s public.workshop_sessions)
returns boolean language sql stable set search_path = '' as $$
  select s.status = 'published' and s.starts_at > now()
$$;
drop function if exists public.workshop_calendar_retry(text, uuid);
drop function if exists public.workshop_calendar_record(uuid, boolean, text, text, text, boolean);
drop function if exists public.workshop_calendar_plan(boolean, integer);
alter table public.workshop_registrations
  drop column if exists calendar_sync_at,
  drop column if exists calendar_sync_error,
  drop column if exists calendar_sync_failures;
