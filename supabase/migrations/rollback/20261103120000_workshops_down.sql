-- Rollback for 20261103120000_workshops.sql. NOT APPLIED.
--
-- Run only if the workshop feature is being withdrawn. It is destructive for
-- workshop data alone: enrollments, payment_plan_installments and existing
-- payment_events rows are untouched (only the added nullable column goes).
--
-- BEFORE RUNNING: export workshop_registrations, workshop_payment_attempts and
-- any payment_events rows with workshop_registration_id set. Those rows are the
-- evidence for money received; dropping them without an export loses it.
-- Unschedule the dispatcher first if it was created:
--   select cron.unschedule('workshop-dispatch');

begin;
alter table public.payment_events drop column if exists workshop_registration_id;

drop function if exists public.workshop_admin_action(text,uuid,text,text,text);
drop function if exists public.workshop_finish_meta_event(uuid,boolean,text);
drop function if exists public.workshop_claim_meta_events(integer);
drop function if exists public.workshop_finish_notification(uuid,boolean,text);
drop function if exists public.workshop_claim_notifications(integer);
drop function if exists public.workshop_claim_verify(text);
drop function if exists public.workshop_status_for_token(text,text);
drop function if exists public.workshop_apply_refund(text,bigint,text,uuid);
drop function if exists public.workshop_apply_charge(text,bigint,text,text,timestamptz,text,uuid);
drop function if exists public.workshop_recompute_payment(uuid);
drop function if exists public.workshop_attempt_init_failed(text,text);
drop function if exists public.workshop_start_attempt(uuid,text,text);
drop function if exists public.workshop_register(text,text,text,text,boolean,text,text,jsonb,boolean,numeric,timestamptz);
drop function if exists public.workshop_note_event(uuid,uuid,boolean,text);
drop function if exists public.workshop_enqueue_meta(public.workshop_registrations,text,text,numeric);

drop table if exists public.workshop_dispatch_config;
drop table if exists public.workshop_meta_events;
drop table if exists public.workshop_notifications;
drop table if exists public.workshop_payment_attempts;
drop table if exists public.workshop_status_tokens;
drop table if exists public.workshop_registrations;
drop function if exists public.workshop_session_open(public.workshop_sessions);
drop function if exists public.workshop_seats_in_use(uuid,uuid);
drop table if exists public.workshop_sessions;
drop function if exists public.workshop_attempt_immutable();
drop function if exists public.workshop_touch_updated_at();
commit;
