-- Release 2 rollback verification: READ-ONLY. Run after
-- rollback/20261109120000_workshop_admission_benefits_down.sql. Every "ok" must be
-- true; "release1_bodies" must equal the preflight's, and "snapshot" the
-- preflight's taken just before the migration was applied.
select json_build_object(
  'ok_release2_objects_gone', not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name in ('workshop_sessions', 'workshop_registrations')
        and column_name in ('admission', 'calendar_event_id', 'is_test', 'reserved_graduate_seats', 'foundations_discount_pct', 'graduate_free',
          'referral_discount_ghs', 'referral_commission_ghs', 'attend_email', 'invited_email', 'price_tier', 'referral_code', 'commission_ghs'))
    and to_regclass('public.workshop_referrers') is null and to_regclass('public.workshop_referral_payouts') is null
    and to_regclass('public.workshop_benefit_verifications') is null and to_regclass('public.workshop_benefit_email_grants') is null
    and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in (
      'workshop_price', 'workshop_quote', 'workshop_benefit_request', 'workshop_benefit_confirm', 'workshop_admin_referral', 'workshop_admin_admission',
      'workshop_commission_payable', 'workshop_is_test_registration', 'workshop_payout_guard', 'workshop_session_test_fixed', 'workshop_set_attend_email',
      'workshop_credential_tier', 'workshop_email_may_claim', 'workshop_graduate_seats_in_use', 'workshop_obligations_met'))
    and not exists (select 1 from pg_trigger where tgname in ('workshop_payout_guard', 'workshop_session_test_fixed')),
  'ok_release1_tables', (select count(*) from information_schema.tables where table_schema = 'public' and table_name like 'workshop%') = 8,
  'release1_bodies', (select json_object_agg(p.proname, md5(replace(p.prosrc, E'\r', ''))) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('workshop_register', 'workshop_start_attempt', 'workshop_seats_in_use')),
  'snapshot', json_build_object(
    'payment_events_columns', (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'payment_events'),
    'payment_events', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.payment_events t),
    'enrollments', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.enrollments t),
    'installments', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.payment_plan_installments t),
    'credentials', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.credentials t),
    'entitlements', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.studio_graduate_webinar_entitlements t),
    -- Release 1 columns only: release 2 adds columns, so a whole-row hash would change.
    'workshop_registrations', (select md5(coalesce(string_agg(concat_ws(',', id, session_id, email_normalized, status, payment_status,
        amount_ghs, amount_paid_minor, paid_at, updated_at), '|' order by id), '')) from public.workshop_registrations),
    'workshop_sessions', (select md5(coalesce(string_agg(concat_ws(',', id, slug, status, price_ghs, capacity, starts_at,
        md5(coalesce(join_instructions, ''))), '|' order by id), '')) from public.workshop_sessions),
    'workshop_payment_attempts', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.workshop_payment_attempts t),
    'workshop_notifications', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.workshop_notifications t),
    'non_workshop_functions', (select md5(string_agg(p.proname || ':' || md5(p.prosrc), ',' order by p.proname, md5(p.prosrc)))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname not like 'workshop%')
  )
) as rollback_check;
