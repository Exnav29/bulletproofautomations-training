-- Release 2 postflight: READ-ONLY. Run straight after applying
-- 20261109120000_workshop_admission_benefits.sql. Every "ok" must be true, and
-- "snapshot" must equal the preflight's snapshot taken just before applying
-- (cohort activity can change it between days, so compare with that run).
select json_build_object(
  'ok_recorded', exists (select 1 from supabase_migrations.schema_migrations where version = '20261109120000'),
  -- Expected: [["test-webinar-checkout", true], ["what-to-charge-for-automation", false]]
  'sessions', (select json_agg(json_build_array(slug, is_test) order by slug) from public.workshop_sessions),
  -- Existing sessions behave as before until configured: link admission, no reserved places, no discounts.
  'ok_defaults', not exists (select 1 from public.workshop_sessions where admission <> 'link' or reserved_graduate_seats <> 0
      or foundations_discount_pct <> 0 or graduate_free or referral_discount_ghs <> 0 or referral_commission_ghs <> 0),
  'ok_tables', (select count(*) from information_schema.tables where table_schema = 'public' and table_name like 'workshop%') = 12,
  'ok_triggers', (select count(*) from pg_trigger where tgname in ('workshop_payout_guard', 'workshop_session_test_fixed')) = 2,
  'ok_closed_to_anon', not has_table_privilege('anon', 'public.workshop_referrers', 'select')
      and not has_table_privilege('anon', 'public.workshop_benefit_verifications', 'select')
      and not has_function_privilege('anon', 'public.workshop_price(uuid,text,text,text)', 'execute')
      and not has_function_privilege('anon', 'public.workshop_admin_referral(text,text,text,uuid,text,text,text,uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.workshop_quote(text,text,text,text,text)', 'execute'),
  -- No test registration's commission can be payable.
  'ok_no_test_commission', not exists (select 1 from public.workshop_registrations r
      where public.workshop_is_test_registration(r.id) and public.workshop_commission_payable(r)),
  'referrers', (select count(*) from public.workshop_referrers),   -- expected 0
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
) as postflight;
