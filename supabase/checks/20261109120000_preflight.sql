-- Release 2 preflight: READ-ONLY. Run before applying
-- 20261109120000_workshop_admission_benefits.sql, and keep the output.
-- Every "ok" must be true. The "snapshot" values are compared again after the
-- migration by 20261109120000_postflight.sql: they must be identical.
-- Expected values are from the read-only run on 9 November 2026.
select json_build_object(
  -- 1. Release 1 is applied (do NOT reapply it); release 2 is not.
  'ok_release1_applied', exists (select 1 from supabase_migrations.schema_migrations where version = '20261103120000'),
  'ok_release2_not_recorded', not exists (select 1 from supabase_migrations.schema_migrations where version = '20261109120000'),
  'ok_release2_objects_absent', not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'workshop_sessions' and column_name in ('admission', 'is_test', 'reserved_graduate_seats'))
    and to_regclass('public.workshop_referrers') is null and to_regprocedure('public.workshop_price(uuid,text,text,text)') is null,
  -- 2. Release 1's 8 tables are present.
  'ok_release1_tables', (select count(*) from information_schema.tables where table_schema = 'public' and table_name like 'workshop%') = 8,
  -- 3. Every session can be classified test or live: none has both kinds of payment.
  'ok_no_mixed_sessions', not exists (select 1 from public.workshop_sessions s
      where exists (select 1 from public.workshop_payment_attempts a join public.workshop_registrations r on r.id = a.registration_id where r.session_id = s.id and a.mode = 'test')
        and exists (select 1 from public.workshop_payment_attempts a join public.workshop_registrations r on r.id = a.registration_id where r.session_id = s.id and a.mode = 'live')),
  -- Expected: ["test-webinar-checkout"]. These become is_test = true.
  'will_become_test_sessions', (select json_agg(s.slug order by s.slug) from public.workshop_sessions s
      where exists (select 1 from public.workshop_payment_attempts a join public.workshop_registrations r on r.id = a.registration_id where r.session_id = s.id and a.mode = 'test')),
  -- Expected: 0. No live payment has ever been taken for a workshop.
  'live_attempts', (select count(*) from public.workshop_payment_attempts where mode = 'live'),
  -- 4. Workshop 01: draft, GHS 350, 25 places, joining details stored, no registrations.
  'ok_w01', exists (select 1 from public.workshop_sessions s where s.slug = 'what-to-charge-for-automation' and s.status = 'draft'
      and s.price_ghs = 350 and s.capacity = 25 and s.join_instructions is not null
      and not exists (select 1 from public.workshop_registrations r where r.session_id = s.id)),
  -- 5. The certificate register and PR #54 (read, never written).
  'ok_pr54_view', to_regclass('private.studio_graduate_webinar_entitlements_by_certificate') is not null,
  'active_graduate_entitlements', (select count(*) from private.studio_graduate_webinar_entitlements_by_certificate where entitlement_status = 'active'),  -- expected 2
  'valid_foundations_certificates', (select count(*) from public.credentials where credential = 'foundations' and status = 'valid'),                     -- expected 10
  -- 6. Snapshot of everything outside the workshop tables. Must not change.
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
  ),
  -- 7. The three release 1 functions release 2 replaces. After a rollback,
  -- 20261109120000_rollback_check.sql must report these same hashes.
  'release1_bodies', (select json_object_agg(p.proname, md5(replace(p.prosrc, E'\r', ''))) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('workshop_register', 'workshop_start_attempt', 'workshop_seats_in_use')),
  -- 8. The dispatcher still points at the preview until merge.
  'dispatcher_target', (select substring(command from 'https://[^/'']+') from cron.job where jobname = 'workshop-dispatch')
) as preflight;
