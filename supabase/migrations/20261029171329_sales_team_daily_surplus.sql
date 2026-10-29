-- Bounded service-only pending-event read for the existing daily task owner.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ begin
 perform 'public.sales_team_surplus_events_v1'::regclass;
 perform 'public.sales_team_surplus_event_results_v1'::regclass;
 perform 'public.begin_sales_team_surplus_event_v1(text,text,bigint,text,uuid,jsonb,uuid)'::regprocedure;
 perform 'public.complete_sales_team_surplus_event_v1(text,uuid,uuid,jsonb)'::regprocedure;
end $parents$;
create function public.read_sales_team_surplus_pending_events_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_request_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;begin
 perform creatornet_team_private.surplus_worker_v1(p_run_id,p_lease_token,p_context);
 if not exists(select 1 from public.sales_team_surplus_tasks_v1 task
  join public.sales_team_surplus_requests_v1 request on request.id=task.request_id
  where task.run_id=p_run_id and task.request_id=p_request_id and request.context=p_context)
 then raise exception 'ORIGINAL_DAILY_SURPLUS_TASK_REQUIRED';end if;
 select coalesce(jsonb_agg(to_jsonb(event) order by event.created_at,event.event_id),'[]'::jsonb) into result
 from (select event_id,event_type,event_created,payout_id,request_id,context,created_at
  from public.sales_team_surplus_events_v1 event where event.request_id=p_request_id and event.context=p_context
  and not exists(select 1 from public.sales_team_surplus_event_results_v1 result where result.event_id=event.event_id)
  order by event.created_at,event.event_id limit 3) event;
 return result;
end $$;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''public''::regnamespace and p.proname=''read_sales_team_surplus_pending_events_v1'')';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()','creatornet_team_private.surplus_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'DAILY_SURPLUS_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
revoke all on function public.read_sales_team_surplus_pending_events_v1(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.read_sales_team_surplus_pending_events_v1(uuid,uuid,jsonb,uuid) to service_role;
commit;
