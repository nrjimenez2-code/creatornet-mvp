-- Default-off candidate: exact-current-worker dispatch of one frozen recovery.
-- No schedule, feature activation, provider request or bank assertion is installed.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column transfer_recovery_execution_enabled boolean not null default false;
create table public.sales_team_transfer_recovery_execution_runs_v1 (
 run_id uuid primary key references public.sales_team_transfer_recovery_runs_v1(run_id) on delete restrict,
 allow_new boolean not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_recovery_execution_reads_v1 (
 id uuid primary key,task_id uuid not null references public.sales_team_transfer_recovery_tasks_v1(id) on delete restrict,
 receipt_revision integer not null,created_at timestamptz not null default clock_timestamp()
);
create index transfer_recovery_execution_read_task_v1 on public.sales_team_transfer_recovery_execution_reads_v1(task_id);
create table public.sales_team_transfer_recovery_execution_roots_v1 (
 read_id uuid primary key references public.sales_team_transfer_recovery_execution_reads_v1(id) on delete restrict,
 ready boolean not null,proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_recovery_execution_rechecks_v1 (
 check_id uuid primary key references public.sales_team_transfer_recovery_execution_roots_v1(read_id) on delete restrict,
 request_id uuid not null references public.sales_team_transfer_recovery_requests_v1(id) on delete restrict,
 task_id uuid not null references public.sales_team_transfer_recovery_tasks_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_transfer_recovery_execution_runs_v1(run_id) on delete restrict,
 read_id uuid not null unique references public.sales_team_cash_observations_v1(read_id) on delete restrict,created_at timestamptz not null default clock_timestamp()
);
create index transfer_recovery_execution_recheck_original_v1 on public.sales_team_transfer_recovery_execution_rechecks_v1(request_id,worker_run_id);
create table public.sales_team_transfer_recovery_execution_admissions_v1 (
 request_id uuid primary key references public.sales_team_transfer_recovery_requests_v1(id) on delete restrict,
 operation_id uuid not null unique references public.sales_team_provider_operations_v1(id) on delete restrict deferrable initially deferred,
 task_id uuid not null references public.sales_team_transfer_recovery_tasks_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_transfer_recovery_execution_runs_v1(run_id) on delete restrict,
 check_id uuid not null references public.sales_team_transfer_recovery_execution_roots_v1(read_id) on delete restrict,
 read_id uuid not null references public.sales_team_cash_observations_v1(read_id) on delete restrict,context jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_recovery_execution_actions_v1 (
 id bigint generated always as identity primary key,request_id uuid not null references public.sales_team_transfer_recovery_requests_v1(id) on delete restrict,
 task_id uuid not null references public.sales_team_transfer_recovery_tasks_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_transfer_recovery_execution_runs_v1(run_id) on delete restrict,
 phase text not null check(phase in ('assert','unknown','bind')),provider_lease_token uuid not null,
 check_id uuid references public.sales_team_transfer_recovery_execution_roots_v1(read_id) on delete restrict,
 read_id uuid references public.sales_team_cash_observations_v1(read_id) on delete restrict,
 provider_id text,provider_request_id text,created_at timestamptz not null default clock_timestamp(),unique(request_id,phase),
 check(phase='bind' and provider_id is not null and provider_request_id is not null and provider_id~'^trr_[A-Za-z0-9]+$' and provider_request_id~'^req_[A-Za-z0-9]+$' or phase<>'bind' and provider_id is null and provider_request_id is null),
 check(phase<>'assert' or check_id is not null and read_id is not null)
);
create table public.sales_team_transfer_recovery_execution_assertions_v1 (
 request_id uuid primary key references public.sales_team_transfer_recovery_requests_v1(id) on delete restrict,
 action_id bigint not null unique references public.sales_team_transfer_recovery_execution_actions_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create function public.claim_sales_team_transfer_recovery_execution_run_v1(p_run_id uuid,p_context jsonb,p_new boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;permitted boolean;begin
 result:=public.claim_sales_team_transfer_recovery_run_v1(p_run_id,p_context,p_new);
 if result->>'status'<>'claimed' then return result;end if;
 permitted:=p_new and result->'allowNew'='true'::jsonb and exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_recovery_execution_enabled);
 insert into public.sales_team_transfer_recovery_execution_runs_v1(run_id,allow_new) values(p_run_id,permitted);
 return result||jsonb_build_object('allowDispatch',permitted);
end $$;
create function creatornet_team_private.transfer_recovery_execution_allowed_v1(p_run_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_transfer_recovery_execution_runs_v1 execution join public.sales_team_transfer_recovery_runs_v1 recovery on recovery.run_id=execution.run_id and recovery.allow_new
 join public.sales_team_settlement_runs_v1 run on run.run_id=execution.run_id join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id
 join public.sales_team_cash_policy_v1 policy on policy.singleton join public.sales_team_financial_config_v1 config on config.singleton and config.context=run.context
 join public.sales_team_controls_v1 controls on controls.singleton and controls.settlement_enabled and controls.transfer_recovery_reservations_enabled and controls.transfer_reversal_observations_enabled and controls.transfer_recovery_execution_enabled
 where execution.run_id=p_run_id and execution.allow_new and run.context=p_context and worker.kind='settlement' and worker.status='running' and worker.lease_until>clock_timestamp() and
 run.contract_sha256=policy.transfer_contract_sha256 and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1())
$$;
create function creatornet_team_private.transfer_recovery_execution_worker_v1(p_run_id uuid,p_token uuid,p_context jsonb,p_new boolean default false)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 perform creatornet_team_private.transfer_recovery_worker_v1(p_run_id,p_token,p_context,p_new);
 if not exists(select 1 from public.sales_team_transfer_recovery_execution_runs_v1 where run_id=p_run_id) or
  p_new and not creatornet_team_private.transfer_recovery_execution_allowed_v1(p_run_id,p_context) then raise exception 'CURRENT_TRANSFER_RECOVERY_EXECUTION_WORKER_REQUIRED';end if;
end $$;
-- Reuse the exact installed F30 root validator. Only the named storage and read
-- identity differ; financial branches remain unreachable through this private
-- clone. The outer checked port supplies the execution authority and two-read cap.
do $root$ declare src text;item record;begin
 src:=pg_get_functiondef('public.run_sales_team_transfer_recovery_v1(uuid,uuid,jsonb,uuid,text,jsonb)'::regprocedure);
 for item in select * from (values
  ('public.run_sales_team_transfer_recovery_v1(','creatornet_team_private.run_transfer_recovery_execution_root_v1(',1),
  ('p_phase text','p_check_id uuid, p_phase text',1),
  ('sales_team_transfer_recovery_root_reads_v1','sales_team_transfer_recovery_execution_reads_v1',3),
  ('sales_team_transfer_recovery_roots_v1','sales_team_transfer_recovery_execution_roots_v1',4),
  ('task.root_read_id','p_check_id',5)
 ) changes(needle,replacement,expected) loop
  if (length(src)-length(replace(src,item.needle,'')))/length(item.needle)<>item.expected then raise exception 'RECOVERY_EXECUTION_ROOT_DEPENDENCY_DIFFERS: %',item.needle;end if;
  src:=replace(src,item.needle,item.replacement);
 end loop;execute src;
end $root$;
create function creatornet_team_private.transfer_recovery_execution_fresh_v1(p_request_id uuid,p_run_id uuid,p_check_id uuid,p_read_id uuid)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare p public.sales_team_transfer_recovery_requests_v1;source jsonb;v_protection jsonb;begin
 select * into p from public.sales_team_transfer_recovery_requests_v1 where id=p_request_id;
 if p.id is null or exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) or exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id) then return false;end if;
 source:=creatornet_team_private.transfer_recovery_source_v1(p.transfer_request_id,p.id);
 if source is null or (source->>'amountCents')::bigint<p.amount_cents then return false;end if;
 if not exists(select 1 from public.sales_team_transfer_recovery_execution_reads_v1 root join public.sales_team_transfer_recovery_execution_roots_v1 proof on proof.read_id=root.id and proof.ready
  join public.sales_team_transfer_recovery_tasks_v1 task on task.id=root.task_id and task.run_id=p_run_id and task.request_id=p.id and task.transfer_request_id=p.transfer_request_id
  where root.id=p_check_id and root.receipt_revision=(source->>'revision')::integer and root.created_at>clock_timestamp()-interval '25 seconds') then return false;end if;
 v_protection:=creatornet_team_private.cash_protection_v1(p.context);
 if not exists(select 1 from public.sales_team_cash_reads_v1 cash join public.sales_team_cash_observations_v1 observation on observation.read_id=cash.id
  where cash.id=p_read_id and cash.settlement_worker_run_id=p_run_id and cash.context=p.context and cash.protection=v_protection and cash.created_at>clock_timestamp()-interval '25 seconds') then return false;end if;
 return coalesce(creatornet_team_private.cash_available_floor_v1(p.context,v_protection->'epoch')>=(v_protection->>'teamCents')::numeric+(v_protection->'shared'->>'protectedCents')::numeric+(v_protection->>'reserveCents')::numeric+creatornet_team_private.cash_encumbered_v1(),false);
end $$;
create function creatornet_team_private.transfer_recovery_execution_recheck_v1(p_request_id uuid,p_run_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare checked public.sales_team_transfer_recovery_execution_rechecks_v1;begin
 select c.* into checked from public.sales_team_transfer_recovery_execution_rechecks_v1 c join public.sales_team_transfer_recovery_execution_reads_v1 root on root.id=c.check_id
 where c.request_id=p_request_id and c.worker_run_id=p_run_id order by root.created_at desc,root.id desc limit 1;
 if checked.check_id is null or not creatornet_team_private.transfer_recovery_execution_fresh_v1(p_request_id,p_run_id,checked.check_id,checked.read_id) then return null;end if;
 return jsonb_build_object('checkId',checked.check_id,'readId',checked.read_id);
end $$;
create function public.sales_team_transfer_recovery_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_transfer_recovery_requests_v1 p join public.sales_team_transfer_recovery_execution_admissions_v1 admission on admission.request_id=p.id and admission.operation_id=p.operation_id and admission.context=p.context
 join public.sales_team_transfer_recovery_tasks_v1 task on task.id=admission.task_id and task.run_id=admission.worker_run_id and task.request_id=p.id and task.transfer_request_id=p.transfer_request_id
 where p.id=(p_scope->>'scopeId')::uuid and p.context=p_context and public.sales_team_transfer_recovery_request_json_v1(p.id)->'scope'=p_scope and
 creatornet_team_private.transfer_recovery_execution_allowed_v1(admission.worker_run_id,p_context) and creatornet_team_private.transfer_recovery_execution_recheck_v1(p.id,admission.worker_run_id) is not null)
$$;
-- Single-use assertion consumption closes older generic assert aliases. The
-- action is written only by the actual-token port; service cannot fabricate it.
create function creatornet_team_private.consume_transfer_recovery_assertion_v1(p_operation_id uuid,p_provider_token uuid)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare p public.sales_team_transfer_recovery_requests_v1;action public.sales_team_transfer_recovery_execution_actions_v1;checked jsonb;scope jsonb;begin
 select * into p from public.sales_team_transfer_recovery_requests_v1 where operation_id=p_operation_id;
 select * into action from public.sales_team_transfer_recovery_execution_actions_v1 where request_id=p.id and phase='assert' and provider_lease_token=p_provider_token;
 scope:=public.sales_team_transfer_recovery_request_json_v1(p.id)->'scope';checked:=creatornet_team_private.transfer_recovery_execution_recheck_v1(p.id,action.worker_run_id);
 if action.id is null or checked is null or action.check_id::text is distinct from checked->>'checkId' or action.read_id::text is distinct from checked->>'readId' or
  not exists(select 1 from public.sales_team_transfer_recovery_execution_admissions_v1 admission join public.sales_team_transfer_recovery_execution_reads_v1 root on root.id=action.check_id and root.created_at>=admission.created_at
   join public.sales_team_cash_reads_v1 cash on cash.id=action.read_id and cash.created_at>=admission.created_at where admission.request_id=p.id and admission.worker_run_id=action.worker_run_id and admission.task_id=action.task_id and admission.check_id<>action.check_id and admission.read_id<>action.read_id) or
  not public.sales_team_transfer_recovery_operation_admitted_v1(scope,p.context) or exists(select 1 from public.sales_team_transfer_recovery_execution_assertions_v1 where request_id=p.id) then raise exception 'SINGLE_CURRENT_RECOVERY_ASSERTION_REQUIRED';end if;
 insert into public.sales_team_transfer_recovery_execution_assertions_v1(request_id,action_id) values(p.id,action.id);
 if not public.sales_team_transfer_recovery_operation_admitted_v1(scope,p.context) then raise exception 'SINGLE_CURRENT_RECOVERY_ASSERTION_REQUIRED';end if;
end $$;
create function creatornet_team_private.transfer_recovery_outcome_allowed_v1(p_operation_id uuid,p_provider_token uuid,p_phase text,p_provider_id text default null,p_provider_request_id text default null)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_transfer_recovery_requests_v1 p join public.sales_team_transfer_recovery_execution_admissions_v1 admission on admission.request_id=p.id and admission.operation_id=p.operation_id and admission.context=p.context
 join public.sales_team_transfer_recovery_execution_actions_v1 asserted on asserted.request_id=p.id and asserted.worker_run_id=admission.worker_run_id and asserted.task_id=admission.task_id and asserted.phase='assert' and asserted.provider_lease_token=p_provider_token
 join public.sales_team_transfer_recovery_execution_assertions_v1 consumed on consumed.request_id=p.id and consumed.action_id=asserted.id
 join public.sales_team_transfer_recovery_execution_actions_v1 outcome on outcome.request_id=p.id and outcome.worker_run_id=admission.worker_run_id and outcome.task_id=admission.task_id and outcome.phase=p_phase and outcome.provider_lease_token=p_provider_token
 where p.operation_id=p_operation_id and asserted.created_at>clock_timestamp()-interval '90 seconds' and outcome.provider_id is not distinct from p_provider_id and outcome.provider_request_id is not distinct from p_provider_request_id)
$$;
create function public.run_sales_team_transfer_recovery_execution_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_phase text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare task public.sales_team_transfer_recovery_tasks_v1;p public.sales_team_transfer_recovery_requests_v1;q public.sales_team_transfer_requests_v1;op public.sales_team_provider_operations_v1;
 admission public.sales_team_transfer_recovery_execution_admissions_v1;scope jsonb;result jsonb;checked jsonb;v_check_id uuid;cash_id uuid;provider_token uuid;begin
 if p_phase is null or p_phase not in ('read','begin_financial','complete_financial','unsent','begin_check','complete_check','recheck','claim','assert','unknown','bind') then raise exception 'RECOVERY_EXECUTION_PHASE_REQUIRED';end if;
 if p_phase in ('unknown','bind') then
  if not exists(select 1 from public.sales_team_settlement_runs_v1 run join public.sales_team_transfer_recovery_execution_runs_v1 execution on execution.run_id=run.run_id where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context) then raise exception 'ORIGINAL_RECOVERY_DISPATCH_WORKER_REQUIRED';end if;
 else perform creatornet_team_private.transfer_recovery_execution_worker_v1(p_run_id,p_lease_token,p_context);end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into task from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id;
 select * into p from public.sales_team_transfer_recovery_requests_v1 where id=task.request_id and transfer_request_id=task.transfer_request_id and context=p_context;
 select * into q from public.sales_team_transfer_requests_v1 where id=p.transfer_request_id;
 if p.id is null then raise exception 'ORIGINAL_RECOVERY_EXECUTION_TASK_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 select * into op from public.sales_team_provider_operations_v1 where id=p.operation_id for update;scope:=public.sales_team_transfer_recovery_request_json_v1(p.id)->'scope';
 if p_phase='read' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{}');perform creatornet_team_private.transfer_recovery_execution_worker_v1(p_run_id,p_lease_token,p_context);
  return public.sales_team_transfer_recovery_request_json_v1(p.id)||jsonb_build_object('held',creatornet_team_private.transfer_accounting_held_v1(q.id),'source_ready',creatornet_team_private.transfer_recovery_source_v1(q.id,p.id) is not null,'financial_check_id',task.financial_check_id,'new_allowed',creatornet_team_private.transfer_recovery_execution_allowed_v1(p_run_id,p_context));
 end if;
 if p_phase not in ('unknown','bind') then perform creatornet_team_private.transfer_recovery_execution_worker_v1(p_run_id,p_lease_token,p_context,true);end if;
 if p_phase in ('begin_financial','complete_financial') then
  if op.id is not null then raise exception 'ORIGINAL_RECOVERY_RECONCILIATION_REQUIRED';end if;
  result:=public.run_sales_team_transfer_recovery_v1(p_run_id,p_lease_token,p_context,p_task_id,p_phase,p_payload);
 elsif p_phase='unsent' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{}');if op.id is not null then raise exception 'ORIGINAL_RECOVERY_RECONCILIATION_REQUIRED';end if;
  if creatornet_team_private.transfer_recovery_amount_v1(q.id,p.id)<p.amount_cents then result:=public.cancel_unsent_sales_team_transfer_recovery_v1(p_run_id,p_lease_token,p_context,p_task_id);else result:=jsonb_build_object('canceled',false);end if;
 elsif p_phase in ('begin_check','complete_check','recheck') then
  if exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) or exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p.operation_id) then raise exception 'ORIGINAL_RECOVERY_RECONCILIATION_REQUIRED';end if;
  if op.id is not null and (op.status<>'dispatching' or op.provider_id is not null or not exists(select 1 from public.sales_team_transfer_recovery_execution_admissions_v1 where request_id=p.id and worker_run_id=p_run_id and task_id=p_task_id)) then raise exception 'ORIGINAL_RECOVERY_RECONCILIATION_REQUIRED';end if;
  v_check_id:=(p_payload->>'checkId')::uuid;if v_check_id is null then raise exception 'RECOVERY_EXECUTION_CHECK_ID_REQUIRED';end if;
  if p_phase='begin_check' then
   perform creatornet_team_private.financial_shape_v1(p_payload,'{"checkId":"string"}');
   if exists(select 1 from public.sales_team_transfer_recovery_execution_reads_v1 where id=v_check_id and task_id<>task.id) then raise exception 'ORIGINAL_RECOVERY_EXECUTION_CHECK_CHANGED';end if;
   if (select count(*) from public.sales_team_transfer_recovery_execution_reads_v1 where task_id=task.id)>=2 and not exists(select 1 from public.sales_team_transfer_recovery_execution_reads_v1 where id=v_check_id and task_id=task.id) then raise exception 'RECOVERY_EXECUTION_RECHECK_LIMIT_REQUIRED';end if;
   result:=creatornet_team_private.run_transfer_recovery_execution_root_v1(p_run_id,p_lease_token,p_context,p_task_id,v_check_id,'begin_root','{}');
  elsif p_phase='complete_check' then
   perform creatornet_team_private.financial_shape_v1(p_payload,'{"checkId":"string","proof":"object"}');
   result:=creatornet_team_private.run_transfer_recovery_execution_root_v1(p_run_id,p_lease_token,p_context,p_task_id,v_check_id,'complete_root',p_payload->'proof');
  else
   perform creatornet_team_private.financial_shape_v1(p_payload,'{"checkId":"string","readId":"string"}');cash_id:=(p_payload->>'readId')::uuid;
   if not creatornet_team_private.transfer_recovery_execution_fresh_v1(p.id,p_run_id,v_check_id,cash_id) then raise exception 'FRESH_RECOVERY_EXECUTION_SOURCE_CASH_REQUIRED';end if;
   if exists(select 1 from public.sales_team_transfer_recovery_execution_rechecks_v1 checked where checked.check_id=v_check_id and (request_id<>p.id or task_id<>p_task_id or worker_run_id<>p_run_id or read_id<>cash_id)) then raise exception 'ORIGINAL_RECOVERY_EXECUTION_RECHECK_CHANGED';end if;
   insert into public.sales_team_transfer_recovery_execution_rechecks_v1(check_id,request_id,task_id,worker_run_id,read_id) values(v_check_id,p.id,p_task_id,p_run_id,cash_id) on conflict(check_id) do nothing;
   result:=jsonb_build_object('ready',true);
  end if;
 elsif p_phase='claim' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{"operationId":"string","scope":"object","request":"object"}');
  if p_payload->>'operationId'<>p.operation_id::text or p_payload->'scope' is distinct from scope or p_payload->'request' is distinct from p.request then raise exception 'ORIGINAL_RECOVERY_EXECUTION_REQUEST_REQUIRED';end if;
  if op.id is not null then raise exception 'ORIGINAL_RECOVERY_RECONCILIATION_REQUIRED';end if;
  checked:=creatornet_team_private.transfer_recovery_execution_recheck_v1(p.id,p_run_id);if checked is null then raise exception 'FRESH_RECOVERY_EXECUTION_SOURCE_CASH_REQUIRED';end if;
  insert into public.sales_team_transfer_recovery_execution_admissions_v1(request_id,operation_id,task_id,worker_run_id,check_id,read_id,context) values(p.id,p.operation_id,p_task_id,p_run_id,(checked->>'checkId')::uuid,(checked->>'readId')::uuid,p_context);
  result:=public.claim_sales_team_provider_operation_v1(p.operation_id,scope,p_context,p.request);
  if result->>'status'<>'dispatch' then raise exception 'RECOVERY_EXECUTION_ADMISSION_CHANGED';end if;
 else
  perform creatornet_team_private.financial_shape_v1(p_payload,case when p_phase='bind' then '{"operationId":"string","leaseToken":"string","providerId":"string","providerRequestId":"string","reconciled":"boolean"}'::jsonb else '{"operationId":"string","leaseToken":"string"}'::jsonb end);
  provider_token:=(p_payload->>'leaseToken')::uuid;select * into admission from public.sales_team_transfer_recovery_execution_admissions_v1 where request_id=p.id and worker_run_id=p_run_id and task_id=p_task_id and context=p_context;
  if admission.request_id is null or op.id is null or p_payload->>'operationId'<>p.operation_id::text or op.lease_token is distinct from provider_token or op.context is distinct from p_context or op.request is distinct from p.request or op.worker_run_id is distinct from p.original_worker_run_id then raise exception 'ORIGINAL_RECOVERY_DISPATCH_AUTHORITY_REQUIRED';end if;
  if p_phase='assert' then
   checked:=creatornet_team_private.transfer_recovery_execution_recheck_v1(p.id,p_run_id);if checked is null then raise exception 'FRESH_RECOVERY_EXECUTION_SOURCE_CASH_REQUIRED';end if;
   if checked->>'checkId'=admission.check_id::text or checked->>'readId'=admission.read_id::text then raise exception 'DISTINCT_POSTCLAIM_RECOVERY_RECHECK_REQUIRED';end if;
   if exists(select 1 from public.sales_team_transfer_recovery_execution_actions_v1 where request_id=p.id and phase='assert') then raise exception 'SINGLE_CURRENT_RECOVERY_ASSERTION_REQUIRED';end if;
   insert into public.sales_team_transfer_recovery_execution_actions_v1(request_id,task_id,worker_run_id,phase,provider_lease_token,check_id,read_id) values(p.id,p_task_id,p_run_id,'assert',provider_token,(checked->>'checkId')::uuid,(checked->>'readId')::uuid);
   result:=public.assert_sales_team_provider_dispatch_v1(p.operation_id,provider_token);
  else
   if not exists(select 1 from public.sales_team_transfer_recovery_execution_actions_v1 asserted join public.sales_team_transfer_recovery_execution_assertions_v1 consumed on consumed.action_id=asserted.id and consumed.request_id=asserted.request_id where asserted.request_id=p.id and asserted.worker_run_id=p_run_id and asserted.task_id=p_task_id and asserted.phase='assert' and asserted.provider_lease_token=provider_token and asserted.created_at>clock_timestamp()-interval '90 seconds') then raise exception 'ASSERTED_ORIGINAL_RECOVERY_DISPATCH_REQUIRED';end if;
   if p_phase='bind' and (p_payload->'reconciled' is distinct from 'false'::jsonb or p_payload->>'providerId'!~'^trr_[A-Za-z0-9]+$' or p_payload->>'providerRequestId'!~'^req_[A-Za-z0-9]+$') then raise exception 'INDEPENDENT_ORIGINAL_RECOVERY_EVENT_REQUIRED';end if;
   if op.provider_id is not null then
    if p_phase='bind' and (op.provider_id<>p_payload->>'providerId' or op.provider_request_id<>p_payload->>'providerRequestId') then raise exception 'ORIGINAL_RECOVERY_BINDING_CHANGED';end if;
    return public.sales_team_operation_json_v1(op.id);
   end if;
   insert into public.sales_team_transfer_recovery_execution_actions_v1(request_id,task_id,worker_run_id,phase,provider_lease_token,provider_id,provider_request_id) values(p.id,p_task_id,p_run_id,p_phase,provider_token,p_payload->>'providerId',p_payload->>'providerRequestId') on conflict(request_id,phase) do nothing;
   if p_phase='unknown' then perform public.mark_sales_team_provider_unknown_v1(p.operation_id,provider_token);result:=public.sales_team_operation_json_v1(p.operation_id);
   else result:=public.bind_sales_team_provider_operation_v1(p.operation_id,p_payload->>'providerId',p_payload->>'providerRequestId',false);end if;
  end if;
 end if;
 if p_phase not in ('unknown','bind') then perform creatornet_team_private.transfer_recovery_execution_worker_v1(p_run_id,p_lease_token,p_context,true);end if;return result;
