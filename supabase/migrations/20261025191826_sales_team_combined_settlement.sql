-- Default-off combined automatic settlement. Reuse original financial ports;
-- preserve one 15-minute slot, 90-second worker and three combined tasks.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column automatic_transfer_recovery_enabled boolean not null default false;
alter table public.sales_team_settlement_plans_v1 drop constraint sales_team_settlement_plans_v1_kind_check;
alter table public.sales_team_settlement_plans_v1 add constraint sales_team_settlement_plans_v1_kind_check check(kind in ('original','earned','recovery'));
create table public.sales_team_combined_settlement_runs_v1 (
 run_id uuid primary key references public.sales_team_automatic_settlement_runs_v1(run_id) on delete restrict,
 transfer_new boolean not null,recovery_new boolean not null,recovery_dispatch boolean not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_settlement_recovery_plans_v1 (
 plan_id uuid primary key references public.sales_team_settlement_plans_v1(id) on delete restrict,
 transfer_request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 operation_id uuid references public.sales_team_provider_operations_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create function creatornet_team_private.combined_settlement_worker_v1(p_run_id uuid,p_token uuid,p_context jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_token,p_context);
 if not exists(select 1 from public.sales_team_combined_settlement_runs_v1 combined
  join public.sales_team_automatic_settlement_runs_v1 automatic on automatic.run_id=combined.run_id and automatic.allow_new=combined.transfer_new
  join public.sales_team_transfer_recovery_runs_v1 recovery on recovery.run_id=combined.run_id and recovery.allow_new=combined.recovery_new
  join public.sales_team_transfer_recovery_execution_runs_v1 execution on execution.run_id=combined.run_id and execution.allow_new=combined.recovery_dispatch
  join public.sales_team_controls_v1 controls on controls.singleton and controls.automatic_settlement_enabled and controls.automatic_transfer_recovery_enabled
  where combined.run_id=p_run_id) then raise exception 'CURRENT_COMBINED_SETTLEMENT_WORKER_REQUIRED';end if;
end $$;
create function creatornet_team_private.combined_settlement_task_count_v1(p_run_id uuid)
returns bigint language sql stable security invoker set search_path=pg_catalog as $$
 select count(*) from (
  select task_id id from public.sales_team_settlement_plans_v1 where run_id=p_run_id
  union select id from public.sales_team_settlement_tasks_v1 where run_id=p_run_id
  union select id from public.sales_team_transfer_recovery_tasks_v1 where run_id=p_run_id
  union select task_id from public.sales_team_transfer_reversal_checks_v1 where worker_run_id=p_run_id
 ) tasks
$$;
create function creatornet_team_private.combined_transfer_plan_allowed_v1(p_run_id uuid,p_request_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_combined_settlement_runs_v1 combined
 join public.sales_team_automatic_settlement_runs_v1 automatic on automatic.run_id=combined.run_id and automatic.allow_new and combined.transfer_new
 join public.sales_team_settlement_runs_v1 run on run.run_id=combined.run_id
 join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id and worker.status='running' and worker.lease_until>clock_timestamp()
 join public.sales_team_cash_policy_v1 policy on policy.singleton and policy.transfer_contract_sha256=run.contract_sha256 and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1()
 join public.sales_team_controls_v1 controls on controls.singleton and controls.automatic_transfer_recovery_enabled and controls.automatic_settlement_enabled
 join public.sales_team_settlement_plans_v1 plan on plan.run_id=combined.run_id and plan.kind='earned' and plan.request_id=p_request_id
 where combined.run_id=p_run_id and creatornet_team_private.combined_settlement_task_count_v1(p_run_id)<=3 and
 not exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=plan.id))
$$;
create function creatornet_team_private.combined_transfer_scope_allowed_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_transfer_execution_admissions_v1 admission
 join public.sales_team_settlement_plans_v1 plan on plan.run_id=admission.worker_run_id and plan.task_id=admission.task_id and plan.request_id=admission.request_id
 where admission.request_id=(p_scope->>'scopeId')::uuid and admission.context=p_context and
 creatornet_team_private.combined_transfer_plan_allowed_v1(admission.worker_run_id,admission.request_id))
