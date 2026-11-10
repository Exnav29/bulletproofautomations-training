-- Releases 3, 4 and 5: preflight AND postflight. READ-ONLY. Run it before applying
-- release 3, and again after each release. Save every output.
--
-- Before release 3:  ok_releases_1_2 true, release_3/4/5 false, ok_no_open_checkout true.
-- After each release: that release's flag true, every ok_ true, and "snapshot" EQUAL to the
--                     preflight's (the releases only add; nothing that exists may change).
-- After release 5:    ok_new_functions_closed true.
begin transaction read only;
select json_build_object(
  'ok_releases_1_2', (select count(*) from supabase_migrations.schema_migrations where version in ('20261103120000', '20261109120000')) = 2,
  'release_3', exists (select 1 from supabase_migrations.schema_migrations where version = '20261110120000'),
  'release_4', exists (select 1 from supabase_migrations.schema_migrations where version = '20261111120000'),
  'release_5', exists (select 1 from supabase_migrations.schema_migrations where version = '20261112120000'),
  -- Objects match the history: a release is recorded exactly when its objects exist.
  'ok_release_3_objects', exists (select 1 from supabase_migrations.schema_migrations where version = '20261110120000')
      = exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'workshop_calendar_plan'),
  'ok_release_4_objects', exists (select 1 from supabase_migrations.schema_migrations where version = '20261111120000')
      = exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'workshop_waitlist'),
  'ok_release_5_objects', exists (select 1 from supabase_migrations.schema_migrations where version = '20261112120000')
      = exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workshop_registrations' and column_name = 'calendar_managed_emails'),
  -- No checkout in flight: releases 3 to 5 change hold and payment functions.
  'ok_no_open_checkout', not exists (select 1 from public.workshop_payment_attempts where status = 'initialized' and created_at > now() - interval '1 hour'),
  'ok_rls', not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'workshop%' and not c.relrowsecurity),
  'ok_new_functions_closed', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'workshop%' and p.prosecdef
        and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  'dispatcher', (select json_agg(json_build_object('active', active, 'schedule', schedule, 'target', substring(command from 'https://[^/'']+')))
      from cron.job where jobname = 'workshop-dispatch'),
  'snapshot', json_build_object(
    'payment_events', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.payment_events t),
    'enrollments', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.enrollments t),
    'installments', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.payment_plan_installments t),
    'credentials', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.credentials t),
    'entitlements', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from private.studio_graduate_webinar_entitlements t),
    -- Columns that exist before release 3 only: releases 3 and 5 add columns to these tables.
    'workshop_registrations', (select md5(coalesce(string_agg(concat_ws(',', id, session_id, email_normalized, status, payment_status,
        amount_ghs, amount_paid_minor, paid_at, updated_at), '|' order by id), '')) from public.workshop_registrations),
    'workshop_payment_attempts', (select md5(coalesce(string_agg(concat_ws(',', id, registration_id, reference, status, amount_minor,
        created_at), '|' order by id), '')) from public.workshop_payment_attempts),
    'workshop_payment_events', (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.workshop_payment_events t),
    'workshop_sessions', (select md5(coalesce(string_agg(concat_ws(',', id, slug, status, is_test, price_ghs, capacity, starts_at),
        '|' order by id), '')) from public.workshop_sessions),
    'non_workshop_functions', (select md5(string_agg(p.proname || ':' || md5(p.prosrc), ',' order by p.proname, md5(p.prosrc)))
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname not like 'workshop%')
  )
) as check;
rollback;