end $$;
-- Guard the actual generic journal bodies, including their older aliases.
do $guards$ declare src text;needle text;lock_code text;begin
 src:=pg_get_functiondef('public.sales_team_operation_admitted_v1(jsonb,jsonb)'::regprocedure);needle:='select case when exists(select 1 from public.sales_team_transfer_reversal_runs_v1';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_EXECUTION_GENERIC_ADMISSION_DIFFERS';end if;
 execute replace(src,needle,'select case when p_scope->>''kind''=''reversal'' and public.sales_team_transfer_recovery_operation_admitted_v1(p_scope,p_context) then true when exists(select 1 from public.sales_team_transfer_reversal_runs_v1');
 src:=pg_get_functiondef('public.claim_sales_team_operation_before_refund_v1(uuid,jsonb,jsonb,jsonb)'::regprocedure);needle:='v_lock:=coalesce(';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_EXECUTION_GENERIC_CLAIM_DIFFERS';end if;
 execute replace(src,needle,'if exists(select 1 from public.sales_team_transfer_recovery_requests_v1 p where p.operation_id=p_operation_id or p_scope->>''kind''=''reversal'' and p.id::text=p_scope->>''scopeId'') then perform pg_advisory_xact_lock(hashtextextended(''creatornet-platform-cash-v1'',0));if not exists(select 1 from public.sales_team_transfer_recovery_requests_v1 p where p.operation_id=p_operation_id and p.context=p_context and p.request=p_request and public.sales_team_transfer_recovery_request_json_v1(p.id)->''scope''=p_scope) then raise exception ''ORIGINAL_RECOVERY_EXECUTION_REQUEST_REQUIRED'';end if;end if;'||needle);
 lock_code:='if exists(select 1 from public.sales_team_transfer_recovery_requests_v1 where operation_id=p_operation_id) then perform pg_advisory_xact_lock(hashtextextended(''creatornet-platform-cash-v1'',0));perform pg_advisory_xact_lock(hashtextextended(''sales-team-financial:''||(select q.creator_id::text from public.sales_team_transfer_recovery_requests_v1 p join public.sales_team_transfer_requests_v1 q on q.id=p.transfer_request_id where p.operation_id=p_operation_id),0));end if;';
 src:=pg_get_functiondef('public.assert_sales_team_dispatch_before_transfer_v1(uuid,uuid)'::regprocedure);needle:='select * into v_op from public.sales_team_provider_operations_v1 where id=p_operation_id for update;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_EXECUTION_GENERIC_ASSERT_DIFFERS';end if;
 execute replace(src,needle,lock_code||needle||'if exists(select 1 from public.sales_team_transfer_recovery_requests_v1 where operation_id=p_operation_id) then perform creatornet_team_private.consume_transfer_recovery_assertion_v1(p_operation_id,p_lease_token);end if;');
 src:=pg_get_functiondef('public.mark_sales_team_provider_unknown_v1(uuid,uuid)'::regprocedure);needle:='update public.sales_team_provider_operations_v1 set status=''unknown''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_EXECUTION_GENERIC_UNKNOWN_DIFFERS';end if;
 execute replace(src,needle,lock_code||'if exists(select 1 from public.sales_team_transfer_recovery_requests_v1 where operation_id=p_operation_id) and not creatornet_team_private.transfer_recovery_outcome_allowed_v1(p_operation_id,p_lease_token,''unknown'') then raise exception ''ASSERTED_ORIGINAL_RECOVERY_OUTCOME_REQUIRED'';end if;'||needle);
 src:=pg_get_functiondef('public.bind_sales_team_operation_before_transfer_proof_v1(uuid,text,text,boolean)'::regprocedure);needle:='select * into v_op from public.sales_team_provider_operations_v1 where id=p_operation_id for update;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'RECOVERY_EXECUTION_GENERIC_BIND_DIFFERS';end if;
 execute replace(src,needle,lock_code||needle||'if exists(select 1 from public.sales_team_transfer_recovery_requests_v1 where operation_id=p_operation_id) and (p_reconciled is distinct from false or not creatornet_team_private.transfer_recovery_outcome_allowed_v1(p_operation_id,v_op.lease_token,''bind'',p_provider_id,p_provider_request_id)) then raise exception ''INDEPENDENT_ORIGINAL_RECOVERY_EVENT_REQUIRED'';end if;');