$$;
create function creatornet_team_private.combined_recovery_task_allowed_v1(p_run_id uuid,p_task_id uuid,p_transfer_id uuid,p_operation_id uuid default null,p_open boolean default true)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_settlement_plans_v1 plan join public.sales_team_settlement_recovery_plans_v1 link on link.plan_id=plan.id
 where plan.run_id=p_run_id and plan.task_id=p_task_id and plan.kind='recovery' and link.transfer_request_id=p_transfer_id and
  exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_settlement_enabled and automatic_transfer_recovery_enabled) and
 (p_operation_id is null or coalesce(link.operation_id,creatornet_team_private.transfer_reversal_operation_id_v1(plan.request_id))=p_operation_id) and
 (not p_open or not exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=plan.id)))
$$;
create function public.claim_sales_team_combined_settlement_v1(p_run_id uuid,p_context jsonb,p_new boolean default false,p_recovery_new boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;transfer_new boolean;recovery_new boolean;dispatch_new boolean;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-settlement-v1',0));
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and automatic_settlement_enabled and automatic_transfer_recovery_enabled and transfer_reversal_observations_enabled and transfer_reversal_recovery_enabled) then return jsonb_build_object('status','held');end if;
 transfer_new:=p_new is true and exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_reservations_enabled and transfer_execution_enabled and transfer_observations_enabled) and exists(select 1 from public.sales_team_cash_policy_v1 where singleton and transfer_cost_reserve_cents is not null);
 recovery_new:=p_recovery_new is true and exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_recovery_reservations_enabled) and exists(select 1 from public.sales_team_cash_policy_v1 where singleton and transfer_reversal_cost_reserve_cents is not null);
 result:=public.claim_sales_team_transfer_recovery_run_v1(p_run_id,p_context,recovery_new);
 if result->>'status'='idle' then result:=public.claim_sales_team_automatic_settlement_v1(p_run_id,p_context,transfer_new);end if;
 if result->>'status'<>'claimed' then return result;end if;
 if not exists(select 1 from public.sales_team_automatic_settlement_runs_v1 where run_id=p_run_id) then insert into public.sales_team_automatic_settlement_runs_v1(run_id,allow_new) values(p_run_id,transfer_new);end if;
 if not exists(select 1 from public.sales_team_transfer_reversal_runs_v1 where run_id=p_run_id) then insert into public.sales_team_transfer_reversal_runs_v1(run_id) values(p_run_id);end if;
 if not exists(select 1 from public.sales_team_transfer_recovery_runs_v1 where run_id=p_run_id) then insert into public.sales_team_transfer_recovery_runs_v1(run_id,allow_new) values(p_run_id,recovery_new);end if;
 select allow_new into transfer_new from public.sales_team_automatic_settlement_runs_v1 where run_id=p_run_id;
 select allow_new into recovery_new from public.sales_team_transfer_recovery_runs_v1 where run_id=p_run_id;
 dispatch_new:=recovery_new and exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_recovery_execution_enabled);
 insert into public.sales_team_transfer_recovery_execution_runs_v1(run_id,allow_new) values(p_run_id,dispatch_new);
 insert into public.sales_team_combined_settlement_runs_v1(run_id,transfer_new,recovery_new,recovery_dispatch) values(p_run_id,transfer_new,recovery_new,dispatch_new);
 perform creatornet_team_private.combined_settlement_worker_v1(p_run_id,(result->>'leaseToken')::uuid,p_context);
 return result||jsonb_build_object('allowNew',transfer_new,'allowRecovery',recovery_new,'allowRecoveryDispatch',dispatch_new);
