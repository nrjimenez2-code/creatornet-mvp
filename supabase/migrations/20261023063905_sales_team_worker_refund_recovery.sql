-- Local candidate. Worker observation of admitted original refunds only.
-- Accepted requestor, POST bytes, operation ID/key and commercial terms remain.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column automatic_refund_recovery_enabled boolean not null default false;
alter table public.sales_team_refund_recovery_proofs_v1 alter column observed_by drop not null,
 add column worker_run_id uuid references public.sales_team_recovery_runs_v1(run_id) on delete restrict,
 add constraint sales_team_refund_proof_observer_v1 check(num_nonnulls(observed_by,worker_run_id)=1);
alter table public.sales_team_refund_request_results_v1 alter column observed_by drop not null,
 add column worker_run_id uuid references public.sales_team_recovery_runs_v1(run_id) on delete restrict,
 add constraint sales_team_refund_result_observer_v1 check(num_nonnulls(observed_by,worker_run_id)=1);
alter table public.sales_team_refund_request_observations_v1 add column worker_run_id uuid references public.sales_team_recovery_runs_v1(run_id) on delete restrict;
alter table public.sales_team_refund_request_observations_v1 drop constraint sales_team_refund_request_observations_v1_check,
 add constraint sales_team_refund_observation_origin_v1 check(num_nonnulls(observed_by,financial_check_id,worker_run_id)=1);
alter table public.sales_team_refund_reviews_v1 add column approval_request_id uuid references public.sales_team_refund_requests_v1(id) on delete restrict,
 add column recorded_by_worker_run_id uuid references public.sales_team_recovery_runs_v1(run_id) on delete restrict,
 add constraint sales_team_refund_review_origin_v1 check((approval_request_id is null)=(recorded_by_worker_run_id is null));
alter table public.sales_team_recovery_tasks_v1 drop constraint sales_team_recovery_tasks_v1_kind_check,
 add constraint sales_team_recovery_tasks_v1_kind_check check(kind in ('financial','event','shared_cash','recipient','fulfillment','refund'));
