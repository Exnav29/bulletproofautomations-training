-- Additive durable queue. Apply once backend tests pass; no credential records
-- or Storage objects are changed by this migration. Service-role RPCs only.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.certificate_jobs (
 id uuid primary key default gen_random_uuid(), credential_id text not null references public.credentials(credential_id),
 mode text not null check(mode in ('publish','restore','repair')), master_path text not null,
 expected_pdf_path text, expected_updated_at timestamptz not null,
 state text not null default 'queued' check(state in ('queued','running','completed','failed','attention')),
 stage text not null default 'Processing certificate', error text, result jsonb,
 run_token text not null default encode(extensions.gen_random_bytes(32),'hex'), lease uuid, lease_until timestamptz,
 attempts int not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table private.certificate_jobs enable row level security;
revoke all on private.certificate_jobs from public,anon,authenticated;
create unique index if not exists certificate_one_active on private.certificate_jobs(credential_id) where state in ('queued','running');

create or replace function public.certificate_job_status(p_id uuid default null,p_credential text default null)
returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'credential_id',j.credential_id,'state',j.state,
  'stage',j.stage,'error',j.error,'result',j.result,'attempts',j.attempts,'master_path',j.master_path,
  'mode',j.mode,'expected_pdf_path',j.expected_pdf_path,'expected_updated_at',j.expected_updated_at) order by j.created_at desc),'[]'::jsonb)
 from (select * from private.certificate_jobs where (p_id is null or id=p_id)
 and (p_credential is null or credential_id=p_credential) order by created_at desc limit 100) j;
$$;

create or replace function private.recover_certificate_jobs() returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(1584292026);
 update private.certificate_jobs set state=case when attempts>=3 then 'failed' else 'queued' end,
  stage=case when attempts>=3 then 'Failed' else 'Retrying interrupted conversion' end,
  error='Worker time limit or interruption. Private master retained; safe to retry.',lease=null,lease_until=null,updated_at=now()
 where state='running' and lease_until<now();
end; $$;

create or replace function private.dispatch_certificate_jobs() returns void
language sql security definer set search_path='' as $$
 select net.http_post(url:='https://ikkldbhgjleelviwttir.supabase.co/functions/v1/certificate-processor/run',
  headers:='{"Content-Type":"application/json"}'::jsonb,
  body:=jsonb_build_object('id',id,'token',run_token),timeout_milliseconds:=120000)
 from private.certificate_jobs where state='queued'
 and not exists(select 1 from private.certificate_jobs where state='running')
 order by created_at limit 1;
$$;

