-- Generating another print pack preserves previously recorded physical delivery.
create function public.studio_record_print_pack(p_actor uuid,p_ids uuid[],p_format text,p_sha text) returns void
language plpgsql security definer set search_path='' as $$
declare gid uuid;
begin
 if not exists(select 1 from auth.users where id=p_actor and lower(email)='johnathan@bulletproofautomations.com' and deleted_at is null) then raise exception 'Administrator required';end if;
 if coalesce(array_length(p_ids,1),0) not between 1 and 100 or p_format not in ('letter','a4') or p_sha !~ '^[0-9a-f]{64}$' then raise exception 'Invalid print pack';end if;
 perform pg_advisory_xact_lock(1610202601);
 foreach gid in array p_ids loop
  update private.studio_graduates set print_status=case when print_status='ready' then 'pack_generated' else print_status end where id=gid and state='issued';
  if not found then raise exception 'Only issued certificates can be printed';end if;
 end loop;
 insert into private.studio_audit(actor,action,payload) values(p_actor,'print_pack_generated',jsonb_build_object('ids',p_ids,'format',p_format,'sha256',p_sha));
end; $$;
revoke all on function public.studio_record_print_pack(uuid,uuid[],text,text) from public,anon,authenticated;
grant execute on function public.studio_record_print_pack(uuid,uuid[],text,text) to service_role;
