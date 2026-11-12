-- Local candidate: bounded exact-current-worker transfer execution authority.
-- No scheduler or external operation is activated by installing this candidate.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column transfer_execution_enabled boolean not null default false;
create table public.sales_team_transfer_execution_admissions_v1 (
 request_id uuid primary key references public.sales_team_transfer_requests_v1(id) on delete restrict,
 operation_id uuid not null unique references public.sales_team_provider_operations_v1(id) on delete restrict deferrable initially deferred,
 task_id uuid not null references public.sales_team_settlement_tasks_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 read_id uuid not null references public.sales_team_cash_observations_v1(read_id) on delete restrict,
 context jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_execution_actions_v1 (
 id bigint generated always as identity primary key,request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 task_id uuid not null references public.sales_team_settlement_tasks_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 phase text not null check(phase in ('assert','unknown','bind')),provider_lease_token uuid not null,
 read_id uuid references public.sales_team_cash_observations_v1(read_id) on delete restrict,created_at timestamptz not null default clock_timestamp()
);
create function creatornet_team_private.transfer_accounting_held_v1(p_request_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select not exists(select 1 from public.sales_team_transfer_requests_v1 q join public.sales_team_receipts_v1 r on r.id=q.receipt_id
 join public.sales_team_payment_runtime_v1 runtime on runtime.sale_id=q.sale_id where q.id=p_request_id and not r.review_hold and not r.dispute_hold and not runtime.financial_hold and
 exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id) and
 not exists(select 1 from public.sales_team_creator_balances_v1 debt where debt.creator_id=q.creator_id and (debt.creator_deficit_cents>0 or debt.creator_released_cents-debt.creator_reversed_cents>debt.creator_proceeds_cents)) and
 not exists(select 1 from public.sales_team_commission_balances_v1 debt where debt.creator_id=q.creator_id and debt.released_cents-debt.reversed_cents>debt.earned_cents) and
 not exists(select 1 from public.sales_team_financial_alerts_v1 where creator_id=q.creator_id and code='TRANSFER_COST_RESERVE_EXCEEDED' and status<>'resolved'))
$$;
create function creatornet_team_private.transfer_execution_cash_v1(p_request_id uuid,p_run_id uuid)
returns uuid language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;cash public.sales_team_cash_reads_v1;begin
 select * into q from public.sales_team_transfer_requests_v1 where id=p_request_id;
 select r.* into cash from public.sales_team_transfer_cash_rechecks_v1 checked join public.sales_team_cash_reads_v1 r on r.id=checked.read_id
 where checked.request_id=q.id and checked.worker_run_id=p_run_id and r.settlement_worker_run_id=p_run_id and r.context=q.context
 order by r.created_at desc,r.id desc limit 1;
 if cash.id is null or cash.created_at<clock_timestamp()-interval '25 seconds' or cash.protection is distinct from creatornet_team_private.cash_protection_v1(q.context) then return null;end if;
 return cash.id;
end $$;
alter function public.sales_team_transfer_operation_admitted_v1(jsonb,jsonb) rename to sales_team_transfer_admitted_before_execution_v1;
create function public.sales_team_transfer_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_execution_enabled and transfer_observations_enabled) and
 exists(select 1 from public.sales_team_transfer_execution_admissions_v1 admission join public.sales_team_settlement_tasks_v1 task on task.id=admission.task_id and task.run_id=admission.worker_run_id and task.request_id=admission.request_id
 join public.sales_team_settlement_runs_v1 run on run.run_id=admission.worker_run_id join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id
 join public.sales_team_cash_policy_v1 policy on policy.singleton where admission.request_id=(p_scope->>'scopeId')::uuid and admission.context=p_context and run.context=p_context and
 worker.kind='settlement' and worker.status='running' and worker.lease_until>clock_timestamp() and run.contract_sha256=policy.transfer_contract_sha256 and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1() and
 creatornet_team_private.transfer_execution_cash_v1(admission.request_id,admission.worker_run_id) is not null) and
 public.sales_team_transfer_admitted_before_execution_v1(p_scope,p_context)