end $$;
create function creatornet_team_private.combined_settlement_plan_json_v1(p_plan_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select to_jsonb(plan)||case when link.plan_id is null then '{}'::jsonb else jsonb_build_object('recovery',jsonb_build_object('transferRequestId',link.transfer_request_id,'operationId',link.operation_id,'reserved',public.sales_team_transfer_recovery_request_json_v1(plan.request_id))) end
 from public.sales_team_settlement_plans_v1 plan left join public.sales_team_settlement_recovery_plans_v1 link on link.plan_id=plan.id where plan.id=p_plan_id
$$;
create function public.next_sales_team_combined_settlement_plan_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_new boolean default false,p_recovery_new boolean default false,p_refresh boolean default true)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare plan public.sales_team_settlement_plans_v1;chosen record;allow_recovery boolean;prior integer;legacy jsonb;task jsonb;v_task uuid:=gen_random_uuid();v_check uuid:=gen_random_uuid();v_request uuid;begin
 perform creatornet_team_private.combined_settlement_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 perform creatornet_team_private.combined_settlement_worker_v1(p_run_id,p_lease_token,p_context);
 select * into plan from public.sales_team_settlement_plans_v1 p where p.run_id=p_run_id and not exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=p.id) order by p.created_at,p.id limit 1;
 if plan.id is not null then return creatornet_team_private.combined_settlement_plan_json_v1(plan.id);end if;
 if creatornet_team_private.combined_settlement_task_count_v1(p_run_id)>=3 then return null;end if;
 select p_recovery_new is true and recovery_new into allow_recovery from public.sales_team_combined_settlement_runs_v1 where run_id=p_run_id;
 select count(*) into prior from public.sales_team_settlement_plans_v1 where run_id=p_run_id and kind in ('original','recovery');
 select q.id transfer_id,q.receipt_id,q.beneficiary,q.created_at,op.id operation_id,op.scope_id operation_scope,pending.id pending_id,
  (select max(p.created_at) from public.sales_team_settlement_recovery_plans_v1 link join public.sales_team_settlement_plans_v1 p on p.id=link.plan_id where link.transfer_request_id=q.id) attempted
 into chosen from public.sales_team_transfer_requests_v1 q join public.sales_team_transfer_completions_v1 completed on completed.request_id=q.id
 left join lateral(select p.id,p.operation_id from public.sales_team_transfer_recovery_requests_v1 p where p.transfer_request_id=q.id and not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id) order by p.created_at,p.id limit 1) pending on true
 left join lateral(select op.id,op.scope_id from public.sales_team_provider_operations_v1 op where op.kind='reversal' and op.scope_key='recovery:v1' and op.context=p_context and op.request->'params'->'metadata'->>'team_transfer_request_id'=q.id::text and
  (op.status<>'dispatching' or op.lease_until<=clock_timestamp()) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=op.id) order by op.first_dispatch_at,op.id limit 1) op on true
 where q.context=p_context and not exists(select 1 from public.sales_team_settlement_plans_v1 where run_id=p_run_id and receipt_id=q.receipt_id) and
  (op.id is not null or pending.id is not null and not exists(select 1 from public.sales_team_provider_operations_v1 where id=pending.operation_id) or allow_recovery and creatornet_team_private.transfer_recovery_amount_v1(q.id,null)>0)
 order by case when op.id is not null then 0 else 1 end,attempted nulls first,q.created_at,q.id limit 1;
 if chosen.transfer_id is null or prior>=2 then
  legacy:=public.next_sales_team_settlement_plan_v1(p_run_id,p_lease_token,p_context,p_new,p_refresh);
  if legacy is not null then return creatornet_team_private.combined_settlement_plan_json_v1((legacy->>'id')::uuid);end if;
  if chosen.transfer_id is null then return null;end if;
 end if;
 if chosen.operation_id is not null then
  v_request:=chosen.operation_scope;
  perform public.begin_sales_team_reversal_recovery_v1(p_run_id,p_lease_token,p_context,v_task,chosen.operation_id,v_check);
 else
  task:=public.begin_sales_team_transfer_recovery_v1(p_run_id,p_lease_token,p_context,v_task,chosen.transfer_id);v_request:=(task->>'request_id')::uuid;
 end if;
 insert into public.sales_team_settlement_plans_v1(run_id,kind,receipt_id,beneficiary,request_id,task_id,transfer_check_id,recipient_user_id,recipient_id,source_ready)
 select p_run_id,'recovery',chosen.receipt_id,chosen.beneficiary,v_request,v_task,v_check,q.beneficiary_user_id,q.destination_id,false from public.sales_team_transfer_requests_v1 q where q.id=chosen.transfer_id returning * into plan;
 insert into public.sales_team_settlement_recovery_plans_v1(plan_id,transfer_request_id,operation_id) values(plan.id,chosen.transfer_id,chosen.operation_id);
 perform creatornet_team_private.combined_settlement_worker_v1(p_run_id,p_lease_token,p_context);
 return creatornet_team_private.combined_settlement_plan_json_v1(plan.id);
