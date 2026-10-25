-- Default-off original event/key recovery. No new provider POST or schedule.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column transfer_reversal_recovery_enabled boolean not null default false;
create table public.sales_team_transfer_reversal_recovery_proofs_v1 (
 operation_id uuid primary key references public.sales_team_provider_operations_v1(id) on delete restrict,
 request_id uuid not null unique references public.sales_team_transfer_recovery_requests_v1(id) on delete restrict,
 check_id uuid not null unique references public.sales_team_transfer_reversal_checks_v1(id) on delete restrict,
 reversal_id text not null unique check(reversal_id~'^trr_[A-Za-z0-9]+$'),original_request_id text not null unique check(original_request_id~'^req_[A-Za-z0-9]+$'),
 event_id text not null unique check(event_id~'^evt_[A-Za-z0-9]+$'),proof jsonb not null,created_at timestamptz not null default clock_timestamp(),
 foreign key(operation_id) references public.sales_team_transfer_reversal_completions_v1(operation_id) on delete restrict deferrable initially deferred
);
create function creatornet_team_private.reversal_recovery_worker_v1(p_run_id uuid,p_token uuid,p_context jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 perform creatornet_team_private.transfer_reversal_worker_v1(p_run_id,p_token,p_context);
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and transfer_reversal_recovery_enabled) then raise exception 'ORIGINAL_REVERSAL_RECOVERY_HELD';end if;
end $$;
create function creatornet_team_private.unknown_reversal_original_v1(p_operation_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare p public.sales_team_transfer_recovery_requests_v1;op public.sales_team_provider_operations_v1;q jsonb;expected jsonb;begin
 select * into p from public.sales_team_transfer_recovery_requests_v1 where operation_id=p_operation_id and context=p_context;
 select * into op from public.sales_team_provider_operations_v1 where id=p_operation_id and context=p_context;
 if p.id is null or op.id is null then raise exception 'ASSERTED_UNKNOWN_ORIGINAL_REVERSAL_REQUIRED';end if;
 q:=creatornet_team_private.transfer_recovery_original_v1(p.transfer_request_id,p_context);
 expected:=jsonb_build_object('apiVersion','2026-08-26.dahlia','method','POST','path','/v1/transfers/'||(q->'operation'->>'provider_id')||'/reversals','params',jsonb_build_object('amount',p.amount_cents,
  'metadata',jsonb_build_object('team_protocol','creatornet-team-recovery-v1','team_sale_id',q->>'sale_id','team_receipt_id',q->>'receipt_id','team_transfer_request_id',p.transfer_request_id,'team_recovery_request_id',p.id,'team_provider_operation_id',op.id,'team_beneficiary',q->>'beneficiary')));
 if p.operation_id<>creatornet_team_private.transfer_reversal_operation_id_v1(p.id) or p.request is distinct from expected or op.request is distinct from p.request or
  op.kind<>'reversal' or op.scope_id<>p.id or op.scope_key<>'recovery:v1' or op.sale_id::text is distinct from q->>'sale_id' or op.creator_id::text is distinct from q->>'creator_id' or op.actor_id is not null or
  op.worker_run_id is distinct from p.original_worker_run_id or op.idempotency_key<>'cn-team-v1:'||p.operation_id::text or op.provider_id is not null or op.provider_request_id is not null or
  op.first_dispatch_at is null or op.first_dispatch_at<(q->'operation'->>'first_dispatch_at')::timestamptz-interval '5 seconds' or op.first_dispatch_at>clock_timestamp()+interval '5 seconds' or
  op.status not in ('unknown','dispatching') or op.status='dispatching' and (op.lease_until is null or op.lease_until>clock_timestamp()) or
  exists(select 1 from public.sales_team_transfer_recovery_cancellations_v1 where request_id=p.id) or exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=op.id) or
  not exists(select 1 from public.sales_team_transfer_recovery_execution_admissions_v1 admission
   join public.sales_team_transfer_recovery_tasks_v1 task on task.id=admission.task_id and task.run_id=admission.worker_run_id and task.request_id=p.id and task.transfer_request_id=p.transfer_request_id
   join public.sales_team_transfer_recovery_execution_actions_v1 asserted on asserted.request_id=p.id and asserted.task_id=admission.task_id and asserted.worker_run_id=admission.worker_run_id and asserted.phase='assert' and asserted.provider_lease_token=op.lease_token
   join public.sales_team_transfer_recovery_execution_assertions_v1 consumed on consumed.request_id=p.id and consumed.action_id=asserted.id
   where admission.request_id=p.id and admission.operation_id=op.id and admission.context=p_context) then raise exception 'ASSERTED_UNKNOWN_ORIGINAL_REVERSAL_REQUIRED';end if;
 return jsonb_build_object('id',p.id,'amountCents',p.amount_cents,'originalWorkerRunId',p.original_worker_run_id,'transfer',q,'operation',public.sales_team_operation_json_v1(op.id));