end $guards$;
-- Explicit named source dependencies in each existing SQL catalog digest.
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''transfer_recovery_execution_allowed_v1'',''transfer_recovery_execution_worker_v1'',''run_transfer_recovery_execution_root_v1'',''transfer_recovery_execution_fresh_v1'',''transfer_recovery_execution_recheck_v1'',''consume_transfer_recovery_assertion_v1'',''transfer_recovery_outcome_allowed_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''claim_sales_team_transfer_recovery_execution_run_v1'',''sales_team_transfer_recovery_operation_admitted_v1'',''run_sales_team_transfer_recovery_execution_v1'',''claim_sales_team_operation_before_refund_v1'',''assert_sales_team_dispatch_before_transfer_v1'',''mark_sales_team_provider_unknown_v1'',''bind_sales_team_operation_before_transfer_proof_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'RECOVERY_EXECUTION_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_transfer_recovery_execution_runs_v1','sales_team_transfer_recovery_execution_reads_v1','sales_team_transfer_recovery_execution_roots_v1','sales_team_transfer_recovery_execution_rechecks_v1','sales_team_transfer_recovery_execution_admissions_v1','sales_team_transfer_recovery_execution_actions_v1','sales_team_transfer_recovery_execution_assertions_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_recovery_execution_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('claim_sales_team_transfer_recovery_execution_run_v1','sales_team_transfer_recovery_operation_admitted_v1','run_sales_team_transfer_recovery_execution_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('transfer_recovery_execution_allowed_v1','transfer_recovery_execution_worker_v1','transfer_recovery_execution_fresh_v1','transfer_recovery_execution_recheck_v1','consume_transfer_recovery_assertion_v1','transfer_recovery_outcome_allowed_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
 revoke all on function creatornet_team_private.run_transfer_recovery_execution_root_v1(uuid,uuid,jsonb,uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
end $grants$;
commit;