end $$;
alter function public.finish_sales_team_settlement_plan_v1(uuid,uuid,jsonb,uuid,boolean) rename to finish_sales_team_plan_before_combined_v1;
create function public.finish_sales_team_settlement_plan_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_plan_id uuid,p_held boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare plan public.sales_team_settlement_plans_v1;link public.sales_team_settlement_recovery_plans_v1;op_id uuid;canceled boolean;held boolean;creator uuid;begin
 select * into plan from public.sales_team_settlement_plans_v1 where id=p_plan_id and run_id=p_run_id;
 if plan.kind is distinct from 'recovery' then return public.finish_sales_team_plan_before_combined_v1(p_run_id,p_lease_token,p_context,p_plan_id,p_held);end if;
 if not exists(select 1 from public.sales_team_combined_settlement_runs_v1 combined join public.sales_team_settlement_runs_v1 run on run.run_id=combined.run_id where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context) then raise exception 'ORIGINAL_COMBINED_SETTLEMENT_RUN_REQUIRED';end if;
 select * into link from public.sales_team_settlement_recovery_plans_v1 where plan_id=plan.id;op_id:=coalesce(link.operation_id,creatornet_team_private.transfer_reversal_operation_id_v1(plan.request_id));
 if exists(select 1 from public.sales_team_settlement_plan_results_v1 where plan_id=plan.id) then return(select jsonb_build_object('held',result.held,'settled',result.code='settled','canceled',result.code='canceled') from public.sales_team_settlement_plan_results_v1 result where result.plan_id=plan.id);end if;
 canceled:=link.operation_id is null and exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 canceled join public.sales_team_transfer_recovery_tasks_v1 task on task.request_id=canceled.request_id and task.run_id=canceled.worker_run_id where canceled.request_id=plan.request_id and task.id=plan.task_id and task.run_id=p_run_id) and not exists(select 1 from public.sales_team_provider_operations_v1 where id=op_id);
 held:=p_held is distinct from false or not canceled and (not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=op_id) or creatornet_team_private.transfer_accounting_held_v1(link.transfer_request_id));
 insert into public.sales_team_settlement_plan_results_v1(plan_id,held,code) values(plan.id,held,case when held then 'review_required' when canceled then 'canceled' else 'settled' end);
 select creator_id into creator from public.sales_team_transfer_requests_v1 where id=link.transfer_request_id;
 if held then insert into public.sales_team_financial_alerts_v1(creator_id,code,source_identity,evidence) values(creator,'SETTLEMENT_REVIEW_REQUIRED','settlement:'||plan.receipt_id::text||':'||plan.beneficiary,jsonb_build_object('receiptId',plan.receipt_id,'beneficiary',plan.beneficiary,'workerRunId',p_run_id,'operationId',op_id)) on conflict(source_identity) do update set status='open',evidence=excluded.evidence;
 else update public.sales_team_financial_alerts_v1 set status='resolved' where source_identity='settlement:'||plan.receipt_id::text||':'||plan.beneficiary;end if;
 return jsonb_build_object('held',held,'settled',not held and not canceled,'canceled',canceled);