end $$;
create function public.begin_sales_team_reversal_recovery_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_operation_id uuid,p_check_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c public.sales_team_transfer_reversal_checks_v1;original jsonb;q public.sales_team_transfer_requests_v1;revision integer;result jsonb;begin
 perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 if p_check_id is null or p_task_id is null then raise exception 'REVERSAL_CHECK_IDENTITIES_REQUIRED';end if;
 if exists(select 1 from public.sales_team_provider_operations_v1 where id=p_operation_id and context=p_context and provider_id is not null) then
  result:=public.begin_sales_team_reversal_check_v1(p_run_id,p_lease_token,p_context,p_task_id,p_operation_id,p_check_id);
  perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);return result;
 end if;
 original:=creatornet_team_private.unknown_reversal_original_v1(p_operation_id,p_context);
 select * into q from public.sales_team_transfer_requests_v1 where id=(original->'transfer'->>'id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 original:=creatornet_team_private.unknown_reversal_original_v1(p_operation_id,p_context);
 if exists(select 1 from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id and (run_id<>p_run_id or transfer_request_id<>q.id or request_id::text<>original->>'id')) then raise exception 'ORIGINAL_RECOVERY_TASK_CHANGED';end if;
 select observation_revision into revision from public.sales_team_receipts_v1 where id=q.receipt_id;
 select * into c from public.sales_team_transfer_reversal_checks_v1 where id=p_check_id;
 if c.id is not null and (c.worker_run_id<>p_run_id or c.task_id<>p_task_id or c.operation_id<>p_operation_id or c.context is distinct from p_context or c.transfer_request_id<>q.id) then raise exception 'ORIGINAL_REVERSAL_CHECK_CHANGED';end if;
 if c.id is null then
  if creatornet_team_private.transfer_recovery_task_count_v1(p_run_id)>=3 and not exists(select 1 from public.sales_team_transfer_recovery_tasks_v1 where id=p_task_id and run_id=p_run_id and transfer_request_id=q.id) then raise exception 'REVERSAL_TASK_LIMIT_REQUIRED';end if;
  insert into public.sales_team_transfer_reversal_checks_v1(id,task_id,worker_run_id,operation_id,transfer_request_id,context,receipt_revision) values(p_check_id,p_task_id,p_run_id,p_operation_id,q.id,p_context,revision);
 end if;
 perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 return jsonb_build_object('checkId',p_check_id,'completed',false,'held',true,'original',original);
end $$;
-- Only a checked recovery proof in the current transaction can authorize the
-- exact reconciled binding. Its deferred FK requires accounting before commit.
create function creatornet_team_private.reversal_recovery_binding_allowed_v1(p_operation_id uuid,p_provider_id text,p_provider_request_id text)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_transfer_reversal_recovery_proofs_v1 proof
 join public.sales_team_transfer_reversal_checks_v1 checked on checked.id=proof.check_id and checked.operation_id=proof.operation_id
 join public.sales_team_transfer_recovery_requests_v1 p on p.id=proof.request_id and p.operation_id=proof.operation_id and p.transfer_request_id=checked.transfer_request_id and p.context=checked.context
 join public.sales_team_provider_operations_v1 op on op.id=p.operation_id and op.context=p.context and op.request=p.request and op.worker_run_id=p.original_worker_run_id and op.scope_id=p.id
 join public.sales_team_settlement_runs_v1 run on run.run_id=checked.worker_run_id and run.context=p.context
 join public.sales_team_transfer_reversal_runs_v1 observed on observed.run_id=run.run_id
 join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id and worker.kind='settlement' and worker.status='running' and worker.lease_until>clock_timestamp()
 join public.sales_team_cash_policy_v1 policy on policy.singleton and policy.transfer_contract_sha256=run.contract_sha256 and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1()
 join public.sales_team_controls_v1 controls on controls.singleton and controls.transfer_reversal_observations_enabled and controls.transfer_reversal_recovery_enabled
 where proof.operation_id=p_operation_id and proof.reversal_id=p_provider_id and proof.original_request_id=p_provider_request_id and proof.created_at>clock_timestamp()-interval '25 seconds'
 and not exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=p_operation_id))
