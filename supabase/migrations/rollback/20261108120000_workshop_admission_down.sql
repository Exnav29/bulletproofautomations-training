-- Rollback of 20261108120000_workshop_admission.sql. Drops only what it added.
-- Run the up migration's down BEFORE 20261103120000_workshops_down.sql.
drop function if exists public.workshop_admin_admission(text, uuid, text, text);
drop function if exists public.workshop_set_attend_email(uuid, text);
alter table public.workshop_registrations
  drop column if exists invite_removed_at,
  drop column if exists invited_at,
  drop column if exists invited_email,
  drop column if exists attend_email;
alter table public.workshop_sessions
  drop column if exists calendar_event_id,
  drop column if exists admission;
