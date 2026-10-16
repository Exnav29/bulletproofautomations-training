-- Editing cohort configuration never rewrites approved batch snapshots.
create function public.studio_update_cohort(p_actor uuid,p_id uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare before_data jsonb;obj jsonb:=p_data->'cohort';reason text:=btrim(coalesce(p_data->>'reason',''));
begin
 if not exists(select 1 from auth.users where id=p_actor and lower(email)='johnathan@bulletproofautomations.com' and deleted_at is null) then raise exception 'Administrator required';end if;
 if reason='' then raise exception 'Cohort changes require an audit reason';end if;
 if obj is null or not (obj ?& array['name','instructor','start_date','end_date']) or coalesce(length(obj->>'name'),0) not between 2 and 160 or coalesce(length(obj->>'instructor'),0) not between 2 and 150 or nullif(obj->>'start_date','') is null or nullif(obj->>'end_date','') is null or (obj->>'end_date')::date<(obj->>'start_date')::date then raise exception 'Invalid cohort';end if;
 perform pg_advisory_xact_lock(1610202601);
 select data into strict before_data from private.studio_cohorts where id=p_id for update;
 update private.studio_cohorts set data=obj where id=p_id;
 insert into private.studio_audit(actor,action,target,payload) values(p_actor,'cohort_updated',p_id::text,jsonb_build_object('before',before_data,'after',obj,'reason',reason));
 return jsonb_build_object('id',p_id);
end; $$;
revoke all on function public.studio_update_cohort(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.studio_update_cohort(uuid,uuid,jsonb) to service_role;