$$;
create function public.complete_sales_team_reversal_recovery_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_check_id uuid,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare c public.sales_team_transfer_reversal_checks_v1;p public.sales_team_transfer_recovery_requests_v1;q public.sales_team_transfer_requests_v1;op public.sales_team_provider_operations_v1;r public.sales_team_receipts_v1;
 original jsonb;recovery jsonb:=p_proof->'recovery';event_transfer jsonb:=recovery->'eventTransfer';event_reversal jsonb:=recovery->'eventReversal';root jsonb;result jsonb;req text;seen text[]:='{}';begin
 perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into c from public.sales_team_transfer_reversal_checks_v1 where id=p_check_id and worker_run_id=p_run_id and task_id=p_task_id and context=p_context;
 if c.id is null then raise exception 'CURRENT_ORIGINAL_REVERSAL_CHECK_REQUIRED';end if;
 select * into q from public.sales_team_transfer_requests_v1 where id=c.transfer_request_id and context=p_context;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 select * into op from public.sales_team_provider_operations_v1 where id=c.operation_id for update;
 if exists(select 1 from public.sales_team_transfer_reversal_completions_v1 where operation_id=op.id) then
  result:=public.complete_sales_team_reversal_check_v1(p_run_id,p_lease_token,p_context,p_task_id,p_check_id,p_proof-'recovery');
  perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);return result;
 end if;
 if op.provider_id is not null then
  if p_proof?'recovery' then raise exception 'ORIGINAL_RECOVERY_BINDING_CHANGED';end if;
  result:=public.complete_sales_team_reversal_check_v1(p_run_id,p_lease_token,p_context,p_task_id,p_check_id,p_proof);
  perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);return result;
 end if;
 original:=creatornet_team_private.unknown_reversal_original_v1(op.id,p_context);
 select * into p from public.sales_team_transfer_recovery_requests_v1 where operation_id=op.id;
 select * into r from public.sales_team_receipts_v1 where id=q.receipt_id for update;
 if r.observation_revision is distinct from c.receipt_revision then raise exception 'CURRENT_REVERSAL_RECEIPT_REQUIRED';end if;
 perform creatornet_team_private.financial_shape_v1(recovery,'{"eventId":"string","eventType":"string","eventCreated":"number","eventApiVersion":"string","livemode":"boolean","account":"null","eventReadRequestId":"string","eventRetrieveRequestId":"string","readStartedAt":"number","eventTransfer":"object","eventReversal":"object"}');
 perform creatornet_team_private.financial_shape_v1(event_transfer,'{"id":"string","amountCents":"number","amountReversedCents":"number","reversed":"boolean","currency":"string","destinationId":"string","sourceChargeId":"string","destinationPaymentId":"string","balanceId":"string","transferGroup":"string","sourceType":"string","created":"number","livemode":"boolean","metadata":"object"}');
 perform creatornet_team_private.financial_shape_v1(event_reversal,'{"id":"string","transferId":"string","amountCents":"number","currency":"string","balanceId":"string","created":"number","destinationPaymentRefundId":"string|null","sourceRefundId":"null","metadata":"object"}');
 if p_proof->>'operationId' is distinct from op.id::text or p_proof->>'requestId' is distinct from p.id::text or p_proof->>'idempotencyKey' is distinct from op.idempotency_key or p_proof->>'originalRequestId'!~'^req_[A-Za-z0-9]+$' or
  recovery->>'eventId'!~'^evt_[A-Za-z0-9]+$' or recovery->>'eventType'<>'transfer.reversed' or recovery->>'eventApiVersion'!~'^\d{4}-\d{2}-\d{2}(\.[a-z0-9_-]+)?$' or recovery->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
  (recovery->>'eventCreated')::numeric<>trunc((recovery->>'eventCreated')::numeric) or (recovery->>'eventCreated')::numeric not between extract(epoch from op.first_dispatch_at)-5 and extract(epoch from clock_timestamp())+5 or
  (recovery->>'readStartedAt')::numeric not between greatest(extract(epoch from c.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-45000) and (p_proof->>'readStartedAt')::numeric or
  (p_proof->>'readStartedAt')::numeric not between greatest(extract(epoch from c.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-25000) and extract(epoch from clock_timestamp())*1000 or
  jsonb_array_length(p_proof->'transferReadRequestIds')<>2 or jsonb_array_length(p_proof->'reversalReadRequestIds')<>2 or jsonb_array_length(p_proof->'balanceReadRequestIds')<>2 then raise exception 'ORIGINAL_REVERSAL_EVENT_REQUIRED';end if;
 seen:=array_append(seen,p_proof->>'originalRequestId');
 for req in select jsonb_array_elements_text((p_proof->'transferReadRequestIds')||(p_proof->'reversalReadRequestIds')||(p_proof->'balanceReadRequestIds')||jsonb_build_array(recovery->>'eventReadRequestId',recovery->>'eventRetrieveRequestId')) loop
  if req!~'^req_[A-Za-z0-9]+$' or req=any(seen) then raise exception 'DISTINCT_ORIGINAL_REVERSAL_EVENT_READS_REQUIRED';end if;seen:=array_append(seen,req);
 end loop;
 select proof->'transfer' into root from public.sales_team_transfer_completions_v1 where request_id=q.id;
 if event_transfer-'amountReversedCents'-'reversed' is distinct from root-'amountReversedCents'-'reversed' or
  (event_transfer->>'amountReversedCents')::bigint not between p.amount_cents and q.amount_cents or (event_transfer->>'amountReversedCents')::bigint>(p_proof->'transfer'->>'amountReversedCents')::bigint or
  event_transfer->'reversed' is distinct from to_jsonb((event_transfer->>'amountReversedCents')::bigint=q.amount_cents) or
  event_reversal-'balanceId'-'destinationPaymentRefundId' is distinct from (p_proof->'reversal')-'balanceId'-'destinationPaymentRefundId' or
  event_reversal->>'id'!~'^trr_[A-Za-z0-9]+$' or event_reversal->>'transferId' is distinct from root->>'id' or (event_reversal->>'amountCents')::bigint<>p.amount_cents or event_reversal->>'currency'<>'usd' or event_reversal->'metadata' is distinct from p.request->'params'->'metadata' or
  (event_reversal->>'created')::numeric not between greatest((root->>'created')::numeric,extract(epoch from op.first_dispatch_at)-5) and (recovery->>'eventCreated')::numeric+5 or
  event_reversal->>'balanceId'<>'' and (event_reversal->>'balanceId'!~'^txn_[A-Za-z0-9]+$' or event_reversal->>'balanceId' is distinct from p_proof->'reversal'->>'balanceId') or
  event_reversal->'destinationPaymentRefundId'<>'null'::jsonb and (event_reversal->>'destinationPaymentRefundId'!~'^pyr_[A-Za-z0-9]+$' or event_reversal->'destinationPaymentRefundId' is distinct from p_proof->'reversal'->'destinationPaymentRefundId') then raise exception 'EXACT_ORIGINAL_REVERSAL_EVENT_REQUIRED';end if;
 insert into public.sales_team_transfer_reversal_recovery_proofs_v1(operation_id,request_id,check_id,reversal_id,original_request_id,event_id,proof)
 values(op.id,p.id,c.id,event_reversal->>'id',p_proof->>'originalRequestId',recovery->>'eventId',p_proof);
 perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 perform public.bind_sales_team_provider_operation_v1(op.id,event_reversal->>'id',p_proof->>'originalRequestId',true);
 result:=public.complete_sales_team_reversal_check_v1(p_run_id,p_lease_token,p_context,p_task_id,p_check_id,p_proof-'recovery');
 perform creatornet_team_private.reversal_recovery_worker_v1(p_run_id,p_lease_token,p_context);
 return result||jsonb_build_object('recovered',true,'eventId',recovery->>'eventId');
end $$;
do $guard$ declare src text;needle text;begin
 src:=pg_get_functiondef('public.bind_sales_team_operation_before_transfer_proof_v1(uuid,text,text,boolean)'::regprocedure);
 needle:='and (p_reconciled is distinct from false or not creatornet_team_private.transfer_recovery_outcome_allowed_v1(p_operation_id,v_op.lease_token,''bind'',p_provider_id,p_provider_request_id)) then';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'REVERSAL_RECOVERY_BIND_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'and not (p_reconciled is true and creatornet_team_private.reversal_recovery_binding_allowed_v1(p_operation_id,p_provider_id,p_provider_request_id)) '||needle);
end $guard$;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''reversal_recovery_worker_v1'',''unknown_reversal_original_v1'',''reversal_recovery_binding_allowed_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''begin_sales_team_reversal_recovery_v1'',''complete_sales_team_reversal_recovery_v1''))';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'REVERSAL_RECOVERY_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
alter table public.sales_team_transfer_reversal_recovery_proofs_v1 enable row level security;
revoke all on public.sales_team_transfer_reversal_recovery_proofs_v1 from public,anon,authenticated,service_role;
grant select on public.sales_team_transfer_reversal_recovery_proofs_v1 to service_role;
create trigger immutable_reversal_recovery_history before update or delete on public.sales_team_transfer_reversal_recovery_proofs_v1 for each row execute function creatornet_team_private.reject_history_change();
do $grants$ declare sig regprocedure;begin
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('begin_sales_team_reversal_recovery_v1','complete_sales_team_reversal_recovery_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('reversal_recovery_worker_v1','unknown_reversal_original_v1','reversal_recovery_binding_allowed_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
