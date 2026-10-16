-- Additive Studio data. All new records remain in private schema; server-only API.
create schema if not exists private;
create table private.studio_courses(id uuid primary key default gen_random_uuid(),data jsonb not null,revision int not null default 1,created_at timestamptz not null default now());
create unique index studio_course_code on private.studio_courses(lower(data->>'code'));
create table private.studio_cohorts(id uuid primary key default gen_random_uuid(),course_id uuid not null references private.studio_courses,data jsonb not null,created_at timestamptz not null default now());
create table private.studio_batches(id uuid primary key default gen_random_uuid(),cohort_id uuid not null references private.studio_cohorts,snapshot jsonb not null,state text not null default 'draft' check(state in ('draft','approved','issued')),revision int not null default 1,approved_by uuid,approved_at timestamptz,created_at timestamptz not null default now());
create table private.studio_graduates(id uuid primary key default gen_random_uuid(),batch_id uuid not null references private.studio_batches,data jsonb not null,eligible boolean not null default false,proof_revision int,reviewed_revision int,credential_id text,master_path text,job_id uuid,state text not null default 'draft' check(state in ('draft','approved','processing','issued')),print_status text not null default 'ready' check(print_status in ('ready','pack_generated','printed','handed_out','not_collected')),handed_at timestamptz,handed_by uuid,correction boolean not null default false);
create unique index studio_batch_graduate on private.studio_graduates(batch_id,lower(coalesce(nullif(data->>'email',''),data->>'full_name')));
create table private.studio_deliveries(id uuid primary key default gen_random_uuid(),graduate_id uuid not null references private.studio_graduates,master_path text not null,message jsonb not null,state text not null default 'prepared' check(state in ('prepared','sending','sent','failed','uncertain','excluded')),approved_by uuid,approved_at timestamptz,provider_id text,error text,created_at timestamptz not null default now());
create unique index studio_delivery_inflight on private.studio_deliveries(graduate_id) where state in ('prepared','sending','uncertain');
create table private.studio_audit(id bigint generated always as identity primary key,actor uuid,action text not null,target text,payload jsonb not null default '{}',created_at timestamptz not null default now());
create table private.studio_templates(id text primary key,version int not null,manifest jsonb not null,registered_at timestamptz not null default now());
insert into private.studio_templates values('001',1,'{"template_sha256":"16a2c4cc0e70bd87a869cffbbfe7c17de8479e2ef8c43dcd3ced5200f42f8eac","signature_sha256":"f4c41e33e2c40bd02d0eb7610616d962d710cdf333b492dccedbbf3f118a4677","source":"Exact embedded artwork, identical across all nine approved Foundations PDFs","asset_prefix":"studio/001/v1/"}',now());
insert into private.studio_audit(action,target,payload) values('template_registered','001/v1','{"method":"Exact approved PDF extraction","signature_sha256":"f4c41e33e2c40bd02d0eb7610616d962d710cdf333b492dccedbbf3f118a4677"}');
do $$ declare t text; begin foreach t in array array['studio_courses','studio_cohorts','studio_batches','studio_graduates','studio_deliveries','studio_audit','studio_templates'] loop execute format('alter table private.%I enable row level security',t);execute format('revoke all on private.%I from public,anon,authenticated',t);end loop;end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('certificate-studio','certificate-studio',false,15728640,array['application/pdf','image/png','application/octet-stream','font/ttf']) on conflict(id) do nothing;
alter table public.credentials add column course_title text,add column completion_statement text,add column issuance_state text not null default 'issued' check(issuance_state in ('pending','issued'));
alter table public.credentials drop constraint credentials_credential_check;
alter table public.credentials add constraint credentials_credential_check check(credential in ('foundations','bcab','completion'));

