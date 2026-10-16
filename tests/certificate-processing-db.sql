-- Live queue regression tests. Every write is rolled back. No credential is
-- issued, no PDF is changed, and pg_net sends nothing from a rolled-back tx.
begin;
do $test$
declare c public.credentials; j uuid; l uuid:=gen_random_uuid(); outcome jsonb;
 before_row jsonb; denied boolean:=false;
begin
 select * into strict c from public.credentials where credential_id='BPA-FND-2026-WHXRTT';
 before_row:=to_jsonb(c);
 assert not has_function_privilege('anon','public.certificate_job_start(jsonb)','EXECUTE');
 assert not has_function_privilege('authenticated','public.certificate_job_start(jsonb)','EXECUTE');
 assert has_function_privilege('service_role','public.certificate_job_start(jsonb)','EXECUTE');
 assert not has_schema_privilege('authenticated','private','USAGE');
 assert public.certificate_job_claim(gen_random_uuid(),repeat('0',64)) is null;
 -- A stale running job cannot change even one credential field.
 insert into private.certificate_jobs(credential_id,mode,master_path,expected_pdf_path,expected_updated_at,state,lease,lease_until)
 values(c.credential_id,'repair',c.pdf_path,c.pdf_path,c.updated_at-interval '1 second','running',l,now()+interval '1 minute') returning id into j;
 outcome:=public.certificate_job_complete(j,l,jsonb_build_object('pdf_path',c.pdf_path,'preview_path',c.preview_path));
 assert outcome->>'state'='attention';
 assert (select to_jsonb(x) from public.credentials x where id=c.id)=before_row;
 -- Same paths reprocessed are marked already processed, with no row mutation.
 update private.certificate_jobs set state='running',lease=l,lease_until=now()+interval '1 minute',expected_updated_at=c.updated_at where id=j;
 outcome:=public.certificate_job_complete(j,l,jsonb_build_object('pdf_path',c.pdf_path,'preview_path',c.preview_path));
 assert outcome->>'state'='completed';
 assert outcome->'result'->>'already_processed'='true';
 assert (select to_jsonb(x) from public.credentials x where id=c.id)=before_row;
 -- Duplicate live work is prohibited by the actual unique partial index.
 insert into private.certificate_jobs(credential_id,mode,master_path,expected_pdf_path,expected_updated_at,state)
 values(c.credential_id,'repair',c.pdf_path,c.pdf_path,c.updated_at,'queued');
 begin
  insert into private.certificate_jobs(credential_id,mode,master_path,expected_pdf_path,expected_updated_at,state)
  values(c.credential_id,'repair',c.pdf_path,c.pdf_path,c.updated_at,'queued');
 exception when unique_violation then denied:=true;
 end;
 assert denied;
end;
$test$;
rollback;