$$;
-- All journal calls go through the actual current task's supplied authority.
-- Outcome-only audit/binding can finish after the worker's lease expires; it
-- requires that exact run token and an already asserted original dispatch lease.
create function public.run_sales_team_transfer_execution_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_phase text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;op public.sales_team_provider_operations_v1;admission public.sales_team_transfer_execution_admissions_v1;
 cash_id uuid;result jsonb;scope jsonb;provider_token uuid;begin
 if p_phase is null or p_phase not in ('read','claim','assert','unknown','bind') then raise exception 'TRANSFER_EXECUTION_PHASE_REQUIRED';end if;
 if p_phase in ('read','claim','assert') then perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);
 elsif not exists(select 1 from public.sales_team_settlement_runs_v1 where run_id=p_run_id and lease_token=p_lease_token and context=p_context) then raise exception 'ORIGINAL_TRANSFER_DISPATCH_WORKER_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select original.* into q from public.sales_team_settlement_tasks_v1 task join public.sales_team_transfer_requests_v1 original on original.id=task.request_id
 where task.id=p_task_id and task.run_id=p_run_id and original.context=p_context;
 if q.id is null then raise exception 'ORIGINAL_TRANSFER_EXECUTION_TASK_REQUIRED';end if;
 scope:=public.sales_team_transfer_request_json_v1(q.id)->'scope';
 if p_phase='read' then perform creatornet_team_private.financial_shape_v1(p_payload,'{}');return public.sales_team_transfer_request_json_v1(q.id);end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id for update;
 if p_phase='claim' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{"operationId":"string","scope":"object","request":"object"}');
  if p_payload->>'operationId'<>q.operation_id::text or p_payload->'scope' is distinct from scope or p_payload->'request' is distinct from q.request then raise exception 'ORIGINAL_TRANSFER_EXECUTION_REQUEST_REQUIRED';end if;
  if op.id is null then
   if not exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_execution_enabled and transfer_observations_enabled) then return jsonb_build_object('status','not_enabled');end if;
   cash_id:=creatornet_team_private.transfer_execution_cash_v1(q.id,p_run_id);
   if cash_id is null or not public.sales_team_transfer_admitted_before_execution_v1(scope,p_context) then raise exception 'CURRENT_TRANSFER_EXECUTION_CASH_REQUIRED';end if;
   insert into public.sales_team_transfer_execution_admissions_v1(request_id,operation_id,task_id,worker_run_id,read_id,context) values(q.id,q.operation_id,p_task_id,p_run_id,cash_id,p_context);
  end if;
  result:=public.claim_sales_team_provider_operation_v1(q.operation_id,scope,p_context,q.request);
  if op.id is null and result->>'status'<>'dispatch' then raise exception 'TRANSFER_EXECUTION_ADMISSION_CHANGED';end if;
  return result;
 end if;
 perform creatornet_team_private.financial_shape_v1(p_payload,case when p_phase='bind' then '{"operationId":"string","leaseToken":"string","providerId":"string","providerRequestId":"string","reconciled":"boolean"}'::jsonb else '{"operationId":"string","leaseToken":"string"}'::jsonb end);
 provider_token:=(p_payload->>'leaseToken')::uuid;
 select * into admission from public.sales_team_transfer_execution_admissions_v1 where request_id=q.id and worker_run_id=p_run_id and task_id=p_task_id and context=p_context;
 if admission.request_id is null or op.id is null or p_payload->>'operationId'<>q.operation_id::text or op.lease_token is distinct from provider_token or op.context is distinct from p_context or op.request is distinct from q.request or op.worker_run_id is distinct from q.original_worker_run_id then raise exception 'ORIGINAL_TRANSFER_DISPATCH_AUTHORITY_REQUIRED';end if;
 if p_phase='assert' then
  cash_id:=creatornet_team_private.transfer_execution_cash_v1(q.id,p_run_id);
  if cash_id is null then raise exception 'CURRENT_TRANSFER_EXECUTION_CASH_REQUIRED';end if;
  result:=public.assert_sales_team_provider_dispatch_v1(q.operation_id,provider_token);
 else
  if not exists(select 1 from public.sales_team_transfer_execution_actions_v1 where request_id=q.id and worker_run_id=p_run_id and task_id=p_task_id and phase='assert' and provider_lease_token=provider_token and created_at>clock_timestamp()-interval '90 seconds') then raise exception 'ASSERTED_ORIGINAL_TRANSFER_DISPATCH_REQUIRED';end if;
  if p_phase='unknown' then perform public.mark_sales_team_provider_unknown_v1(q.operation_id,provider_token);result:=public.sales_team_operation_json_v1(q.operation_id);
  else
   if p_payload->'reconciled' is distinct from 'false'::jsonb or p_payload->>'providerId'!~'^tr_[A-Za-z0-9]+$' then raise exception 'INDEPENDENT_TRANSFER_RECOVERY_REQUIRED';end if;
   result:=public.bind_sales_team_provider_operation_v1(q.operation_id,p_payload->>'providerId',p_payload->>'providerRequestId',false);
  end if;
 end if;
 insert into public.sales_team_transfer_execution_actions_v1(request_id,task_id,worker_run_id,phase,provider_lease_token,read_id) values(q.id,p_task_id,p_run_id,p_phase,provider_token,cash_id);
 return result;
end $$;
do $contracts$ declare src text;needle text;begin
 src:=pg_get_functiondef('public.sales_team_transfer_request_json_v1(uuid)'::regprocedure);
 -- pg_get_functiondef preserves the SQL body text; fail on an unknown body.
 needle:='''completed'',exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id)';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_EXECUTION_READ_MODEL_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'''held'',creatornet_team_private.transfer_accounting_held_v1(q.id),'||needle);
 src:=pg_get_functiondef('creatornet_team_private.transfer_contract_digest_v1()'::regprocedure);needle:='''transfer_cost_total_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_EXECUTION_PRIVATE_DIGEST_DIFFERS';end if;
 src:=replace(src,needle,needle||',''transfer_accounting_held_v1'',''transfer_execution_cash_v1''');needle:='''sales_team_transfer_operation_id_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_EXECUTION_PUBLIC_DIGEST_DIFFERS';end if;
 execute replace(src,needle,needle||',''run_sales_team_transfer_execution_v1'',''sales_team_transfer_admitted_before_execution_v1''');
end $contracts$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_transfer_execution_admissions_v1','sales_team_transfer_execution_actions_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_transfer_execution_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('run_sales_team_transfer_execution_v1','sales_team_transfer_operation_admitted_v1','sales_team_transfer_admitted_before_execution_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('transfer_accounting_held_v1','transfer_execution_cash_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