end $$;
-- The count is shared by all existing recovery/observation ports. Keep each
-- logical task once when its plan and admission use the same immutable task ID.
do $count$ declare src text;begin
 select trim(regexp_replace(prosrc,'[[:space:]]+',' ','g')) into src from pg_proc where oid='creatornet_team_private.transfer_recovery_task_count_v1(uuid)'::regprocedure;
 if src<>'select count(*) from (select id from public.sales_team_transfer_recovery_tasks_v1 where run_id=p_run_id union select task_id from public.sales_team_transfer_reversal_checks_v1 where worker_run_id=p_run_id) tasks' then raise exception 'COMBINED_TASK_COUNT_DEPENDENCY_DIFFERS';end if;
end $count$;
create or replace function creatornet_team_private.transfer_recovery_task_count_v1(p_run_id uuid)
returns bigint language sql stable security invoker set search_path=pg_catalog as $$
 select creatornet_team_private.combined_settlement_task_count_v1(p_run_id)
$$;
-- Patches target named installed bodies and exact single-use fragments only.
do $guards$ declare src text;needle text;guard text;item record;begin
 src:=pg_get_functiondef('public.reserve_sales_team_transfer_v1(uuid,uuid,jsonb,uuid,uuid,uuid,text,uuid)'::regprocedure);
 needle:='if exists(select 1 from public.sales_team_transfer_reversal_runs_v1 where run_id=p_run_id) then';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_TRANSFER_RESERVATION_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'if exists(select 1 from public.sales_team_transfer_reversal_runs_v1 where run_id=p_run_id) and not creatornet_team_private.combined_transfer_plan_allowed_v1(p_run_id,p_request_id) then');
 src:=pg_get_functiondef('public.sales_team_transfer_operation_admitted_v1(jsonb,jsonb)'::regprocedure);
 needle:='not exists(select 1 from public.sales_team_transfer_reversal_runs_v1 where run_id=worker.id)';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_TRANSFER_ADMISSION_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'('||needle||' or creatornet_team_private.combined_transfer_plan_allowed_v1(admission.worker_run_id,admission.request_id))');
 src:=pg_get_functiondef('public.sales_team_operation_admitted_v1(jsonb,jsonb)'::regprocedure);
 needle:='when exists(select 1 from public.sales_team_transfer_reversal_runs_v1';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_GENERIC_ADMISSION_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'when p_scope->>''kind''=''transfer'' and creatornet_team_private.combined_transfer_scope_allowed_v1(p_scope,p_context) then public.sales_team_transfer_operation_admitted_v1(p_scope,p_context) '||needle);
 src:=pg_get_functiondef('public.next_sales_team_settlement_plan_v1(uuid,uuid,jsonb,boolean,boolean)'::regprocedure);
 needle:='if (select count(*) from public.sales_team_settlement_plans_v1 where run_id=p_run_id)>=3 then';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_PLAN_LIMIT_DEPENDENCY_DIFFERS';end if;
 src:=replace(src,needle,'if creatornet_team_private.combined_settlement_task_count_v1(p_run_id)>=3 then');needle:='run_id=p_run_id and kind=''original'';';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_PLAN_FAIRNESS_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'run_id=p_run_id and kind in (''original'',''recovery'');');
 src:=pg_get_functiondef('public.begin_sales_team_transfer_check_v1(uuid,uuid,jsonb,uuid,uuid,uuid)'::regprocedure);
 needle:='(select count(*) from public.sales_team_settlement_tasks_v1 where run_id=p_run_id)>=3';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_TRANSFER_CHECK_LIMIT_DEPENDENCY_DIFFERS';end if;
  src:=replace(src,needle,'creatornet_team_private.combined_settlement_task_count_v1(p_run_id)>=3');
  needle:='if creatornet_team_private.combined_settlement_task_count_v1(p_run_id)>=3';
  guard:='if exists(select 1 from public.sales_team_settlement_plans_v1 where task_id=p_task_id and (run_id<>p_run_id or kind not in (''original'',''earned'') or request_id<>q.id)) or exists(select 1 from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id) or exists(select 1 from public.sales_team_transfer_reversal_checks_v1 where task_id=p_task_id) then raise exception ''ORIGINAL_COMBINED_TRANSFER_TASK_REQUIRED'';end if;';
  execute replace(src,needle,guard||needle);
 src:=pg_get_functiondef('public.begin_sales_team_transfer_recovery_v1(uuid,uuid,jsonb,uuid,uuid)'::regprocedure);needle:='if p_task_id is null then';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_RECOVERY_BEGIN_DEPENDENCY_DIFFERS';end if;
  guard:='if exists(select 1 from public.sales_team_settlement_tasks_v1 where id=p_task_id) or exists(select 1 from public.sales_team_settlement_plans_v1 where task_id=p_task_id) and not creatornet_team_private.combined_recovery_task_allowed_v1(p_run_id,p_task_id,p_transfer_id,null,false) then raise exception ''ORIGINAL_COMBINED_RECOVERY_TASK_REQUIRED'';end if;';
 execute replace(src,needle,guard||needle);
 for item in select * from (values
  ('public.run_sales_team_transfer_recovery_v1(uuid,uuid,jsonb,uuid,text,jsonb)','task.transfer_request_id'),
  ('public.reserve_sales_team_transfer_recovery_v1(uuid,uuid,jsonb,uuid,uuid)','task.transfer_request_id')
 ) changes(signature,transfer_field) loop
  src:=pg_get_functiondef(item.signature::regprocedure);needle:='if task.id is null';
  if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_RECOVERY_TASK_DEPENDENCY_DIFFERS: %',item.signature;end if;
  guard:='if exists(select 1 from public.sales_team_combined_settlement_runs_v1 where run_id=p_run_id) and not creatornet_team_private.combined_recovery_task_allowed_v1(p_run_id,p_task_id,'||item.transfer_field||',null,true) then raise exception ''ORIGINAL_COMBINED_RECOVERY_TASK_REQUIRED'';end if;';
  execute replace(src,needle,guard||needle);
 end loop;
 src:=pg_get_functiondef('public.run_sales_team_transfer_recovery_execution_v1(uuid,uuid,jsonb,uuid,text,jsonb)'::regprocedure);
 needle:='if p.id is null then raise exception ''ORIGINAL_RECOVERY_EXECUTION_TASK_REQUIRED'';end if;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_RECOVERY_EXECUTION_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||'if p_phase not in (''unknown'',''bind'') and exists(select 1 from public.sales_team_combined_settlement_runs_v1 where run_id=p_run_id) and not creatornet_team_private.combined_recovery_task_allowed_v1(p_run_id,p_task_id,p.transfer_request_id,p.operation_id,true) then raise exception ''ORIGINAL_COMBINED_RECOVERY_TASK_REQUIRED'';end if;');
 src:=pg_get_functiondef('public.begin_sales_team_reversal_check_v1(uuid,uuid,jsonb,uuid,uuid,uuid)'::regprocedure);
 needle:='original:=creatornet_team_private.transfer_reversal_original_v1(p_operation_id,p_context);select * into q from public.sales_team_transfer_requests_v1 where id=(original->''transfer''->>''id'')::uuid;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_REVERSAL_CHECK_DEPENDENCY_DIFFERS';end if;
  guard:='if exists(select 1 from public.sales_team_settlement_tasks_v1 where id=p_task_id) or exists(select 1 from public.sales_team_settlement_plans_v1 where task_id=p_task_id) and not creatornet_team_private.combined_recovery_task_allowed_v1(p_run_id,p_task_id,q.id,p_operation_id,false) then raise exception ''ORIGINAL_COMBINED_RECOVERY_TASK_REQUIRED'';end if;';
 execute replace(src,needle,needle||guard);
 src:=pg_get_functiondef('public.begin_sales_team_reversal_recovery_v1(uuid,uuid,jsonb,uuid,uuid,uuid)'::regprocedure);
 needle:='perform pg_advisory_xact_lock(hashtextextended(''sales-team-financial:''||q.creator_id::text,0));';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_UNKNOWN_CHECK_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,guard||needle);
 src:=pg_get_functiondef('public.finish_sales_team_automatic_settlement_v1(uuid,uuid,jsonb,boolean)'::regprocedure);needle:='when p_failed is distinct from false or exists(';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'COMBINED_FINISH_DEPENDENCY_DIFFERS';end if;
 guard:='when p_failed is distinct from false or exists(select 1 from public.sales_team_combined_settlement_runs_v1 where run_id=p_run_id) and (exists(select 1 from public.sales_team_transfer_recovery_tasks_v1 task where task.run_id=p_run_id and not exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=task.request_id) and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=creatornet_team_private.transfer_reversal_operation_id_v1(task.request_id))) or exists(select 1 from public.sales_team_transfer_reversal_checks_v1 checked where checked.worker_run_id=p_run_id and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=checked.operation_id))) or exists(';
 execute replace(src,needle,guard);