-- Single serialized server API. The backend passes a verified Auth user ID;
-- SQL independently checks the immutable auth.users email before every action.
create function public.studio_action(p_actor uuid,p_action text,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare cid uuid; bid uuid; gid uuid; c private.studio_courses; h private.studio_cohorts; b private.studio_batches; g private.studio_graduates; d private.studio_deliveries; obj jsonb; result jsonb; key text; n int; credential text; reason text:=btrim(coalesce(p_data->>'reason',''));
begin
 if not exists(select 1 from auth.users where id=p_actor and lower(email)='johnathan@bulletproofautomations.com' and deleted_at is null) then raise exception 'Administrator required';end if;
 perform pg_advisory_xact_lock(1610202601);
 if p_action='list' then
  return jsonb_build_object('courses',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]') from private.studio_courses x),
  'cohorts',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]') from private.studio_cohorts x),
  'batches',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]') from private.studio_batches x),
  'graduates',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from private.studio_graduates x),
  'deliveries',(select coalesce(jsonb_agg(to_jsonb(x) order by created_at desc),'[]') from private.studio_deliveries x),
  'templates',(select jsonb_agg(to_jsonb(x)) from private.studio_templates x),
  'enrollments',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'full_name',full_name,'email',email,'cohort',cohort)),'[]') from public.enrollments),
  'audit',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select * from private.studio_audit order by id desc limit 200) x));
 elsif p_action='course' then
  obj:=p_data->'course'; if obj is null or not (obj ?& array['name','code','level','statement','certificate_title','status','template']) or length(btrim(obj->>'name')) not between 2 and 180 or length(btrim(obj->>'code')) not between 2 and 30 or length(obj->>'level') not between 1 and 60 or length(obj->>'statement') not between 1 and 500 or length(obj->>'certificate_title') not between 1 and 100 or obj->>'status' not in ('active','archived') or obj->>'template'<>'001' then raise exception 'Invalid course configuration';end if;
  if obj::text ~* '("code"\s*:\s*"(BCAB|BCAE)"|"certificate_title"\s*:\s*"[^"]*(Certified|Professional Certification))' then raise exception 'Professional certifications cannot be awarded through course completion';end if;
  if p_data->>'id' is null then insert into private.studio_courses(data) values(obj) returning id into cid;
  else update private.studio_courses set data=obj,revision=revision+1 where id=(p_data->>'id')::uuid returning id into cid;if cid is null then raise exception 'Course not found';end if;end if; result:=jsonb_build_object('id',cid);
 elsif p_action='cohort' then
  select * into strict c from private.studio_courses where id=(p_data->>'course_id')::uuid;
  obj:=p_data->'cohort';if obj is null or not (obj ?& array['name','instructor','start_date','end_date']) or c.data->>'status'<>'active' or length(obj->>'name') not between 2 and 160 or length(obj->>'instructor') not between 2 and 150 or (obj->>'end_date')::date<(obj->>'start_date')::date then raise exception 'Invalid cohort';end if;
  insert into private.studio_cohorts(course_id,data) values(c.id,obj) returning id into cid;result:=jsonb_build_object('id',cid);
 elsif p_action='batch' then
  select * into strict h from private.studio_cohorts where id=(p_data->>'cohort_id')::uuid;select * into strict c from private.studio_courses where id=h.course_id;
  if c.data->>'status'<>'active' then raise exception 'Course archived';end if;
  obj:=jsonb_build_object('course_name',c.data->>'name','course_code',c.data->>'code','level',c.data->>'level','certificate_title',c.data->>'certificate_title','statement',c.data->>'statement','requirements',c.data->>'requirements','template','001','template_version',1,'start_date',h.data->>'start_date','end_date',h.data->>'end_date','instructor',h.data->>'instructor','cohort_name',h.data->>'name','email_subject',c.data->>'email_subject','email_body',c.data->>'email_body','issue_date',coalesce(nullif(p_data->>'issue_date',''),h.data->>'end_date'));
  if (obj->>'issue_date')::date<>(h.data->>'end_date')::date and reason='' then raise exception 'Issue date adjustment requires audit reason';end if;
  insert into private.studio_batches(cohort_id,snapshot) values(h.id,obj) returning id into bid;result:=jsonb_build_object('id',bid);
 elsif p_action in ('remove_graduate','graduates','graduate','eligibility','review','approve','issue_context') then
  bid:=(p_data->>'batch_id')::uuid;select * into strict b from private.studio_batches where id=bid for update;
  if p_action in ('remove_graduate','graduates','graduate','eligibility','review') and b.state<>'draft' then raise exception 'Approved roster is immutable; use correction';end if;
  if p_action='remove_graduate' then
   delete from private.studio_graduates where id=(p_data->>'id')::uuid and batch_id=bid and state='draft';if not found then raise exception 'Draft graduate missing';end if;
   update private.studio_batches set revision=revision+1 where id=bid;
  elsif p_action='graduates' then
   if jsonb_array_length(p_data->'graduates') not between 1 and 100 or (select count(*) from private.studio_graduates where batch_id=bid)+jsonb_array_length(p_data->'graduates')>100 then raise exception 'Batch limited to 100';end if;
   for obj in select value from jsonb_array_elements(p_data->'graduates') loop
    if length(obj->>'full_name') not between 2 and 150 then raise exception 'Invalid name';end if;
    if coalesce(obj->>'email','')<>'' and obj->>'email' !~ '^[^[:space:]@,;<>]+@[^[:space:]@,;<>]+[.][^[:space:]@,;<>]+$' then raise exception 'Invalid email';end if;
    if exists(select 1 from private.studio_graduates x join private.studio_batches y on y.id=x.batch_id where y.cohort_id=b.cohort_id and (lower(x.data->>'full_name')=lower(obj->>'full_name') or (obj->>'email'<>'' and lower(x.data->>'email')=lower(obj->>'email')))) then raise exception 'Graduate already exists for this cohort';end if;
    insert into private.studio_graduates(batch_id,data) values(bid,obj);
   end loop;
   update private.studio_batches set revision=revision+1 where id=bid;
  elsif p_action='graduate' then
   update private.studio_graduates set data=p_data->'graduate',eligible=false,reviewed_revision=null where id=(p_data->>'id')::uuid and batch_id=bid; if not found then raise exception 'Graduate missing';end if;
   update private.studio_batches set revision=revision+1 where id=bid;
  elsif p_action='eligibility' then
   update private.studio_graduates set eligible=(p_data->>'eligible')::boolean,reviewed_revision=null where id=(p_data->>'id')::uuid and batch_id=bid;if not found then raise exception 'Graduate missing';end if;
   update private.studio_batches set revision=revision+1 where id=bid;
  elsif p_action='review' then
   if (p_data->>'revision')::int<>b.revision then raise exception 'Roster changed; regenerate proofs';end if;
   update private.studio_graduates set reviewed_revision=b.revision where id=(p_data->>'id')::uuid and batch_id=bid and eligible and proof_revision=b.revision;if not found then raise exception 'Eligibility approval required';end if;
  elsif p_action='approve' then
   if b.state<>'draft' then return to_jsonb(b);end if;
   if not exists(select 1 from private.studio_graduates where batch_id=bid) or exists(select 1 from private.studio_graduates where batch_id=bid and (not eligible or reviewed_revision is distinct from b.revision)) then raise exception 'Approve eligibility and review every current proof before issuance';end if;
   for g in select * from private.studio_graduates where batch_id=bid for update loop
    if not g.correction then
     loop
      credential:='BPA-TRN-'||extract(year from (b.snapshot->>'issue_date')::date)::text||'-';
      for n in 1..6 loop credential:=credential||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+get_byte(extensions.gen_random_bytes(1),0)%32,1);end loop;
      begin
       insert into public.credentials(credential_id,holder_name,holder_email,credential,issued_on,cohort,publish_consent,allow_name_lookup,enrollment_id,issuance_state,course_title,completion_statement)
       values(credential,g.data->>'full_name',g.data->>'email','completion',(b.snapshot->>'issue_date')::date,b.snapshot->>'cohort_name',false,false,nullif(g.data->>'enrollment_id','')::uuid,'pending',b.snapshot->>'course_name',b.snapshot->>'statement');exit;
      exception when unique_violation then null;end;
     end loop;
    else credential:=g.credential_id;end if;
    key:=credential||'/'||to_char(clock_timestamp() at time zone 'UTC','YYYYMMDD"T"HH24MISS')||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,8)||'.pdf';
    update private.studio_graduates set credential_id=credential,master_path=key,state='approved' where id=g.id;
   end loop;
   update private.studio_batches set state='approved',approved_by=p_actor,approved_at=now() where id=bid;
  elsif p_action='issue_context' then
   if b.state not in ('approved','issued') then raise exception 'Final issuance approval required';end if;
   select * into strict g from private.studio_graduates where id=(p_data->>'id')::uuid and batch_id=bid;
   return jsonb_build_object('graduate',to_jsonb(g),'batch',to_jsonb(b),'credential',(select to_jsonb(x) from public.credentials x where credential_id=g.credential_id));
  end if;result:=jsonb_build_object('id',bid);
 elsif p_action='proof_generated' then
  update private.studio_graduates set proof_revision=(p_data->>'revision')::int where id=(p_data->>'id')::uuid;result:='{}';
 elsif p_action='proof_context' then
  select * into strict g from private.studio_graduates where id=(p_data->>'id')::uuid;select * into strict b from private.studio_batches where id=g.batch_id;
  return jsonb_build_object('graduate',to_jsonb(g),'batch',to_jsonb(b));
 elsif p_action='job' then
  update private.studio_graduates set job_id=(p_data->>'job_id')::uuid,state=case when state='issued' then 'issued' else 'processing' end where id=(p_data->>'id')::uuid;result:='{}';
 elsif p_action='print' then
  if p_data->>'status' not in ('pack_generated','printed','handed_out','not_collected','ready') then raise exception 'Invalid physical delivery state';end if;
  for obj in select value from jsonb_array_elements(p_data->'ids') loop
   update private.studio_graduates set print_status=p_data->>'status',handed_at=case when p_data->>'status'='handed_out' then now() else handed_at end,handed_by=case when p_data->>'status'='handed_out' then p_actor else handed_by end where id=(obj#>>'{}')::uuid and state='issued';if not found then raise exception 'Only issued certificates can be printed or handed out';end if;
  end loop;result:='{}';
 elsif p_action='correct' then
  if reason='' then raise exception 'Correction requires audit reason';end if;
  select * into strict g from private.studio_graduates where id=(p_data->>'id')::uuid and state='issued';select * into strict b from private.studio_batches where id=g.batch_id;
  if exists(select 1 from private.studio_graduates where credential_id=g.credential_id and correction and state<>'issued') then raise exception 'An unfinished correction already exists';end if;
  insert into private.studio_batches(cohort_id,snapshot) values(b.cohort_id,b.snapshot) returning id into bid;
  insert into private.studio_graduates(batch_id,data,credential_id,correction) values(bid,p_data->'graduate',g.credential_id,true);result:=jsonb_build_object('id',bid);
 elsif p_action='revoke' then
  if reason='' then raise exception 'Revocation requires audit reason';end if;
  update public.credentials set status='revoked',revoked_reason=reason,revoked_on=current_date where credential_id=p_data->>'credential_id';if not found then raise exception 'Credential missing';end if;result:='{}';
 elsif p_action='prepare_email' then
  select * into strict g from private.studio_graduates where id=(p_data->>'id')::uuid and state='issued';
  if exists(select 1 from private.studio_deliveries where graduate_id=g.id and state in ('sent','sending','uncertain')) and coalesce(p_data->>'resend','')<>'true' then raise exception 'Explicit resend authorization required';end if;
  if exists(select 1 from private.studio_deliveries where graduate_id=g.id and state in ('sending','uncertain')) then raise exception 'Reconcile uncertain send with provider before preparing again';end if;
  if p_data->>'resend'='true' and reason='' then raise exception 'Resend reason required';end if;
  if p_data->'message'->>'to' is distinct from (select holder_email from public.credentials where credential_id=g.credential_id) or p_data->'message'->>'attachment_name'<>g.credential_id||'.pdf' then raise exception 'Recipient or attachment mismatch';end if;
  update private.studio_deliveries set state='excluded' where graduate_id=g.id and state='prepared';
  insert into private.studio_deliveries(graduate_id,master_path,message) values(g.id,(select pdf_path from public.credentials where credential_id=g.credential_id),p_data->'message') returning id into cid;result:=jsonb_build_object('id',cid);
 elsif p_action='exclude_email' then
  update private.studio_deliveries set state='excluded' where id=(p_data->>'id')::uuid and state='prepared';result:='{}';
 elsif p_action='claim_email' then
  select * into strict d from private.studio_deliveries where id=(p_data->>'id')::uuid for update;
  select * into strict g from private.studio_graduates where id=d.graduate_id;
  if d.state<>'prepared' then raise exception 'Delivery not prepared; sent and uncertain messages are never automatically retried';end if;
  if not exists(select 1 from public.credentials where credential_id=g.credential_id and status='valid' and pdf_path=d.master_path and issuance_state='issued') then raise exception 'Certificate changed or revoked; prepare a fresh delivery';end if;
  update private.studio_deliveries set state='sending',approved_by=p_actor,approved_at=now() where id=d.id;result:=to_jsonb(d)||jsonb_build_object('state','sending');
 elsif p_action='email_result' then
  if p_data->>'state' not in ('sent','failed','uncertain') then raise exception 'Invalid send result';end if;
  update private.studio_deliveries set state=p_data->>'state',provider_id=p_data->>'provider_id',error=p_data->>'error' where id=(p_data->>'id')::uuid and state='sending';if not found then raise exception 'Send was not claimed';end if;result:='{}';
 elsif p_action='reconcile_email' then
  if reason='' or p_data->>'state' not in ('sent','failed') then raise exception 'Provider evidence and definitive outcome required';end if;
  update private.studio_deliveries set state=p_data->>'state',provider_id=p_data->>'provider_id',error=reason where id=(p_data->>'id')::uuid and state in ('sending','uncertain');if not found then raise exception 'No uncertain send found';end if;result:='{}';
 else raise exception 'Unknown Studio action';end if;
 insert into private.studio_audit(actor,action,target,payload) values(p_actor,p_action,coalesce(cid::text,bid::text,p_data->>'id',p_data->>'credential_id'),p_data);
 return result;
end; $$;
revoke all on function public.studio_action(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.studio_action(uuid,text,jsonb) to service_role;

-- Final registration occurs in the SAME transaction as archive job completion.
create function private.studio_archive_complete() returns trigger language plpgsql security definer set search_path='' as $$
declare g private.studio_graduates;b private.studio_batches;
begin
 if new.state='completed' and old.state is distinct from 'completed' then
  select * into g from private.studio_graduates where credential_id=new.credential_id and master_path=new.master_path and state in ('approved','processing') for update;
  if found then
   select * into strict b from private.studio_batches where id=g.batch_id;
   if b.approved_by is null then raise exception 'Issuance approval missing';end if;
   update public.credentials set issuance_state='issued',holder_name=g.data->>'full_name',holder_email=g.data->>'email',course_title=b.snapshot->>'course_name',completion_statement=b.snapshot->>'statement',publish_consent=coalesce((g.data->>'publish_consent')::boolean,false),allow_name_lookup=coalesce((g.data->>'allow_name_lookup')::boolean,false) where credential_id=g.credential_id;
   update private.studio_graduates set state='issued',job_id=new.id where id=g.id;
   if not exists(select 1 from private.studio_graduates where batch_id=b.id and state<>'issued') then update private.studio_batches set state='issued' where id=b.id;end if;
   insert into private.studio_audit(actor,action,target,payload) values(b.approved_by,'archive_registered',g.credential_id,jsonb_build_object('job_id',new.id,'master_path',new.master_path,'correction',g.correction));
  end if;
 end if;return new;
end; $$;
revoke all on function private.studio_archive_complete() from public,anon,authenticated;
create trigger studio_archive_registered after update on private.certificate_jobs for each row execute function private.studio_archive_complete();

create or replace function public.certificate_job_start(p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.credentials; j private.certificate_jobs; key text:=p_request->>'master_path';
 cid text:=p_request->>'credential_id'; mode text:=p_request->>'mode';
begin
 perform pg_advisory_xact_lock(1584292026);
 if cid is null or cid !~ '^BPA-(FND|BCAB|TRN)-[0-9]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$'
 or mode is null or mode not in ('publish','restore','repair') or key is null
 or key !~ '^BPA-(FND|BCAB|TRN)-[0-9]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}/[0-9]{8}T[0-9]{6}-[0-9a-f]{8}[.]pdf$'
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


do $m$ declare n text;definition text;begin
 foreach n in array array['verify_credential','verify_credentials_for'] loop
  select pg_get_functiondef(oid) into strict definition from pg_proc where pronamespace='public'::regnamespace and proname=n;
  definition:=replace(definition,'where c.publish_consent', 'where c.issuance_state = ''issued'' and c.publish_consent');
  execute definition;
 end loop;
end $m$;
create function public.studio_public_details(p_ids text[]) returns table(credential_id text,course_title text,completion_statement text)
language sql stable security definer set search_path='' as $$
 select credential_id,course_title,completion_statement from public.credentials where credential_id=any(p_ids) and publish_consent and issuance_state='issued' limit 100;
$$;
revoke all on function public.studio_public_details(text[]) from public,anon,authenticated;
grant execute on function public.studio_public_details(text[]) to service_role;
-- Latest completed Studio rendition is the sole source for later print/email.
create function public.studio_current_document(p_credential text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('pdf_path',c.pdf_path,'status',c.status,'snapshot',b.snapshot,'graduate_data',g.data)
 from public.credentials c join private.studio_graduates g on g.credential_id=c.credential_id and g.master_path=c.pdf_path
 join private.studio_batches b on b.id=g.batch_id where c.credential_id=p_credential and c.issuance_state='issued' and g.state='issued' limit 1;
$$;
revoke all on function public.studio_current_document(text) from public,anon,authenticated;
grant execute on function public.studio_current_document(text) to service_role;
-- Preserve the exact existing admin/master-only upload policy; add TRN IDs.
do $m$ declare expression text;begin
 select with_check into expression from pg_policies where schemaname='storage' and tablename='objects' and policyname='Training admin can insert versioned certificate PDFs';
 if expression is not null then execute 'alter policy "Training admin can insert versioned certificate PDFs" on storage.objects with check ('||replace(expression,'(FND|BCAB)','(FND|BCAB|TRN)')||')';end if;
end $m$;

-- Link the nine approved historical certificates for retrieval/delivery without
-- updating any existing credential, PDF, consent, verification URL or preview.
do $seed$ declare c uuid;h uuid;b uuid;snapshot jsonb;begin
 insert into private.studio_courses(data) values($data${"name": "n8n Foundations", "code": "FOUNDATIONS", "level": "Beginner", "description": "Hands-on workflow automation foundations.", "certificate_title": "Certificate of Completion", "requirements": "Successful completion of the eight-week hands-on program.", "statement": "for successfully completing the eight-week hands-on program", "template": "001", "status": "active", "email_subject": "Congratulations! Your Bulletproof Automations Certificate of Completion", "email_body": "Dear {{first_name}},\n\nCongratulations on successfully completing the {{course}}!\n\nOver eight weeks, you dedicated your time and effort to learning the fundamentals of workflow automation. From understanding triggers and working with data to connecting applications, troubleshooting errors, and building practical automations, you have taken an important step toward becoming a capable automation builder.\n\nIt was a pleasure having you as part of our inaugural Beginner Cohort. I appreciate your participation, dedication, and willingness to learn.\n\nYour Certificate of Completion is attached to this email.\n\nYour certificate recognizes your successful completion of the {{course}} training program conducted by Bulletproof Automations from {{start_date}} through {{end_date}}.\n\nYOUR CERTIFICATE DETAILS\n\nCredential: {{course}}\nIssued by: Bulletproof Automations\nDate Issued: {{issue_date}}\nCertificate ID: {{credential_id}}\nVerification Link: {{url}}\n\nVERIFY AND SHARE YOUR ACHIEVEMENT\n\nYour certificate has been registered in the Bulletproof Automations credential verification system.\n\nYou may share your unique verification link with prospective employers, recruiters, clients, or anyone who wishes to confirm your achievement. They can use the link to verify your certificate directly.\n\nI also encourage you to add this achievement to your LinkedIn profile under Licenses & Certifications, using Bulletproof Automations as the issuing organization. Include your Certificate ID and verification link so others can independently verify your credential.\n\nRemember the five principles we emphasized throughout our training:\n\nBuild \u2192 Demonstrate \u2192 Troubleshoot \u2192 Document \u2192 Prove\n\nAlthough our Beginner Cohort has concluded, your journey as an automation builder is just beginning. Continue learning, experimenting, and applying your skills to solve real-world problems.\n\nOnce again, congratulations, and thank you for being part of our inaugural cohort!\n\nWarm regards,\n\nJohnathan Lightfoot\nFounder & Instructor | Bulletproof Automations\nn8n Ghana Ambassador\njohnathan@bulletproofautomations.com\nhttps://bulletproofautomations.com\n"}$data$::jsonb) returning id into c;
 insert into private.studio_cohorts(course_id,data) values(c,'{"name":"Foundations Beginner Cohort 1 — July 11–August 29, 2026","start_date":"2026-07-11","end_date":"2026-08-29","instructor":"Johnathan Lightfoot"}') returning id into h;
 snapshot:=jsonb_build_object('course_name','n8n Foundations','course_code','FOUNDATIONS','level','Beginner','certificate_title','Certificate of Completion','statement','for successfully completing the eight-week hands-on program','template','001','template_version',1,'start_date','2026-07-11','end_date','2026-08-29','issue_date','2026-08-29','cohort_name','Foundations Beginner Cohort 1 — July 11–August 29, 2026','instructor','Johnathan Lightfoot') || (select jsonb_build_object('email_subject',data->>'email_subject','email_body',data->>'email_body') from private.studio_courses where id=c);
 insert into private.studio_batches(cohort_id,snapshot,state) values(h,snapshot,'issued') returning id into b;
 insert into private.studio_graduates(batch_id,data,eligible,credential_id,master_path,state)
 select b,jsonb_build_object('full_name',holder_name,'email',holder_email,'publish_consent',publish_consent,'allow_name_lookup',allow_name_lookup,'enrollment_id',enrollment_id),true,credential_id,pdf_path,'issued' from public.credentials where credential_id=any(array['BPA-FND-2026-3BB8FN','BPA-FND-2026-ASBGN1','BPA-FND-2026-C3V8PF','BPA-FND-2026-D7S1ZC','BPA-FND-2026-DYYXK5','BPA-FND-2026-H558H4','BPA-FND-2026-K3J054','BPA-FND-2026-TKM9XC','BPA-FND-2026-WHXRTT']) and pdf_path is not null;
 insert into private.studio_audit(action,target,payload) values('historical_archive_linked',b::text,'{"source":"Nine original approved Foundations certificates; prior issuance is historical; no new approval or delivery inferred"}');
end $seed$;
