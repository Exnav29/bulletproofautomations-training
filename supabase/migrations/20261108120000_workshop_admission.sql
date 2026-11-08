-- ---------------------------------------------------------------------------
-- Workshop admission by Google Calendar invitation.
--
-- Additive only: new nullable or defaulted columns on two workshop tables and
-- two new functions. Nothing outside the workshop_* tables is touched, no
-- existing function is replaced, and no trigger is added to the payment path.
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

-- The admin's record of what they did on the Google Calendar event, and the
-- one place an attend_email changes after registration. Nothing here talks to
-- Google: the admin adds or removes the guest in Calendar, then records it.
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
    -- Only a confirmed registration, which means Paystack verified the payment
    -- (or an admin admitted money held for review).
    if r.status <> 'confirmed' then return jsonb_build_object('ok', false, 'error', 'not_confirmed'); end if;
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

revoke all on function public.workshop_set_attend_email(uuid, text) from public, anon, authenticated;
grant execute on function public.workshop_set_attend_email(uuid, text) to service_role;
revoke all on function public.workshop_admin_admission(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.workshop_admin_admission(text, uuid, text, text) to service_role;
