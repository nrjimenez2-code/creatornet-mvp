-- Local candidate: independently disabled, exact original surplus execution.
-- No scheduler, bank approval, provider setting or bank confirmation is installed.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
create function creatornet_team_private.unreceipted_team_cash_v1(p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare item record;obligation public.sales_team_payment_obligations_v1;agreement public.sales_team_sale_agreements_v1;
 attempt public.sales_team_payment_attempts_v1;original public.sales_team_provider_operations_v1;basis jsonb:='[]'::jsonb;operations jsonb;total numeric:=0;begin
 for item in select candidate.id from public.sales_team_payment_obligations_v1 candidate
 where not exists(select 1 from public.sales_team_receipts_v1 where obligation_id=candidate.id) and
 exists(select 1 from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_provider_operations_v1 operation on operation.id=confirmation.operation_id where confirmation.obligation_id=candidate.id)
 order by candidate.id loop
  select * into obligation from public.sales_team_payment_obligations_v1 where id=item.id;
  select * into agreement from public.sales_team_sale_agreements_v1 where id=obligation.sale_id;
  select * into attempt from public.sales_team_payment_attempts_v1 where obligation_id=obligation.id;
  select * into original from public.sales_team_provider_operations_v1 where id=attempt.intent_operation_id;
  if agreement.id is null or agreement.context is distinct from p_context or attempt.obligation_id is null or original.id is null or original.status<>'bound' or
   original.kind<>'intent' or original.scope_id is distinct from agreement.id or original.scope_key is distinct from 'intent:'||obligation.id::text or
   original.sale_id is distinct from agreement.id or original.creator_id is distinct from agreement.creator_id or original.actor_id is distinct from agreement.buyer_id or original.context is distinct from p_context or
   original.request is distinct from attempt.request or coalesce(original.provider_id,'')!~'^pi_[A-Za-z0-9]+$' or
   attempt.contract->'context' is distinct from p_context or attempt.contract->'terms' is distinct from agreement.terms or attempt.contract->>'fingerprint' is distinct from agreement.fingerprint or
   attempt.contract->>'saleId' is distinct from agreement.id::text or attempt.contract->>'obligationId' is distinct from obligation.id::text or
   (attempt.contract->>'amountCents')::numeric is distinct from obligation.amount_cents::numeric or (attempt.request->'params'->>'amount')::numeric is distinct from obligation.amount_cents::numeric or
   attempt.request->'params'->>'currency' is distinct from 'usd' or attempt.request->>'path' is distinct from '/v1/payment_intents' or attempt.request->>'method' is distinct from 'POST' or
   exists(select 1 from public.sales_team_payment_confirmations_v1 confirmation join public.sales_team_provider_operations_v1 operation on operation.id=confirmation.operation_id where confirmation.obligation_id=obligation.id and
    (operation.kind<>'confirmation' or operation.scope_id is distinct from agreement.id or operation.scope_key is distinct from 'confirm:'||confirmation.request_id::text or
     operation.sale_id is distinct from agreement.id or operation.creator_id is distinct from agreement.creator_id or operation.actor_id is distinct from agreement.buyer_id or operation.context is distinct from p_context or operation.request is distinct from confirmation.request or
     operation.request->>'path' is distinct from '/v1/payment_intents/'||original.provider_id||'/confirm' or operation.status='bound' and operation.provider_id is distinct from original.provider_id)) then raise exception 'UNRECEIPTED_TEAM_CASH_SOURCE_REQUIRED';end if;
  -- Reuse the existing independently proven unpaid closure. An unknown POST or
  -- missing receipt alone can never supply a zero-liability/unsent conclusion.
  if obligation.period_number=1 and exists(select 1 from public.sales_team_payment_closures_v1 where sale_id=agreement.id and buyer_id=agreement.buyer_id) or
   obligation.period_number>1 and creatornet_team_private.team_closed_collection_proof_v1(obligation.id,false) is not null then continue;end if;
  select jsonb_agg(to_jsonb(operation)-'lease_token'-'lease_until' order by operation.id) into operations from public.sales_team_payment_confirmations_v1 confirmation
   join public.sales_team_provider_operations_v1 operation on operation.id=confirmation.operation_id where confirmation.obligation_id=obligation.id;
  total:=total+obligation.amount_cents;
  if total>9007199254740991 then raise exception 'UNRECEIPTED_TEAM_CASH_RANGE_REQUIRED';end if;
  basis:=basis||jsonb_build_array(jsonb_build_array(obligation.id,obligation.amount_cents,original.id,operations));
 end loop;
 return jsonb_build_object('protectedCents',total::bigint,'sourceRevision',encode(sha256(convert_to(basis::text,'UTF8')),'hex'));
end $$;
alter function creatornet_team_private.cash_protection_v1(jsonb) rename to cash_protection_before_surplus_execution_v1;
create function creatornet_team_private.cash_protection_v1(p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare protection jsonb;pending jsonb;total numeric;begin
 protection:=creatornet_team_private.cash_protection_before_surplus_execution_v1(p_context);
 pending:=creatornet_team_private.unreceipted_team_cash_v1(p_context);
 total:=(protection->>'teamCents')::numeric+(pending->>'protectedCents')::numeric;
 if total>9007199254740991 then raise exception 'COMPLETE_TEAM_CASH_RANGE_REQUIRED';end if;
 return protection||jsonb_build_object('teamCents',total::bigint,'unreceiptedCollections',pending);
end $$;
alter table public.sales_team_controls_v1 add column surplus_execution_enabled boolean not null default false;
create table public.sales_team_surplus_execution_checks_v1 (
 id uuid primary key,request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 run_id uuid not null references public.sales_team_surplus_runs_v1(run_id) on delete restrict,
 read_id uuid not null unique references public.sales_team_cash_observations_v1(read_id) on delete restrict,
 destination_proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_surplus_execution_admissions_v1 (
 request_id uuid primary key references public.sales_team_surplus_requests_v1(id) on delete restrict,
 operation_id uuid not null unique references public.sales_team_provider_operations_v1(id) on delete restrict deferrable initially deferred,
 run_id uuid not null references public.sales_team_surplus_runs_v1(run_id) on delete restrict,
 check_id uuid not null references public.sales_team_surplus_execution_checks_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_surplus_execution_actions_v1 (
 id bigint generated always as identity primary key,request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 run_id uuid not null references public.sales_team_surplus_runs_v1(run_id) on delete restrict,
 phase text not null check(phase in ('assert','dispatch','unknown','bind')),provider_lease_token uuid not null,
 check_id uuid references public.sales_team_surplus_execution_checks_v1(id) on delete restrict,
 provider_id text,provider_request_id text,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_surplus_checks_v1 (
 id uuid primary key,request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 context jsonb not null,provider_id text not null,original_request_id text not null,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_surplus_observations_v1 (
 check_id uuid primary key references public.sales_team_surplus_checks_v1(id) on delete restrict,
 request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_surplus_balance_entries_v1 (
 transaction_id text primary key check(transaction_id~'^txn_[A-Za-z0-9]+$'),
 request_id uuid not null references public.sales_team_surplus_requests_v1(id) on delete restrict,
 kind text not null check(kind in ('debit','return')),amount_cents bigint not null,fee_cents bigint not null,
 proof jsonb not null,created_at timestamptz not null default clock_timestamp(),unique(request_id,kind)
);
create function creatornet_team_private.surplus_execution_cash_v1(p_request_id uuid,p_run_id uuid)
returns uuid language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q public.sales_team_surplus_requests_v1;checked public.sales_team_surplus_execution_checks_v1;cash public.sales_team_cash_reads_v1;protection jsonb;free numeric;begin
 select * into q from public.sales_team_surplus_requests_v1 where id=p_request_id;
 if q.id is null or not creatornet_team_private.surplus_policy_ready_v1(q.context) or q.policy is distinct from creatornet_team_private.surplus_policy_snapshot_v1() or
  exists(select 1 from public.sales_team_surplus_resolutions_v1 where request_id=q.id) or
  exists(select 1 from public.sales_team_financial_alerts_v1 where code in ('SURPLUS_COST_RESERVE_EXCEEDED','SURPLUS_COST_CREDIT_REVIEW') and status<>'resolved') then return null;end if;
 select * into checked from public.sales_team_surplus_execution_checks_v1 where request_id=q.id and run_id=p_run_id order by created_at desc,id desc limit 1;
 select * into cash from public.sales_team_cash_reads_v1 where id=checked.read_id and surplus_worker_run_id=p_run_id and context=q.context;
 protection:=creatornet_team_private.cash_protection_v1(q.context);
 if checked.id is null or checked.created_at<clock_timestamp()-interval '25 seconds' or cash.id is null or cash.created_at<clock_timestamp()-interval '25 seconds' or
  cash.protection is distinct from protection then return null;end if;
 free:=creatornet_team_private.cash_available_floor_v1(q.context,protection->'epoch')-(protection->>'teamCents')::numeric-(protection->'shared'->>'protectedCents')::numeric-(protection->>'reserveCents')::numeric-creatornet_team_private.cash_encumbered_v1();
 if free is null or free<0 then return null;end if;
 return checked.id;
end $$;
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_before_surplus_execution_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select case when p_scope->>'kind'='withdrawal' then exists(
  select 1 from public.sales_team_surplus_execution_admissions_v1 admission
  join public.sales_team_surplus_requests_v1 q on q.id=admission.request_id
  join public.sales_team_surplus_tasks_v1 task on task.run_id=admission.run_id and task.request_id=q.id
  join public.sales_team_surplus_runs_v1 run on run.run_id=admission.run_id and run.context=p_context and run.allow_new
  join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id and worker.kind='surplus' and worker.status='running' and worker.lease_until>clock_timestamp()
  join public.sales_team_controls_v1 controls on controls.singleton and controls.surplus_execution_enabled
  where q.context=p_context and public.sales_team_surplus_request_json_v1(q.id)->'scope'=p_scope and run.contract_sha256=creatornet_team_private.surplus_contract_digest_v1()
   and creatornet_team_private.surplus_execution_cash_v1(q.id,run.run_id) is not null
 ) else public.sales_team_operation_before_surplus_execution_v1(p_scope,p_context) end
$$;
-- Serialize every withdrawal journal claim with all platform cash owners. The
-- generic journal still cannot manufacture a request/admission or change origin.
alter function public.claim_sales_team_provider_operation_v1(uuid,jsonb,jsonb,jsonb) rename to claim_sales_team_operation_before_surplus_v1;
create function public.claim_sales_team_provider_operation_v1(p_operation_id uuid,p_scope jsonb,p_context jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$begin
 if p_scope->>'kind'='withdrawal' then
  perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
  if not exists(select 1 from public.sales_team_surplus_requests_v1 where operation_id=p_operation_id and context=p_context and request=p_request and public.sales_team_surplus_request_json_v1(id)->'scope'=p_scope) then raise exception 'ORIGINAL_PROTECTED_SURPLUS_REQUIRED';end if;
 end if;
 return public.claim_sales_team_operation_before_surplus_v1(p_operation_id,p_scope,p_context,p_request);
end $$;
create function public.run_sales_team_surplus_execution_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_request_id uuid,p_phase text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare q public.sales_team_surplus_requests_v1;op public.sales_team_provider_operations_v1;admission public.sales_team_surplus_execution_admissions_v1;
 scope jsonb;checked uuid;token uuid;result jsonb;proof jsonb;cash public.sales_team_cash_reads_v1;req text;seen text[]:='{}';begin
 if p_phase is null or p_phase not in ('read','check','claim','assert','dispatch','unknown','bind','cancel') then raise exception 'SURPLUS_EXECUTION_PHASE_REQUIRED';end if;
 if p_phase in ('unknown','bind') then
  if not exists(select 1 from public.sales_team_surplus_runs_v1 where run_id=p_run_id and lease_token=p_lease_token and context=p_context) then raise exception 'ORIGINAL_SURPLUS_DISPATCH_WORKER_REQUIRED';end if;
 else perform creatornet_team_private.surplus_worker_v1(p_run_id,p_lease_token,p_context);end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select original.* into q from public.sales_team_surplus_tasks_v1 task join public.sales_team_surplus_requests_v1 original on original.id=task.request_id
 where task.run_id=p_run_id and original.id=p_request_id and original.context=p_context;
 if q.id is null then raise exception 'ORIGINAL_SURPLUS_EXECUTION_TASK_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.id::text,0));
 select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id for update;
 scope:=public.sales_team_surplus_request_json_v1(q.id)->'scope';
 if p_phase='read' then perform creatornet_team_private.financial_shape_v1(p_payload,'{}');return public.sales_team_surplus_request_json_v1(q.id);end if;
 if p_phase='cancel' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{}');
  if op.id is not null then raise exception 'ORIGINAL_SURPLUS_RECOVERY_REQUIRED';end if;
  insert into public.sales_team_surplus_resolutions_v1(request_id,disposition,proof) values(q.id,'unsent',jsonb_build_object('reason','journal_absent','runId',p_run_id)) on conflict(request_id) do nothing;
  if found then update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;end if;
  return public.sales_team_surplus_request_json_v1(q.id);
 end if;
 if p_phase='check' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{"checkId":"string","readId":"string","proof":"object"}');proof:=p_payload->'proof';
  perform creatornet_team_private.financial_shape_v1(proof,'{"platformAccountId":"string","destinationId":"string","country":"string","currency":"string","bankStatus":"string","bankHash":"string","manualPayouts":"boolean","payoutsEnabled":"boolean","automaticRulesAbsent":"boolean","context":"object","requestId":"string","policyRevision":"number","policyDigest":"string","accountRequestId":"string","settingsRequestId":"string","bankRequestId":"string","readStartedAt":"number","observedAt":"number"}');
  select * into cash from public.sales_team_cash_reads_v1 where id=(p_payload->>'readId')::uuid and surplus_worker_run_id=p_run_id and context=p_context;
  if cash.id is null or not exists(select 1 from public.sales_team_cash_observations_v1 where read_id=cash.id) or cash.created_at<clock_timestamp()-interval '25 seconds' or
   cash.protection is distinct from creatornet_team_private.cash_protection_v1(p_context) or proof->'context' is distinct from p_context or proof->>'requestId' is distinct from q.id::text or
   proof->>'platformAccountId' is distinct from p_context->>'platformAccountId' or proof->>'destinationId' is distinct from q.destination_id or proof->>'country'<>'US' or proof->>'currency'<>'usd' or
   proof->>'bankStatus' not in ('new','validated','verified') or proof->>'bankHash'!~'^[a-f0-9]{64}$' or proof->'manualPayouts'<>'true'::jsonb or proof->'payoutsEnabled'<>'true'::jsonb or proof->'automaticRulesAbsent'<>'true'::jsonb or
   proof->>'policyRevision' is distinct from q.policy->>'revision' or proof->>'policyDigest' is distinct from q.policy->>'contract_sha256' or
   (proof->>'readStartedAt')::numeric not between greatest(extract(epoch from cash.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-25000) and extract(epoch from clock_timestamp())*1000 or
   (proof->>'observedAt')::numeric not between floor((proof->>'readStartedAt')::numeric/1000) and extract(epoch from clock_timestamp())+5 then raise exception 'FRESH_SURPLUS_DESTINATION_REQUIRED';end if;
  foreach req in array array[proof->>'accountRequestId',proof->>'settingsRequestId',proof->>'bankRequestId'] loop
   if req!~'^req_[A-Za-z0-9]+$' or req=any(seen) or req in (select value from public.sales_team_cash_observations_v1 observation cross join lateral jsonb_each_text(observation.proof) where observation.read_id=cash.id and key in ('firstRequestId','secondRequestId')) then raise exception 'DISTINCT_SURPLUS_DESTINATION_READS_REQUIRED';end if;seen:=array_append(seen,req);
  end loop;
  insert into public.sales_team_surplus_execution_checks_v1(id,request_id,run_id,read_id,destination_proof) values((p_payload->>'checkId')::uuid,q.id,p_run_id,cash.id,proof);
  return public.sales_team_surplus_request_json_v1(q.id);
 end if;
 if p_phase='claim' then
  perform creatornet_team_private.financial_shape_v1(p_payload,'{"operationId":"string","scope":"object","request":"object"}');
  if p_payload->>'operationId' is distinct from q.operation_id::text or p_payload->'scope' is distinct from scope or p_payload->'request' is distinct from q.request then raise exception 'ORIGINAL_SURPLUS_EXECUTION_REQUEST_REQUIRED';end if;
  if op.id is null then
   if not exists(select 1 from public.sales_team_controls_v1 where singleton and surplus_execution_enabled) then return jsonb_build_object('status','not_enabled');end if;
   checked:=creatornet_team_private.surplus_execution_cash_v1(q.id,p_run_id);
   if checked is null or not exists(select 1 from public.sales_team_surplus_runs_v1 where run_id=p_run_id and allow_new) then raise exception 'CURRENT_SURPLUS_EXECUTION_CASH_REQUIRED';end if;
   insert into public.sales_team_surplus_execution_admissions_v1(request_id,operation_id,run_id,check_id) values(q.id,q.operation_id,p_run_id,checked);
  end if;
  result:=public.claim_sales_team_provider_operation_v1(q.operation_id,scope,p_context,q.request);
  if op.id is null and result->>'status'<>'dispatch' then raise exception 'SURPLUS_EXECUTION_ADMISSION_CHANGED';end if;return result;
 end if;
 perform creatornet_team_private.financial_shape_v1(p_payload,case when p_phase='bind' then '{"operationId":"string","leaseToken":"string","providerId":"string","providerRequestId":"string"}'::jsonb else '{"operationId":"string","leaseToken":"string"}'::jsonb end);
 token:=(p_payload->>'leaseToken')::uuid;
 select * into admission from public.sales_team_surplus_execution_admissions_v1 where request_id=q.id and run_id=p_run_id;
 if admission.request_id is null or op.id is null or p_payload->>'operationId' is distinct from q.operation_id::text or op.lease_token is distinct from token or op.context is distinct from p_context or op.request is distinct from q.request or op.worker_run_id is distinct from q.original_worker_run_id then raise exception 'ORIGINAL_SURPLUS_DISPATCH_AUTHORITY_REQUIRED';end if;
 if p_phase in ('assert','dispatch') then
  checked:=creatornet_team_private.surplus_execution_cash_v1(q.id,p_run_id);
  if checked is null or checked=admission.check_id or not exists(select 1 from public.sales_team_surplus_execution_checks_v1 where id=checked and created_at>=op.first_dispatch_at and (destination_proof->>'readStartedAt')::numeric>=extract(epoch from op.first_dispatch_at)*1000-5) or
   (p_phase='assert' and exists(select 1 from public.sales_team_surplus_execution_actions_v1 where request_id=q.id and phase='assert')) or
   (p_phase='dispatch' and (not exists(select 1 from public.sales_team_surplus_execution_actions_v1 where request_id=q.id and run_id=p_run_id and phase='assert' and provider_lease_token=token) or exists(select 1 from public.sales_team_surplus_execution_actions_v1 where request_id=q.id and phase='dispatch'))) then raise exception 'POST_CLAIM_SURPLUS_RECHECK_REQUIRED';end if;
  result:=public.assert_sales_team_provider_dispatch_v1(q.operation_id,token);
 else
  if not exists(select 1 from public.sales_team_surplus_execution_actions_v1 where request_id=q.id and run_id=p_run_id and phase='assert' and provider_lease_token=token and created_at>clock_timestamp()-interval '90 seconds') then raise exception 'ASSERTED_ORIGINAL_SURPLUS_REQUIRED';end if;
  if p_phase='unknown' then perform public.mark_sales_team_provider_unknown_v1(q.operation_id,token);result:=public.sales_team_operation_json_v1(q.operation_id);
  else
   if not exists(select 1 from public.sales_team_surplus_execution_actions_v1 where request_id=q.id and run_id=p_run_id and phase='dispatch' and provider_lease_token=token) then raise exception 'DISPATCHED_ORIGINAL_SURPLUS_REQUIRED';end if;
   if p_payload->>'providerId'!~'^po_[A-Za-z0-9]+$' or p_payload->>'providerRequestId'!~'^req_[A-Za-z0-9]+$' then raise exception 'ORIGINAL_SURPLUS_PAYOUT_REQUIRED';end if;
   insert into public.sales_team_surplus_execution_actions_v1(request_id,run_id,phase,provider_lease_token,provider_id,provider_request_id) values(q.id,p_run_id,'bind',token,p_payload->>'providerId',p_payload->>'providerRequestId');
   return public.bind_sales_team_provider_operation_v1(q.operation_id,p_payload->>'providerId',p_payload->>'providerRequestId',op.status<>'dispatching' or op.lease_until<=clock_timestamp());
  end if;
 end if;
 insert into public.sales_team_surplus_execution_actions_v1(request_id,run_id,phase,provider_lease_token,check_id) values(q.id,p_run_id,p_phase,token,checked);return result;
end $$;
alter function public.bind_sales_team_provider_operation_v1(uuid,text,text,boolean) rename to bind_sales_team_operation_before_surplus_v1;
create function public.bind_sales_team_provider_operation_v1(p_operation_id uuid,p_provider_id text,p_provider_request_id text,p_reconciled boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$begin
 if exists(select 1 from public.sales_team_provider_operations_v1 where id=p_operation_id and kind='withdrawal') and not exists(
  select 1 from public.sales_team_surplus_execution_admissions_v1 admission join public.sales_team_surplus_execution_actions_v1 action using(request_id,run_id)
  join public.sales_team_provider_operations_v1 operation on operation.id=admission.operation_id and operation.lease_token=action.provider_lease_token
  where operation.id=p_operation_id and action.phase='bind' and action.provider_id=p_provider_id and action.provider_request_id=p_provider_request_id and action.created_at>clock_timestamp()-interval '90 seconds'
 ) then raise exception 'ORIGINAL_SURPLUS_OUTCOME_PROOF_REQUIRED';end if;
 return public.bind_sales_team_operation_before_surplus_v1(p_operation_id,p_provider_id,p_provider_request_id,p_reconciled);
end $$;
-- Cover the owning table as well as named journal wrappers, including old
-- wrappers still needed by earlier domains. None can forge withdrawal authority.
create function creatornet_team_private.guard_team_surplus_journal_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_surplus_requests_v1;scope jsonb;begin
 if new.kind<>'withdrawal' and (tg_op='INSERT' or old.kind<>'withdrawal') then return new;end if;
 select * into q from public.sales_team_surplus_requests_v1 where operation_id=new.id;
 scope:=public.sales_team_surplus_request_json_v1(q.id)->'scope';
 if q.id is null or new.kind<>'withdrawal' or new.scope_id is distinct from q.id or new.scope_key is distinct from 'surplus:v1' or
  new.sale_id is not null or new.creator_id is not null or new.actor_id is not null or new.worker_run_id is distinct from q.original_worker_run_id or new.context is distinct from q.context or
  new.request is distinct from q.request or new.idempotency_key is distinct from 'cn-team-v1:'||q.operation_id::text then raise exception 'EXACT_SURPLUS_JOURNAL_REQUIRED';end if;
 if tg_op='INSERT' then
  if new.status<>'dispatching' or new.provider_id is not null or new.provider_request_id is not null or new.lease_token is null or
   new.first_dispatch_at not between q.created_at and clock_timestamp()+interval '5 seconds' or not public.sales_team_operation_admitted_v1(scope,q.context) then raise exception 'ADMITTED_SURPLUS_JOURNAL_REQUIRED';end if;
 else
  if new.id is distinct from old.id or new.first_dispatch_at is distinct from old.first_dispatch_at or new.created_at is distinct from old.created_at or new.lease_token is distinct from old.lease_token or
   old.provider_id is not null and (new.provider_id is distinct from old.provider_id or new.provider_request_id is distinct from old.provider_request_id or new.status<>'bound') then raise exception 'ORIGINAL_SURPLUS_JOURNAL_IMMUTABLE';end if;
 end if;
 if new.provider_id is not null or new.status='bound' then
  if new.status<>'bound' or coalesce(new.provider_id,'')!~'^po_[A-Za-z0-9]+$' or coalesce(new.provider_request_id,'')!~'^req_[A-Za-z0-9]+$' or not exists(
   select 1 from public.sales_team_surplus_execution_admissions_v1 admission join public.sales_team_surplus_execution_actions_v1 action using(request_id,run_id)
   where admission.operation_id=new.id and action.phase='bind' and action.provider_lease_token=new.lease_token and action.provider_id=new.provider_id and action.provider_request_id=new.provider_request_id
  ) then raise exception 'ORIGINAL_SURPLUS_OUTCOME_PROOF_REQUIRED';end if;
 end if;
 return new;
end $$;
create trigger guarded_surplus_journal_v1 before insert or update on public.sales_team_provider_operations_v1 for each row execute function creatornet_team_private.guard_team_surplus_journal_v1();
-- Original money observation remains available with new-money controls off.
-- Only a bound original may enter here; unknown creation requires the separate
-- original-event recovery owner, never caller-supplied metadata adoption.
create function public.begin_sales_team_surplus_check_v1(p_check_id uuid,p_request_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare q public.sales_team_surplus_requests_v1;op public.sales_team_provider_operations_v1;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into q from public.sales_team_surplus_requests_v1 where id=p_request_id and context=p_context;
 select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id;
 if p_check_id is null or q.id is null or op.status is distinct from 'bound' or coalesce(op.provider_id,'')!~'^po_[A-Za-z0-9]+$' or
  coalesce(op.provider_request_id,'')!~'^req_[A-Za-z0-9]+$' or op.request is distinct from q.request or op.context is distinct from p_context or
  op.worker_run_id is distinct from q.original_worker_run_id or op.scope_id is distinct from q.id or op.scope_key is distinct from 'surplus:v1' or op.kind is distinct from 'withdrawal' or
  op.sale_id is not null or op.creator_id is not null or op.actor_id is not null or op.idempotency_key is distinct from 'cn-team-v1:'||q.operation_id::text or op.first_dispatch_at is null then raise exception 'BOUND_ORIGINAL_SURPLUS_REQUIRED';end if;
 insert into public.sales_team_surplus_checks_v1(id,request_id,context,provider_id,original_request_id) values(p_check_id,q.id,p_context,op.provider_id,op.provider_request_id);
 return public.sales_team_surplus_request_json_v1(q.id);
end $$;
create function public.complete_sales_team_surplus_check_v1(p_check_id uuid,p_request_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare q public.sales_team_surplus_requests_v1;op public.sales_team_provider_operations_v1;checked public.sales_team_surplus_checks_v1;
 payout jsonb:=p_proof->'payout';debit jsonb:=p_proof->'debit';returned jsonb:=p_proof->'returned';balance jsonb;fee jsonb;old public.sales_team_surplus_balance_entries_v1;
 req text;seen text[]:='{}';fee_sum numeric;cost numeric;return_required boolean;complete boolean;leg text;inserted boolean:=false;rows_added integer;begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into checked from public.sales_team_surplus_checks_v1 where id=p_check_id and request_id=p_request_id and context=p_context;
 select * into q from public.sales_team_surplus_requests_v1 where id=checked.request_id and context=p_context;
 select * into op from public.sales_team_provider_operations_v1 where id=q.operation_id for update;
 if checked.id is null or op.status is distinct from 'bound' or op.provider_id is distinct from checked.provider_id or op.provider_request_id is distinct from checked.original_request_id or op.request is distinct from q.request or op.context is distinct from p_context then raise exception 'ORIGINAL_SURPLUS_CHECK_REQUIRED';end if;
 if exists(select 1 from public.sales_team_surplus_observations_v1 where check_id=checked.id) then
  if not exists(select 1 from public.sales_team_surplus_observations_v1 where check_id=checked.id and proof=p_proof) then raise exception 'ORIGINAL_SURPLUS_OBSERVATION_CHANGED';end if;
  return jsonb_build_object('requestId',q.id,'recorded',false,'bankConfirmed',false);
 end if;
 perform creatornet_team_private.financial_shape_v1(p_proof-'returned'-'disposition','{"payout":"object","debit":"object","costCents":"number","complete":"boolean","costReserveExceeded":"boolean","costCreditNeedsReview":"boolean","bankConfirmed":"boolean","context":"object","requestId":"string","operationId":"string","firstPayoutRequestId":"string","secondPayoutRequestId":"string","readStartedAt":"number","observedAt":"number"}');
 perform creatornet_team_private.financial_shape_v1(payout-'returnBalanceId'-'failureCode'-'traceReferenceHash','{"id":"string","status":"string","created":"number","arrivalDate":"number","amountCents":"number","currency":"string","destinationId":"string","automatic":"boolean","method":"string","sourceType":"string","livemode":"boolean","metadata":"object","debitBalanceId":"string","providerRequestId":"string"}');
 if not p_proof?'returned' or not p_proof?'disposition' or not payout?'returnBalanceId' or not payout?'failureCode' or not payout?'traceReferenceHash' or
  p_proof->'context' is distinct from p_context or p_proof->>'requestId' is distinct from q.id::text or p_proof->>'operationId' is distinct from q.operation_id::text or p_proof->'bankConfirmed' is distinct from 'false'::jsonb or
  (p_proof->>'readStartedAt')::numeric not between greatest(extract(epoch from checked.created_at)*1000-5,extract(epoch from clock_timestamp())*1000-45000) and extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'observedAt')::numeric not between floor((p_proof->>'readStartedAt')::numeric/1000) and extract(epoch from clock_timestamp())+5 or
  payout->>'id' is distinct from op.provider_id or payout->>'amountCents' is distinct from q.amount_cents::text or payout->>'destinationId' is distinct from q.destination_id or payout->>'currency'<>'usd' or
  payout->'automatic'<>'false'::jsonb or payout->>'method'<>'standard' or payout->>'sourceType'<>'card' or payout->'metadata' is distinct from q.request->'params'->'metadata' or
  payout->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or payout->>'status' not in ('pending','in_transit','paid','failed','canceled') or
  (payout->>'created')::numeric not between extract(epoch from op.first_dispatch_at)-5 and extract(epoch from clock_timestamp())+5 or
  (payout->>'arrivalDate')::numeric<1 or coalesce(payout->>'debitBalanceId','')!~'^txn_[A-Za-z0-9]+$' or
  (payout->'failureCode'<>'null'::jsonb and coalesce(payout->>'failureCode','')!~'^[a-z_]{1,100}$') or
  (payout->'traceReferenceHash'<>'null'::jsonb and coalesce(payout->>'traceReferenceHash','')!~'^[a-f0-9]{64}$') then raise exception 'FRESH_EXACT_SURPLUS_PAYOUT_REQUIRED';end if;
 return_required:=payout->>'status' in ('failed','canceled');
 if (returned='null'::jsonb) is distinct from (payout->'returnBalanceId'='null'::jsonb) or
  returned<>'null'::jsonb and (not return_required or coalesce(payout->>'returnBalanceId','')!~'^txn_[A-Za-z0-9]+$' or payout->>'returnBalanceId'=payout->>'debitBalanceId') or
  exists(select 1 from public.sales_team_surplus_balance_entries_v1 where request_id=q.id and kind='return') and returned='null'::jsonb then raise exception 'ORIGINAL_SURPLUS_RETURN_REQUIRED';end if;
 foreach req in array array[p_proof->>'firstPayoutRequestId',p_proof->>'secondPayoutRequestId'] loop
  if req!~'^req_[A-Za-z0-9]+$' or req=any(seen) or req=op.provider_request_id then raise exception 'DISTINCT_SURPLUS_READS_REQUIRED';end if;seen:=array_append(seen,req);
 end loop;
 if payout->>'providerRequestId' is distinct from p_proof->>'secondPayoutRequestId' then raise exception 'BRACKETED_ORIGINAL_SURPLUS_REQUIRED';end if;
 cost:=0;complete:=true;
 foreach leg in array array['debit','return'] loop
  balance:=case when leg='debit' then debit else returned end;if balance='null'::jsonb then continue;end if;
  perform creatornet_team_private.financial_shape_v1(balance,'{"id":"string","sourceId":"string","kind":"string","amountCents":"number","feeCents":"number","netCents":"number","currency":"string","balanceType":"string","type":"string","reportingCategory":"string","exchangeRate":"null","created":"number","availableOn":"number","status":"string","providerRequestId":"string","feeDetails":"array"}');
  req:=balance->>'providerRequestId';
  if req!~'^req_[A-Za-z0-9]+$' or req=any(seen) or req=op.provider_request_id then raise exception 'DISTINCT_SURPLUS_READS_REQUIRED';end if;seen:=array_append(seen,req);
  if balance->>'id' is distinct from (case when leg='debit' then payout->>'debitBalanceId' else payout->>'returnBalanceId' end) or balance->>'kind' is distinct from leg or balance->>'sourceId' is distinct from op.provider_id or balance->>'currency'<>'usd' or balance->>'balanceType'<>'payments' or
   balance->>'type' is distinct from (case when leg='debit' then 'payout' when payout->>'status'='failed' then 'payout_failure' when payout->>'status'='canceled' then 'payout_cancel' else 'invalid' end) or balance->>'reportingCategory' is distinct from (case when leg='debit' then 'payout' else 'payout_reversal' end) or
   (balance->>'amountCents')::numeric is distinct from (case when leg='debit' then -q.amount_cents else q.amount_cents end)::numeric or
   leg='debit' and (balance->>'feeCents')::numeric<0 or abs((balance->>'feeCents')::numeric)>99999999 or
   (balance->>'netCents')::numeric is distinct from (balance->>'amountCents')::numeric-(balance->>'feeCents')::numeric or balance->>'status' not in ('pending','available') or
   (balance->>'created')::numeric not between (payout->>'created')::numeric-5 and extract(epoch from clock_timestamp())+5 or (balance->>'availableOn')::numeric<1 or jsonb_array_length(balance->'feeDetails')>32 then raise exception 'EXACT_SURPLUS_BALANCE_REQUIRED';end if;
  fee_sum:=0;for fee in select value from jsonb_array_elements(balance->'feeDetails') loop
   perform creatornet_team_private.financial_shape_v1(fee,'{"amount":"number","currency":"string","application":"null","type":"string"}');
   if abs((fee->>'amount')::numeric)>99999999 or fee->>'currency'<>'usd' or fee->>'type' not in ('stripe_fee','tax','payment_method_passthrough_fee') then raise exception 'ACTUAL_SURPLUS_FEES_REQUIRED';end if;fee_sum:=fee_sum+(fee->>'amount')::numeric;
  end loop;
  if fee_sum is distinct from (balance->>'feeCents')::numeric then raise exception 'ACTUAL_SURPLUS_FEES_REQUIRED';end if;
  cost:=cost+fee_sum;
  if balance->>'status'<>'available' or (balance->>'availableOn')::numeric>extract(epoch from clock_timestamp()) then complete:=false;end if;
 end loop;
 complete:=complete and (not return_required or returned<>'null'::jsonb) and cost>=0;
 if p_proof->'complete' is distinct from to_jsonb(complete) or (p_proof->>'costCents')::numeric is distinct from cost or p_proof->'costReserveExceeded' is distinct from to_jsonb(cost>q.cost_reserve_cents) or p_proof->'costCreditNeedsReview' is distinct from to_jsonb(cost<0) or
  p_proof->'disposition' is distinct from (case when complete then to_jsonb(case when return_required then 'returned'::text else 'debit_observed'::text end) else 'null'::jsonb end) then raise exception 'DERIVED_SURPLUS_DISPOSITION_REQUIRED';end if;
 insert into public.sales_team_surplus_observations_v1(check_id,request_id,proof) values(checked.id,q.id,p_proof);
 -- Each available monetary leg is append-only. A late return never rewrites a
 -- recorded debit, and every newly recognized leg invalidates older cash reads.
 foreach leg in array array['debit','return'] loop
  balance:=case when leg='debit' then debit else returned end;
  if balance='null'::jsonb or balance->>'status'<>'available' or (balance->>'availableOn')::numeric>extract(epoch from clock_timestamp()) then continue;end if;
  select * into old from public.sales_team_surplus_balance_entries_v1 where transaction_id=balance->>'id' or request_id=q.id and kind=leg;
  if old.transaction_id is not null then
   if old.request_id<>q.id or old.kind<>leg or old.transaction_id<>balance->>'id' or old.proof-'providerRequestId' is distinct from balance-'providerRequestId' then raise exception 'ORIGINAL_SURPLUS_BALANCE_CHANGED';end if;
  else
   if exists(select 1 from public.sales_team_financial_balance_entries_v1 where transaction_id=balance->>'id') then raise exception 'SURPLUS_BALANCE_ALREADY_OWNED';end if;
   insert into public.sales_team_surplus_balance_entries_v1(transaction_id,request_id,kind,amount_cents,fee_cents,proof) values(balance->>'id',q.id,leg,(balance->>'amountCents')::bigint,(balance->>'feeCents')::bigint,balance);inserted:=true;
  end if;
 end loop;
 if complete then
  insert into public.sales_team_surplus_resolutions_v1(request_id,disposition,proof) values(q.id,case when return_required then 'returned' else 'debit_observed' end,p_proof) on conflict(request_id) do nothing;
  get diagnostics rows_added=row_count;inserted:=inserted or rows_added>0;
 end if;
 if inserted then update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;end if;
 if cost>q.cost_reserve_cents or cost<0 then
  insert into public.sales_team_financial_alerts_v1(operation_id,code,source_identity,evidence) values(q.operation_id,case when cost<0 then 'SURPLUS_COST_CREDIT_REVIEW' else 'SURPLUS_COST_RESERVE_EXCEEDED' end,'surplus-cost:'||checked.id::text,jsonb_build_object('requestId',q.id,'costCents',cost,'reservedCostCents',q.cost_reserve_cents)) on conflict(source_identity) do nothing;
 end if;
 return jsonb_build_object('requestId',q.id,'recorded',true,'complete',complete,'disposition',p_proof->'disposition','bankConfirmed',false,'held',cost>q.cost_reserve_cents or cost<0);
end $$;
do $digests$ declare signature text;body text;extra text;begin
 extra:=' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname in (''unreceipted_team_cash_v1'',''cash_protection_before_surplus_execution_v1'',''surplus_execution_cash_v1'')) or (p.pronamespace=''public''::regnamespace and p.proname in (''sales_team_operation_before_surplus_execution_v1'',''claim_sales_team_operation_before_surplus_v1'',''claim_sales_team_provider_operation_v1'',''run_sales_team_surplus_execution_v1'',''bind_sales_team_operation_before_surplus_v1'',''bind_sales_team_provider_operation_v1''))';
 extra:=extra||' or (p.pronamespace=''public''::regnamespace and p.proname in (''begin_sales_team_surplus_check_v1'',''complete_sales_team_surplus_check_v1''))';
 extra:=extra||' or (p.pronamespace=''creatornet_team_private''::regnamespace and p.proname=''guard_team_surplus_journal_v1'')';
 foreach signature in array array['creatornet_team_private.transfer_contract_digest_v1()','creatornet_team_private.shared_cash_contract_digest_v1()','creatornet_team_private.retained_cash_contract_digest_v1()','creatornet_team_private.recovery_contract_digest_v1()','creatornet_team_private.surplus_contract_digest_v1()'] loop
  select prosrc into body from pg_proc where oid=signature::regprocedure and prolang=(select oid from pg_language where lanname='sql');
  if body is null or (select count(*) from regexp_matches(body,'from[[:space:]]+pg_proc[[:space:]]+p[[:space:]]+where','g'))<>1 then raise exception 'SURPLUS_EXECUTION_NAMED_DIGEST_DIFFERS: %',signature;end if;
  body:=regexp_replace(rtrim(body),';$','');execute format('create or replace function %s returns text language sql stable security invoker set search_path=pg_catalog as %L',signature,body||extra);
 end loop;
end $digests$;
revoke all on function creatornet_team_private.unreceipted_team_cash_v1(jsonb) from public,anon,authenticated;
revoke all on function creatornet_team_private.cash_protection_v1(jsonb) from public,anon,authenticated;
revoke all on function creatornet_team_private.cash_protection_before_surplus_execution_v1(jsonb) from public,anon,authenticated;
grant execute on function creatornet_team_private.unreceipted_team_cash_v1(jsonb) to service_role;
grant execute on function creatornet_team_private.cash_protection_v1(jsonb) to service_role;
grant execute on function creatornet_team_private.cash_protection_before_surplus_execution_v1(jsonb) to service_role;
do $security$ declare name text;signature regprocedure;begin
 foreach name in array array['sales_team_surplus_execution_checks_v1','sales_team_surplus_execution_admissions_v1','sales_team_surplus_execution_actions_v1','sales_team_surplus_checks_v1','sales_team_surplus_observations_v1','sales_team_surplus_balance_entries_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated,service_role',name);execute format('grant select on public.%I to service_role',name);
  execute format('create trigger immutable_surplus_execution_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for signature in select oid::regprocedure from pg_proc where
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('surplus_execution_cash_v1','guard_team_surplus_journal_v1')) or
  (pronamespace='public'::regnamespace and proname in ('sales_team_operation_before_surplus_execution_v1','sales_team_operation_admitted_v1','claim_sales_team_operation_before_surplus_v1','claim_sales_team_provider_operation_v1','run_sales_team_surplus_execution_v1','bind_sales_team_operation_before_surplus_v1','bind_sales_team_provider_operation_v1','begin_sales_team_surplus_check_v1','complete_sales_team_surplus_check_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',signature);execute format('grant execute on function %s to service_role',signature);
 end loop;
end $security$;
commit;