end $guards$;
create function public.finish_sales_team_combined_settlement_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_failed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_combined_settlement_runs_v1 combined join public.sales_team_settlement_runs_v1 run on run.run_id=combined.run_id where combined.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context) then raise exception 'ORIGINAL_COMBINED_SETTLEMENT_RUN_REQUIRED';end if;
 perform public.finish_sales_team_automatic_settlement_v1(p_run_id,p_lease_token,p_context,p_failed);
 return(select jsonb_build_object('status',status) from public.sales_team_worker_runs_v1 where id=p_run_id);
end $$;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''combined_settlement_worker_v1'',''combined_settlement_task_count_v1'',''combined_transfer_plan_allowed_v1'',''combined_transfer_scope_allowed_v1'',''combined_recovery_task_allowed_v1'',''combined_settlement_plan_json_v1'',''transfer_recovery_task_count_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''claim_sales_team_combined_settlement_v1'',''next_sales_team_combined_settlement_plan_v1'',''finish_sales_team_combined_settlement_v1'',''finish_sales_team_plan_before_combined_v1'',''finish_sales_team_settlement_plan_v1'',''finish_sales_team_automatic_settlement_v1'',''next_sales_team_settlement_plan_v1'',''reserve_sales_team_transfer_v1'',''sales_team_transfer_operation_admitted_v1'',''sales_team_operation_admitted_v1'',''begin_sales_team_transfer_check_v1'',''begin_sales_team_transfer_recovery_v1'',''run_sales_team_transfer_recovery_v1'',''reserve_sales_team_transfer_recovery_v1'',''run_sales_team_transfer_recovery_execution_v1'',''begin_sales_team_reversal_check_v1'',''begin_sales_team_reversal_recovery_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'COMBINED_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_combined_settlement_runs_v1','sales_team_settlement_recovery_plans_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_combined_settlement_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('claim_sales_team_combined_settlement_v1','next_sales_team_combined_settlement_plan_v1','finish_sales_team_combined_settlement_v1','finish_sales_team_settlement_plan_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('combined_settlement_worker_v1','combined_settlement_task_count_v1','combined_transfer_plan_allowed_v1','combined_transfer_scope_allowed_v1','combined_recovery_task_allowed_v1','combined_settlement_plan_json_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
 revoke all on function public.finish_sales_team_plan_before_combined_v1(uuid,uuid,jsonb,uuid,boolean) from public,anon,authenticated,service_role;
end $grants$;
commit;