create or replace function public.certificate_job_start(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.credentials; j private.certificate_jobs; key text:=p_request->>'master_path';
 cid text:=p_request->>'credential_id'; mode text:=p_request->>'mode';
begin
 perform pg_advisory_xact_lock(1584292026);
 if cid is null or cid !~ '^BPA-(FND|BCAB)-[0-9]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$'
 or mode is null or mode not in ('publish','restore','repair') or key is null
 or key !~ '^BPA-(FND|BCAB)-[0-9]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}/[0-9]{8}T[0-9]{6}-[0-9a-f]{8}[.]pdf$'
 or split_part(key,'/',1)<>cid then raise exception 'Invalid archive request'; end if;
 select * into strict c from public.credentials where credential_id=cid for update;
 if c.pdf_path is distinct from (p_request->>'expected_pdf_path') or c.updated_at is distinct from (p_request->>'expected_updated_at')::timestamptz
 then raise exception 'Credential changed; reload the register'; end if;
 if mode='repair' and key is distinct from c.pdf_path then raise exception 'Repair must use current PDF'; end if;
 if not exists(select 1 from storage.objects where bucket_id='credential-masters' and name=key)
 then raise exception 'Private master not found'; end if;
 select * into j from private.certificate_jobs where credential_id=cid and state in ('queued','running');
 if found then
  if j.master_path<>key or j.mode<>mode then raise exception 'Another job is already active for this credential'; end if;
  return public.certificate_job_status(j.id,null)->0;
 end if;
 if (select count(*) from private.certificate_jobs where state in ('queued','running'))>=100
 then raise exception 'Queue full'; end if;
 insert into private.certificate_jobs(credential_id,mode,master_path,expected_pdf_path,expected_updated_at)
 values(cid,mode,key,c.pdf_path,c.updated_at) returning * into j;
 perform private.dispatch_certificate_jobs();
 return public.certificate_job_status(j.id,null)->0;
end; $$;

create or replace function public.certificate_job_claim(p_id uuid,p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.certificate_jobs;
begin
 perform pg_advisory_xact_lock(1584292026);
 select * into j from private.certificate_jobs where id=p_id for update;
 if not found or j.run_token<>p_token or j.state<>'queued' then return null; end if;
 if exists(select 1 from private.certificate_jobs where state='running') then return null; end if;
 update private.certificate_jobs set state='running',stage='Processing certificate',attempts=attempts+1,
  lease=gen_random_uuid(),lease_until=now()+interval '120 seconds',updated_at=now()
 where id=p_id returning * into j;
 return to_jsonb(j)-'run_token';
end; $$;

create or replace function public.certificate_job_stage(p_id uuid,p_lease uuid,p_stage text) returns void
language plpgsql security definer set search_path='' as $$
begin
 update private.certificate_jobs set stage=left(p_stage,80),updated_at=now()
 where id=p_id and lease=p_lease and state='running' and lease_until>now();
 if not found then raise exception 'Processing lease expired'; end if;
end; $$;

create or replace function public.certificate_job_complete(p_id uuid,p_lease uuid,p_result jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.certificate_jobs; c public.credentials; preview text; already boolean;
begin
 perform pg_advisory_xact_lock(1584292026);
 select * into strict j from private.certificate_jobs where id=p_id for update;
 if j.lease is distinct from p_lease or j.state<>'running' or j.lease_until<=now() then raise exception 'Processing lease expired'; end if;
 select * into strict c from public.credentials where credential_id=j.credential_id for update;
 if c.updated_at<>j.expected_updated_at or c.pdf_path is distinct from j.expected_pdf_path then
  update private.certificate_jobs set state='attention',stage='Requires attention',error='Credential changed during conversion; no paths updated.',updated_at=now() where id=p_id;
  return public.certificate_job_status(p_id,null)->0;
 end if;
 preview:=left(j.master_path,length(j.master_path)-4)||'.png';
 if p_result->>'pdf_path'<>j.master_path or p_result->>'preview_path'<>preview then raise exception 'Result paths do not match job'; end if;
 if not exists(select 1 from storage.objects where bucket_id='credentials' and name=j.master_path and metadata->>'mimetype'='application/pdf')
 or not exists(select 1 from storage.objects where bucket_id='credentials' and name=preview and metadata->>'mimetype'='image/png')
 or not exists(select 1 from storage.objects where bucket_id='credential-masters' and name=j.master_path)
 then raise exception 'Archive objects have not been verified'; end if;
 already:=c.pdf_path=j.master_path and c.preview_path=preview;
 if not coalesce(already,false) then
  if j.mode='repair' then
   update public.credentials set preview_path=preview where id=c.id;
  else
   update public.credentials set pdf_path=j.master_path,preview_path=preview where id=c.id;
  end if;
 end if;
 update private.certificate_jobs set state='completed',stage='Complete',error=null,
  result=p_result||jsonb_build_object('already_processed',coalesce(already,false),'record_updated_at',(select updated_at from public.credentials where id=c.id)),lease=null,lease_until=null,updated_at=now() where id=p_id;
 perform private.dispatch_certificate_jobs();
 return public.certificate_job_status(p_id,null)->0;
end; $$;

create or replace function public.certificate_job_fail(p_id uuid,p_lease uuid,p_error text) returns void
language plpgsql security definer set search_path='' as $$
begin
 update private.certificate_jobs set state='failed',stage='Failed',error=left(p_error,300),lease=null,lease_until=null,updated_at=now()
 where id=p_id and lease=p_lease and state='running';
end; $$;

create or replace function public.certificate_job_retry(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.certificate_jobs; c public.credentials;
begin
 perform pg_advisory_xact_lock(1584292026);
 select * into strict j from private.certificate_jobs where id=p_id for update;
 if j.state in ('queued','running') then return public.certificate_job_status(p_id,null)->0; end if;
 select * into strict c from public.credentials where credential_id=j.credential_id;
 if c.pdf_path is distinct from j.expected_pdf_path or c.updated_at<>j.expected_updated_at
 then raise exception 'Credential changed; start a new job from the register'; end if;
 if exists(select 1 from private.certificate_jobs where credential_id=j.credential_id and state in ('queued','running'))
 then raise exception 'Another job is active'; end if;
 update private.certificate_jobs set state='queued',stage='Processing certificate',error=null,attempts=0,updated_at=now() where id=p_id;
 perform private.dispatch_certificate_jobs();
 return public.certificate_job_status(p_id,null)->0;
end; $$;

revoke all on function private.dispatch_certificate_jobs(),private.recover_certificate_jobs() from public,anon,authenticated;
revoke all on function public.certificate_job_status(uuid,text),public.certificate_job_start(jsonb),
 public.certificate_job_claim(uuid,text),public.certificate_job_stage(uuid,uuid,text),
 public.certificate_job_complete(uuid,uuid,jsonb),public.certificate_job_fail(uuid,uuid,text),public.certificate_job_retry(uuid)
 from public,anon,authenticated;
grant execute on function public.certificate_job_status(uuid,text),public.certificate_job_start(jsonb),
 public.certificate_job_claim(uuid,text),public.certificate_job_stage(uuid,uuid,text),
 public.certificate_job_complete(uuid,uuid,jsonb),public.certificate_job_fail(uuid,uuid,text),public.certificate_job_retry(uuid) to service_role;
-- Schedule only after Edge deployment succeeds. Idempotent; one dispatcher.
-- select cron.schedule('certificate-processor-recovery','* * * * *','select private.recover_certificate_jobs(); select private.dispatch_certificate_jobs()');
-- Retire manual PNG INSERT and public-PDF browser INSERT only after rollout.
