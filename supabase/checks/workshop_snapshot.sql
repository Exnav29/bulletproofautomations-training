-- Workshop snapshot: READ-ONLY. Take it immediately before applying any workshop release, and keep
-- the output privately (it holds registrants' emails). Supabase holds no backup of this project
-- (point-in-time recovery is off). Each table is base64 of its JSON rows; every public.workshop*
-- function definition and the dispatcher job are included (the job reads its secret from Vault).
begin transaction read only;
select jsonb_build_object(
  'taken_at', now(),
  'migrations', (select jsonb_agg(version order by version) from supabase_migrations.schema_migrations where version >= '20261100000000'),
  -- Each table's rows as base64 of its JSON array (decoded by the restore helper), so XML escaping cannot alter it.
  'tables', (select jsonb_object_agg(t.table_name,
      (xpath('/table/row/j/text()', query_to_xml(format(
        'select translate(encode(convert_to(coalesce(jsonb_agg(to_jsonb(x)), ''[]'')::text, ''UTF8''), ''base64''), E''\n'', '''') as j from public.%I x',
        t.table_name), false, false, '')))[1]::text)
      from information_schema.tables t where t.table_schema = 'public' and t.table_name like 'workshop%' and t.table_type = 'BASE TABLE'),
  'functions', (select jsonb_object_agg(p.oid::regprocedure::text, pg_get_functiondef(p.oid))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'workshop%' and p.prokind = 'f'),
  'cron', (select jsonb_agg(jsonb_build_object('jobname', jobname, 'schedule', schedule, 'active', active, 'command', command)) from cron.job where jobname like 'workshop%')
) as snapshot;
rollback;