create table public.sales_team_refund_worker_actions_v1 (
 id bigint generated always as identity primary key,task_id uuid not null references public.sales_team_recovery_tasks_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_recovery_runs_v1(run_id) on delete restrict,
 request_id uuid not null references public.sales_team_refund_requests_v1(id) on delete restrict,
 phase text not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_refund_worker_checks_v1 (
 check_id uuid primary key references public.sales_team_financial_checks_v1(id) on delete restrict,
 task_id uuid not null references public.sales_team_recovery_tasks_v1(id) on delete restrict,
 request_id uuid not null references public.sales_team_refund_requests_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_recovery_runs_v1(run_id) on delete restrict
);
create function creatornet_team_private.refund_worker_authorized_v1(p_worker_run_id uuid,p_request_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_worker_runs_v1 w join public.sales_team_recovery_runs_v1 run on run.run_id=w.id
 join public.sales_team_refund_requests_v1 q on q.id=p_request_id and q.context=run.context
 join public.sales_team_financial_config_v1 f on f.singleton and f.context=run.context join public.sales_team_cash_policy_v1 policy on policy.singleton
 where w.id=p_worker_run_id and w.kind='reconciliation' and w.status='running' and w.lease_until>clock_timestamp() and
 exists(select 1 from public.sales_team_recovery_tasks_v1 task where task.run_id=w.id and task.kind='refund' and task.source_id=q.id::text and
  not exists(select 1 from public.sales_team_recovery_task_results_v1 done where done.task_id=task.id)) and
 run.contract_sha256=policy.recovery_contract_sha256 and run.contract_sha256=creatornet_team_private.recovery_contract_digest_v1())
$$;
-- Copy only four exact reviewed contracts. Their proof/economics/source checks
-- remain; authority and observer columns explicitly use the actual worker.
do $clones$ declare item record;src text;guard text;replacement text;begin
 guard:='if not exists(select 1 from public.profiles where id=p_actor_id and role=''admin'') then raise exception ''FINANCIAL_ADMIN_REQUIRED'';end if;';
 replacement:='if not creatornet_team_private.refund_worker_authorized_v1(p_worker_run_id,p_request_id) then raise exception ''CURRENT_REFUND_RECOVERY_WORKER_REQUIRED'';end if;';
 for item in select * from (values
  ('public.record_sales_team_refund_recovery_v1(uuid,uuid,jsonb)','record_sales_team_refund_recovery_v1','record_sales_team_refund_recovery_worker_v1','observer'),
  ('public.record_sales_team_refund_result_v1(uuid,uuid,jsonb)','record_sales_team_refund_result_v1','record_sales_team_refund_result_worker_v1','observer'),
  ('public.record_sales_team_refund_responsibility_v1(uuid,uuid)','record_sales_team_refund_responsibility_v1','record_sales_team_refund_responsibility_worker_v1','approval'),
  ('public.resolve_sales_team_refund_cash_v1(uuid,uuid,jsonb)','resolve_sales_team_refund_cash_v1','resolve_sales_team_refund_cash_worker_v1','cash')
 ) definitions(signature,original_name,new_name,kind) loop
  src:=replace(pg_get_functiondef(item.signature::regprocedure),chr(13)||chr(10),chr(10));
  if (length(src)-length(replace(src,guard,'')))/length(guard)<>1 or (length(src)-length(replace(src,'public.'||item.original_name||'(','')))/length('public.'||item.original_name||'(')<>1 then raise exception 'WORKER_REFUND_SOURCE_DEPENDENCY_DIFFERS';end if;
  src:=replace(replace(src,guard,replacement),'public.'||item.original_name||'(','public.'||item.new_name||'(');
  if item.kind='observer' then src:=replace(src,'observed_by','worker_run_id');
  elsif item.kind='approval' then
   if strpos(src,'reason_code,reviewed_by)')=0 or strpos(src,'q.reason_code,p_actor_id);')=0 then raise exception 'WORKER_REFUND_APPROVAL_DEPENDENCY_DIFFERS';end if;
   src:=replace(src,'reason_code,reviewed_by)','reason_code,reviewed_by,approval_request_id,recorded_by_worker_run_id)');
   src:=replace(src,'q.reason_code,p_actor_id);','q.reason_code,q.requested_by,q.id,p_worker_run_id);');
  end if;
  execute replace(src,'p_actor_id','p_worker_run_id');
 end loop;
end $clones$;
create function public.sales_team_worker_refund_held_v1(p_request_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select not exists(select 1 from public.sales_team_refund_requests_v1 q join public.sales_team_receipts_v1 r on r.id=q.receipt_id where q.id=p_request_id and
  not r.review_hold and not r.dispute_hold and public.sales_team_refund_request_resolved_v1(q.id) and not exists(
   select 1 from public.sales_team_cash_reservations_v1 reserved where reserved.request_id=q.id and not exists(select 1 from public.sales_team_cash_resolutions_v1 done where done.operation_id=reserved.operation_id)))
$$;
-- The complete independent worker-check transaction also serves a refund task.
-- The exact task/check/request link is required; no initiating actor is forged.
do $financial$ declare src text;needle text;begin
 src:=replace(pg_get_functiondef('public.complete_sales_team_recovery_financial_v1(uuid,uuid,jsonb,uuid,integer,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
 needle:='not exists(select 1 from public.sales_team_recovery_tasks_v1 where id=p_check_id and run_id=p_run_id and kind=''financial'')';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'WORKER_REFUND_FINANCIAL_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'not exists(select 1 from public.sales_team_refund_worker_checks_v1 link join public.sales_team_recovery_tasks_v1 task on task.id=link.task_id join public.sales_team_refund_requests_v1 q on q.id=link.request_id where link.check_id=p_check_id and link.worker_run_id=p_run_id and task.run_id=p_run_id and task.kind=''refund'' and task.source_id=q.id::text and q.receipt_id=checked.receipt_id and q.context=p_context and not exists(select 1 from public.sales_team_recovery_task_results_v1 done where done.task_id=task.id))');
 execute replace(src,'public.complete_sales_team_recovery_financial_v1(','public.complete_sales_team_refund_worker_financial_v1(');
end $financial$;
create function public.run_sales_team_worker_refund_recovery_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_phase text,p_payload jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare task public.sales_team_recovery_tasks_v1;q public.sales_team_refund_requests_v1;checked jsonb;result jsonb;begin
 perform creatornet_team_private.recovery_worker_v1(p_run_id,p_lease_token,p_context);
 select * into task from public.sales_team_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id and kind='refund';select * into q from public.sales_team_refund_requests_v1 where id::text=task.source_id and context=p_context;
 if q.id is null or exists(select 1 from public.sales_team_recovery_task_results_v1 where task_id=task.id) or not
  (exists(select 1 from public.sales_team_provider_operations_v1 where id=q.operation_id and (status<>'dispatching' or lease_until<=clock_timestamp())) or
   exists(select 1 from public.sales_team_refund_request_results_v1 where request_id=q.id and status='canceled_before_dispatch')) then raise exception 'ADMITTED_ORIGINAL_REFUND_RECOVERY_REQUIRED';end if;
 perform creatornet_team_private.financial_shape_v1(p_payload,case when p_phase in ('event','result') then '{"proof":"object"}'::jsonb when p_phase='begin_check' then '{"checkId":"string"}'::jsonb when p_phase='complete_check' then '{"checkId":"string","revision":"number","snapshot":"object"}'::jsonb else '{}'::jsonb end);
 if p_phase='read' then result:=public.sales_team_refund_request_json_v1(q.id);
 elsif p_phase='status' then result:=jsonb_build_object('held',public.sales_team_worker_refund_held_v1(q.id));
 elsif p_phase='event' then perform public.record_sales_team_refund_recovery_worker_v1(p_run_id,q.id,p_payload->'proof');
 elsif p_phase='result' then result:=public.record_sales_team_refund_result_worker_v1(p_run_id,q.id,p_payload->'proof');
 elsif p_phase='responsibility' then result:=public.record_sales_team_refund_responsibility_worker_v1(p_run_id,q.id);
 elsif p_phase='cash' then perform public.resolve_sales_team_refund_cash_worker_v1(p_run_id,q.id,p_context);
 elsif p_phase='begin_check' then
  result:=public.begin_sales_team_financial_check_v1((p_payload->>'checkId')::uuid,q.receipt_id,null,null,p_run_id,p_context);
  insert into public.sales_team_refund_worker_checks_v1(check_id,task_id,request_id,worker_run_id) values((result->>'checkId')::uuid,task.id,q.id,p_run_id) on conflict(check_id) do nothing;
  if not exists(select 1 from public.sales_team_refund_worker_checks_v1 where check_id=(result->>'checkId')::uuid and task_id=task.id and request_id=q.id and worker_run_id=p_run_id) then raise exception 'ORIGINAL_REFUND_TASK_CHECK_REQUIRED';end if;
 elsif p_phase='complete_check' then
  if not exists(select 1 from public.sales_team_refund_worker_checks_v1 where check_id=(p_payload->>'checkId')::uuid and task_id=task.id and request_id=q.id and worker_run_id=p_run_id) then raise exception 'ORIGINAL_REFUND_TASK_CHECK_REQUIRED';end if;
  result:=public.complete_sales_team_refund_worker_financial_v1(p_run_id,p_lease_token,p_context,(p_payload->>'checkId')::uuid,(p_payload->>'revision')::integer,p_payload->'snapshot');
 else raise exception 'ORIGINAL_REFUND_RECOVERY_PHASE_REQUIRED';end if;
 insert into public.sales_team_refund_worker_actions_v1(task_id,worker_run_id,request_id,phase) values(task.id,p_run_id,q.id,p_phase);return coalesce(result,'{}'::jsonb);
end $$;
-- Extend the reviewed finite queue only behind its own explicit latch. A still
-- live original provider dispatch, unstarted request or settled refund is absent.
do $queue$ declare src text;needle text;replacement text;begin
 src:=replace(pg_get_functiondef('public.next_sales_team_recovery_task_v1(uuid,uuid,jsonb,boolean)'::regprocedure),chr(13)||chr(10),chr(10));
 src:=replace(src,'p_fulfill boolean DEFAULT false)','p_fulfill boolean DEFAULT false, p_refunds boolean DEFAULT false)');
 if strpos(src,'p_refunds boolean')=0 then raise exception 'WORKER_REFUND_QUEUE_SIGNATURE_DIFFERS';end if;
 needle:='with candidates as (';
 replacement:=$replacement$with candidates as (
  select 'refund'::text kind,q.id::text id,q.created_at,jsonb_build_object('requestId',q.id) source from public.sales_team_refund_requests_v1 q left join public.sales_team_provider_operations_v1 operation on operation.id=q.operation_id
  where p_refunds and q.context=p_context and q.created_at<clock_timestamp()-interval '2 minutes' and exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_refund_recovery_enabled) and public.sales_team_worker_refund_held_v1(q.id) and
   (operation.id is not null and (operation.status<>'dispatching' or operation.lease_until<=clock_timestamp()) or exists(select 1 from public.sales_team_refund_request_results_v1 where request_id=q.id and status='canceled_before_dispatch'))
  union all $replacement$;
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'WORKER_REFUND_QUEUE_SOURCE_DIFFERS';end if;
 -- PostgreSQL cannot replace a function by adding an argument: create the new
 -- exact signature then retire only the old finite-queue signature.
 execute replace(src,needle,replacement);drop function public.next_sales_team_recovery_task_v1(uuid,uuid,jsonb,boolean);
 src:=replace(pg_get_functiondef('public.finish_sales_team_recovery_task_v1(uuid,uuid,jsonb,uuid,boolean)'::regprocedure),chr(13)||chr(10),chr(10));needle:='when ''fulfillment'' then';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'WORKER_REFUND_TASK_PROOF_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'when ''refund'' then not public.sales_team_worker_refund_held_v1(task.source_id::uuid) '||needle);
 src:=pg_get_functiondef('creatornet_team_private.recovery_contract_digest_v1()'::regprocedure);
 needle:='''fulfill_sales_team_receipt_v1''';if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'WORKER_REFUND_DIGEST_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,needle||',''run_sales_team_worker_refund_recovery_v1'',''sales_team_worker_refund_held_v1'',''record_sales_team_refund_recovery_worker_v1'',''record_sales_team_refund_result_worker_v1'',''record_sales_team_refund_responsibility_worker_v1'',''resolve_sales_team_refund_cash_worker_v1'',''complete_sales_team_refund_worker_financial_v1''');
 -- Named private helper inclusion only; no privilege or prefix scan changes.
 needle:='''shared_cash_trace_v1''';src:=replace(src,needle,needle||',''refund_worker_authorized_v1''');execute src;
end $queue$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_refund_worker_actions_v1','sales_team_refund_worker_checks_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated',name);execute format('grant select,insert on public.%I to service_role',name);
  execute format('create trigger immutable_refund_worker_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('run_sales_team_worker_refund_recovery_v1','sales_team_worker_refund_held_v1','record_sales_team_refund_recovery_worker_v1','record_sales_team_refund_result_worker_v1','record_sales_team_refund_responsibility_worker_v1','resolve_sales_team_refund_cash_worker_v1','complete_sales_team_refund_worker_financial_v1','next_sales_team_recovery_task_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname='refund_worker_authorized_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
grant usage,select on sequence public.sales_team_refund_worker_actions_v1_id_seq to service_role;
commit;
