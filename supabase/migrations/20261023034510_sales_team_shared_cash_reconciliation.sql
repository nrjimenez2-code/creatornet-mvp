-- Local candidate: original-only GET evidence can retire a shared cash
-- commitment. This does not dispatch/refund/reverse/pay out money or alter
-- legacy earnings/entitlements. All automatic inspection starts default off.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column shared_cash_reconciliation_enabled boolean not null default false;
alter table public.sales_team_cash_policy_v1 add column shared_contract_sha256 text check(shared_contract_sha256~'^[a-f0-9]{64}$');
create table public.sales_team_shared_cash_checks_v1 (
 id uuid primary key,source_kind text not null,source_id text not null,context jsonb not null,source jsonb not null,
 contract_sha256 text not null check(contract_sha256~'^[a-f0-9]{64}$'),
 commitment_version bigint not null references public.sales_team_shared_cash_commitments_v1(version) on delete restrict,
 actor_id uuid references public.profiles(id) on delete restrict,worker_run_id uuid references public.sales_team_worker_runs_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),check(num_nonnulls(actor_id,worker_run_id)=1)
);
create table public.sales_team_shared_cash_check_results_v1 (
 check_id uuid primary key references public.sales_team_shared_cash_checks_v1(id) on delete restrict,
 complete boolean not null,proof jsonb not null,observed_by uuid references public.profiles(id) on delete restrict,
 worker_run_id uuid references public.sales_team_worker_runs_v1(id) on delete restrict,created_at timestamptz not null default clock_timestamp(),
 check(num_nonnulls(observed_by,worker_run_id)=1)
);
create table public.sales_team_shared_cash_balance_entries_v1 (
 transaction_id text primary key check(transaction_id~'^txn_[A-Za-z0-9]+$'),source_kind text not null,source_id text not null,
 check_id uuid not null references public.sales_team_shared_cash_check_results_v1(check_id) on delete restrict deferrable initially deferred,
 identity jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_shared_cash_resolutions_v1 (
 source_kind text not null,source_id text not null,commitment_version bigint not null references public.sales_team_shared_cash_commitments_v1(version) on delete restrict,
 context jsonb not null,check_id uuid not null unique references public.sales_team_shared_cash_check_results_v1(check_id) on delete restrict deferrable initially deferred,
 source_fingerprint text not null check(source_fingerprint~'^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp(),primary key(source_kind,source_id,commitment_version,source_fingerprint,context)
);
create index sales_team_shared_check_source_v1 on public.sales_team_shared_cash_checks_v1(source_kind,source_id,created_at,id);
create function creatornet_team_private.shared_cash_reader_authorized_v1(p_actor_id uuid,p_worker_run_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select num_nonnulls(p_actor_id,p_worker_run_id)=1 and (exists(select 1 from public.profiles where id=p_actor_id and role='admin') or
  exists(select 1 from public.sales_team_worker_runs_v1 where id=p_worker_run_id and kind='reconciliation' and status='running' and lease_until>clock_timestamp()))
$$;
create function creatornet_team_private.shared_cash_original_v1(p_kind text,p_id text,p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q public.refund_operations;t public.tip_dispute_recoveries;v_source jsonb;v_payload jsonb;v_version bigint;begin
 if not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'ORIGINAL_SHARED_CASH_CONTEXT_REQUIRED';end if;
 v_source:=creatornet_team_private.shared_cash_source_v1(p_kind,p_id);
 select max(version) into v_version from public.sales_team_shared_cash_commitments_v1 where source_kind=p_kind and source_id=p_id;
 if v_version is null or exists(select 1 from public.sales_team_shared_cash_commitments_v1 saved where saved.source_kind=p_kind and saved.source_id=p_id and saved.source is distinct from v_source) then raise exception 'ORIGINAL_SHARED_CASH_SOURCE_CHANGED';end if;
 if p_kind='legacy_refund' then
  select * into q from public.refund_operations where id::text=p_id;
  v_payload:=jsonb_build_object('kind',p_kind,'id',p_id,'creatorId',q.creator_id,'context',p_context,'createdAt',floor(extract(epoch from q.created_at))::bigint,
   'closed',q.status in ('completed','failed') and q.processing_token is null,'chargeId',q.stripe_charge_id,'paymentIntentId',q.stripe_payment_intent_id,
   'grossCents',q.gross_amount_cents,'refundCents',q.customer_refund_amount_cents,'refundId',q.stripe_refund_id,'applicationFeeId',q.stripe_application_fee_id,
   'feeRefundId',q.stripe_application_fee_refund_id,'feeRefundCents',q.application_fee_refund_amount_cents,'actualFeeRefundCents',q.stripe_application_fee_refund_amount_cents,'responsibility',q.responsibility,'reasonCode',q.reason_code);
 else
  select * into t from public.tip_dispute_recoveries where stripe_dispute_id=p_id;
  v_payload:=jsonb_build_object('kind',p_kind,'id',p_id,'creatorId',v_source->>'creatorId','context',p_context,'createdAt',floor(extract(epoch from t.created_at))::bigint,
   'closed',coalesce(t.restoration_status='succeeded' and t.restoration_transfer_id is not null and exists(select 1 from public.tips where id=t.tip_id and dispute_status='won'),false),
   'chargeId',t.stripe_charge_id,'paymentIntentId',t.stripe_payment_intent_id,'tipId',t.tip_id,'disputeId',t.stripe_dispute_id,'originalTransferId',t.stripe_transfer_id,
   'restorationTransferId',t.restoration_transfer_id,'destinationId',v_source->>'destinationId','restorationCents',t.reversal_amount_cents);
 end if;
 if exists(select 1 from public.sales_team_shared_cash_resolutions_v1 resolved join public.sales_team_shared_cash_checks_v1 checked on checked.id=resolved.check_id
  where resolved.source_kind=p_kind and resolved.source_id=p_id and resolved.context=p_context and
   (checked.source->'refundId' is distinct from v_payload->'refundId' or checked.source->'feeRefundId' is distinct from v_payload->'feeRefundId' or checked.source->'restorationTransferId' is distinct from v_payload->'restorationTransferId')) then raise exception 'ORIGINAL_SHARED_PROVIDER_IDENTITY_CHANGED';end if;
 -- A missing original may later become bound by the existing legacy journal.
 -- Once seen as bound, neither a pending check nor a new check may substitute
 -- another provider object, even before the first cash resolution completes.
 if exists(select 1 from public.sales_team_shared_cash_checks_v1 checked where checked.source_kind=p_kind and checked.source_id=p_id and checked.context=p_context and (
  checked.source->>'refundId' is not null and checked.source->'refundId' is distinct from v_payload->'refundId' or
  checked.source->>'feeRefundId' is not null and checked.source->'feeRefundId' is distinct from v_payload->'feeRefundId' or
  checked.source->>'restorationTransferId' is not null and checked.source->'restorationTransferId' is distinct from v_payload->'restorationTransferId')) then raise exception 'ORIGINAL_SHARED_PROVIDER_IDENTITY_CHANGED';end if;
 return v_payload||jsonb_build_object('fingerprint',encode(sha256(convert_to(v_payload::text||':'||v_version::text,'UTF8')),'hex'));
end $$;
create function public.complete_sales_team_shared_cash_check_v1(p_check_id uuid,p_actor_id uuid,p_worker_run_id uuid,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare checked public.sales_team_shared_cash_checks_v1;current_source jsonb;e jsonb;read_item jsonb;v_proof jsonb;v_complete boolean;v_fresh boolean;v_resolved boolean;begin
 if not creatornet_team_private.shared_cash_reader_authorized_v1(p_actor_id,p_worker_run_id) then raise exception 'SHARED_CASH_READER_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));select * into checked from public.sales_team_shared_cash_checks_v1 where id=p_check_id;
 if checked.id is null then raise exception 'ORIGINAL_SHARED_CASH_CHECK_REQUIRED';end if;
 if checked.actor_id is distinct from p_actor_id or checked.worker_run_id is distinct from p_worker_run_id then raise exception 'ORIGINAL_SHARED_CASH_READER_CHANGED';end if;
 current_source:=creatornet_team_private.shared_cash_original_v1(checked.source_kind,checked.source_id,checked.context);
 v_resolved:=exists(select 1 from public.sales_team_shared_cash_resolutions_v1 where source_kind=checked.source_kind and source_id=checked.source_id and context=checked.context and source_fingerprint=current_source->>'fingerprint');
 if exists(select 1 from public.sales_team_shared_cash_check_results_v1 where check_id=checked.id) then return jsonb_build_object('checkId',checked.id,'held',not v_resolved,'completed',true);end if;
 if checked.contract_sha256 is distinct from creatornet_team_private.shared_cash_contract_digest_v1() or not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and shared_contract_sha256=checked.contract_sha256) then raise exception 'SHARED_CASH_CONTRACT_REVIEW_REQUIRED';end if;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"version":"string","sourceKind":"string","sourceId":"string","fingerprint":"string","context":"object","readStartedAt":"number","complete":"boolean","holdReason":"string|null","objects":"object","balances":"array","reads":"array"}');
 if p_proof->>'version' is distinct from 'creatornet-shared-cash-observation-v1' or p_proof->>'sourceKind' is distinct from checked.source_kind or p_proof->>'sourceId' is distinct from checked.source_id or
  p_proof->>'fingerprint' is distinct from checked.source->>'fingerprint' or p_proof->'context' is distinct from checked.context or jsonb_array_length(p_proof->'balances')>4 or jsonb_array_length(p_proof->'reads')>16 or
  (p_proof->>'readStartedAt')::numeric<extract(epoch from checked.created_at)*1000-5 or (p_proof->>'readStartedAt')::numeric>extract(epoch from clock_timestamp())*1000 or
  (p_proof->>'readStartedAt')::numeric<extract(epoch from clock_timestamp()-interval '55 seconds')*1000 then raise exception 'CURRENT_ORIGINAL_SHARED_CASH_PROOF_REQUIRED';end if;
 for read_item in select value from jsonb_array_elements(p_proof->'reads') loop
  perform creatornet_team_private.financial_shape_v1(read_item,'{"path":"string","requestId":"string"}');
  if read_item->>'requestId'!~'^req_[A-Za-z0-9]{1,100}$' or length(read_item->>'path')>300 or not coalesce((
   read_item->>'path'='/v1/charges/'||(checked.source->>'chargeId') or
   checked.source_kind='legacy_refund' and (read_item->>'path'='/v1/refunds/'||(checked.source->>'refundId') or read_item->>'path'='/v1/application_fees/'||(checked.source->>'applicationFeeId') or read_item->>'path'='/v1/application_fees/'||(checked.source->>'applicationFeeId')||'/refunds/'||(checked.source->>'feeRefundId')) or
   checked.source_kind='tip_restoration' and (read_item->>'path'='/v1/transfers/'||(checked.source->>'restorationTransferId') or read_item->>'path'='/v1/disputes/'||(checked.source->>'disputeId')) or
   read_item->>'path'~'^/v1/balance_transactions/txn_[A-Za-z0-9]{1,100}$'),false) then raise exception 'OWNED_SHARED_CASH_READ_REQUIRED';end if;
 end loop;
 if jsonb_array_length(p_proof->'reads')<>(select count(distinct v->>'requestId') from jsonb_array_elements(p_proof->'reads') v) then raise exception 'INDEPENDENT_SHARED_CASH_READS_REQUIRED';end if;
 v_fresh:=current_source->>'fingerprint'=checked.source->>'fingerprint';v_complete:=p_proof->'complete'='true'::jsonb and v_fresh;
 if v_complete then
  if p_proof->'holdReason' is distinct from 'null'::jsonb then raise exception 'COMPLETE_SHARED_CASH_TRACE_REQUIRED';end if;
  perform creatornet_team_private.shared_cash_trace_v1(checked.source,p_proof);v_proof:=p_proof;
  for e in select value from jsonb_array_elements(p_proof->'balances') loop
   insert into public.sales_team_shared_cash_balance_entries_v1(transaction_id,source_kind,source_id,check_id,identity)
   values(e->>'id',checked.source_kind,checked.source_id,checked.id,e-'requestId'-'status'-'availableOn') on conflict(transaction_id) do nothing;
  end loop;
  insert into public.sales_team_shared_cash_resolutions_v1(source_kind,source_id,commitment_version,context,check_id,source_fingerprint)
   values(checked.source_kind,checked.source_id,checked.commitment_version,checked.context,checked.id,checked.source->>'fingerprint') on conflict(source_kind,source_id,commitment_version,source_fingerprint,context) do nothing;
  if found then update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;end if;
 else
  if v_fresh and (p_proof->'complete' is distinct from 'false'::jsonb or not coalesce(p_proof->>'holdReason' in ('original_workflow_unfinished','original_provider_identity_required','original_refund_pending','original_tip_dispute_unfinished'),false)) then raise exception 'EXPLICIT_SHARED_CASH_HOLD_REQUIRED';end if;
  -- Incomplete/stale reads cannot persist arbitrary provider/customer fields.
  v_proof:=jsonb_build_object('scope','shared_cash_hold','context',checked.context,'fingerprint',checked.source->>'fingerprint','holdReason',case when v_fresh then p_proof->>'holdReason' else 'source_changed' end,'reads',p_proof->'reads');
 end if;
 insert into public.sales_team_shared_cash_check_results_v1(check_id,complete,proof,observed_by,worker_run_id) values(checked.id,v_complete,v_proof,p_actor_id,p_worker_run_id);
 return jsonb_build_object('checkId',checked.id,'held',not(v_resolved or v_complete),'completed',true);
end $$;
alter function creatornet_team_private.shared_platform_cash_liabilities_v1(jsonb) rename to shared_cash_liabilities_before_resolution_v1;
create function creatornet_team_private.shared_platform_cash_liabilities_v1(p_context jsonb)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare policy public.sales_team_cash_policy_v1;v_protected numeric;v_revision text;begin
 perform creatornet_team_private.shared_cash_liabilities_before_resolution_v1(p_context);
 select * into policy from public.sales_team_cash_policy_v1 where singleton;
 if policy.shared_contract_sha256 is distinct from creatornet_team_private.shared_cash_contract_digest_v1() then raise exception 'SHARED_CASH_CONTRACT_REVIEW_REQUIRED';end if;
 with commitments as (select source_kind,source_id,max(principal_cents) principal,max(version) version from public.sales_team_shared_cash_commitments_v1 group by source_kind,source_id),
  observed as (select c.*,creatornet_team_private.shared_cash_original_v1(c.source_kind,c.source_id,p_context)->>'fingerprint' fingerprint from commitments c),
  outstanding as (select o.* from observed o where not exists(select 1 from public.sales_team_shared_cash_resolutions_v1 r where r.source_kind=o.source_kind and r.source_id=o.source_id and r.commitment_version=o.version and r.context=p_context and r.source_fingerprint=o.fingerprint))
 select coalesce(sum(principal::numeric+case when source_kind='legacy_refund' then policy.legacy_refund_cost_reserve_cents else policy.tip_restoration_cost_reserve_cents end),0),
  encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(source_kind,source_id,principal,version,fingerprint) order by source_kind collate "C",source_id collate "C"),'[]'::jsonb)::text||':'||policy.legacy_refund_cost_reserve_cents::text||':'||policy.tip_restoration_cost_reserve_cents::text,'UTF8')),'hex')
 into v_protected,v_revision from outstanding;
 if v_protected>9007199254740991 then raise exception 'SHARED_PLATFORM_CASH_RANGE_REQUIRED';end if;
 return jsonb_build_object('protectedCents',v_protected,'sourceRevision',v_revision);
end $$;
alter function public.sales_team_shared_cash_admitted_v1(text,text) rename to shared_cash_admitted_before_resolution_v1;
create function public.sales_team_shared_cash_admitted_v1(p_source_kind text,p_source_id text)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select not exists(select 1 from public.sales_team_shared_cash_resolutions_v1 where source_kind=p_source_kind and source_id=p_source_id) and public.shared_cash_admitted_before_resolution_v1(p_source_kind,p_source_id)
$$;
create function public.begin_sales_team_shared_cash_check_v1(p_check_id uuid,p_source_kind text,p_source_id text,p_actor_id uuid,p_worker_run_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare checked public.sales_team_shared_cash_checks_v1;v_source jsonb;v_version bigint;v_complete boolean;begin
 if p_check_id is null or not creatornet_team_private.shared_cash_reader_authorized_v1(p_actor_id,p_worker_run_id) then raise exception 'SHARED_CASH_READER_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 v_source:=creatornet_team_private.shared_cash_original_v1(p_source_kind,p_source_id,p_context);
 select max(version) into v_version from public.sales_team_shared_cash_commitments_v1 where source_kind=p_source_kind and source_id=p_source_id;
 select * into checked from public.sales_team_shared_cash_checks_v1 where id=p_check_id;
 if checked.id is not null then
  if checked.source_kind is distinct from p_source_kind or checked.source_id is distinct from p_source_id or checked.context is distinct from p_context then raise exception 'ORIGINAL_SHARED_CASH_CHECK_CHANGED';end if;
  if checked.actor_id is distinct from p_actor_id or checked.worker_run_id is distinct from p_worker_run_id then raise exception 'ORIGINAL_SHARED_CASH_READER_CHANGED';end if;
  v_complete:=exists(select 1 from public.sales_team_shared_cash_check_results_v1 where check_id=checked.id);
  return jsonb_build_object('checkId',checked.id,'completed',v_complete,'held',not exists(select 1 from public.sales_team_shared_cash_resolutions_v1 where source_kind=p_source_kind and source_id=p_source_id and context=p_context and commitment_version=v_version and source_fingerprint=v_source->>'fingerprint'),'source',checked.source);
 end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and shared_cash_reconciliation_enabled) then raise exception 'SHARED_CASH_INSPECTIONS_HELD';end if;
 if not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and shared_contract_sha256=creatornet_team_private.shared_cash_contract_digest_v1()) then raise exception 'SHARED_CASH_CONTRACT_REVIEW_REQUIRED';end if;
 insert into public.sales_team_shared_cash_checks_v1(id,source_kind,source_id,context,source,commitment_version,actor_id,worker_run_id,contract_sha256)
 values(p_check_id,p_source_kind,p_source_id,p_context,v_source,v_version,p_actor_id,p_worker_run_id,creatornet_team_private.shared_cash_contract_digest_v1());
 return jsonb_build_object('checkId',p_check_id,'completed',false,'held',not exists(select 1 from public.sales_team_shared_cash_resolutions_v1 where source_kind=p_source_kind and source_id=p_source_id and context=p_context and commitment_version=v_version and source_fingerprint=v_source->>'fingerprint'),'source',v_source);
end $$;
create function creatornet_team_private.shared_cash_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid),E'\n' order by p.oid::regprocedure::text collate "C"),'UTF8')),'hex')
 from pg_proc p where (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in ('shared_cash_reader_authorized_v1','shared_cash_original_v1','shared_cash_contract_digest_v1','shared_cash_trace_v1','shared_cash_source_v1','shared_cash_required_v1','shared_platform_cash_liabilities_v1','shared_cash_liabilities_before_resolution_v1','capture_shared_cash_v1','cash_protection_v1','cash_encumbered_v1','cash_available_floor_v1','financial_shape_v1','reject_history_change','refund_retained_cash_plan_v1','refund_retained_cash_credit_v1','retained_cash_contract_digest_v1')) or
  (p.pronamespace='public'::regnamespace and p.proname in ('begin_sales_team_cash_read_v1','begin_sales_team_shared_cash_read_v1','complete_sales_team_cash_read_v1','complete_sales_team_cash_read_before_shared_v1','admit_sales_team_shared_cash_v1','sales_team_shared_cash_admitted_v1','shared_cash_admitted_before_resolution_v1','begin_sales_team_shared_cash_check_v1','complete_sales_team_shared_cash_check_v1','claim_refund_operation','claim_refund_operation_before_team_cash_v1','record_tip_dispute_recovery','record_tip_dispute_with_cash_v1','record_tip_dispute_before_team_cash_v1','run_exact_context_admin_refund_v2','run_exact_refund_before_team_cash_v1'))
$$;
create function creatornet_team_private.shared_cash_trace_v1(s jsonb,p jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare o jsonb:=p->'objects';c jsonb:=o->'charge';r jsonb;f jsonb;e jsonb;part jsonb;root jsonb;v_refs jsonb:='[]';v_fees numeric;v_old record;v_path text;begin
 perform creatornet_team_private.financial_shape_v1(c,'{"id":"string","paymentIntentId":"string","currency":"string","amountCents":"number","livemode":"boolean","paid":"boolean","captured":"boolean","status":"string","applicationFeeId":"string","transferId":"string","destinationId":"string"}');
 if s->'closed' is distinct from 'true'::jsonb or c->>'id' is distinct from s->>'chargeId' or c->>'paymentIntentId' is distinct from s->>'paymentIntentId' or
  c->>'currency' is distinct from 'usd' or c->'livemode' is distinct from to_jsonb(s->'context'->>'mode'='live') or c->'paid' is distinct from 'true'::jsonb or c->'captured' is distinct from 'true'::jsonb or c->>'status' is distinct from 'succeeded' or (c->>'amountCents')::numeric<=0 or c->>'transferId'!~'^tr_[A-Za-z0-9]+$' or c->>'destinationId'!~'^acct_[A-Za-z0-9]+$' then raise exception 'OWNED_SHARED_CASH_CHARGE_REQUIRED';end if;
 if s->>'kind'='legacy_refund' then
  if exists(select 1 from jsonb_object_keys(o) key where key not in ('charge','refund','feeRefund','applicationFee')) or c->'amountCents' is distinct from s->'grossCents' or c->>'applicationFeeId' is distinct from s->>'applicationFeeId' then raise exception 'OWNED_SHARED_REFUND_REQUIRED';end if;
  r:=o->'refund';perform creatornet_team_private.financial_shape_v1(r,'{"id":"string","status":"string","chargeId":"string","paymentIntentId":"string","amountCents":"number","currency":"string","created":"number","balanceId":"string|null","failureBalanceId":"string|null","operationId":"string","responsibility":"string","reasonCode":"string"}');
  if r->>'id' is distinct from s->>'refundId' or r->>'chargeId' is distinct from s->>'chargeId' or r->>'paymentIntentId' is distinct from s->>'paymentIntentId' or
   r->'amountCents' is distinct from s->'refundCents' or r->>'currency' is distinct from 'usd' or r->>'operationId' is distinct from s->>'id' or r->>'responsibility' is distinct from s->>'responsibility' or r->>'reasonCode' is distinct from s->>'reasonCode' or
   r->>'status' not in ('succeeded','failed','canceled') or (r->>'created')::numeric<(s->>'createdAt')::numeric-5 or (r->>'created')::numeric>extract(epoch from clock_timestamp())+5 then raise exception 'OWNED_SHARED_REFUND_REQUIRED';end if;
  if r->>'status'='succeeded' then
   if r->>'failureBalanceId' is not null or r->>'balanceId' is null then raise exception 'SHARED_REFUND_DEBIT_REQUIRED';end if;
  elsif (r->>'balanceId' is null)<>(r->>'failureBalanceId' is null) then raise exception 'SHARED_REFUND_RETURN_REQUIRED';end if;
  if r->>'balanceId' is not null then v_refs:=v_refs||jsonb_build_array(jsonb_build_object('id',r->>'balanceId','sourceId',r->>'id','kind','refund','amountCents',-(s->>'refundCents')::bigint));end if;
  if r->>'failureBalanceId' is not null then v_refs:=v_refs||jsonb_build_array(jsonb_build_object('id',r->>'failureBalanceId','sourceId',r->>'id','kind','refund_failure','amountCents',(s->>'refundCents')::bigint));end if;
  if s->>'feeRefundId' is not null then
   f:=o->'feeRefund';perform creatornet_team_private.financial_shape_v1(f,'{"id":"string","feeId":"string","amountCents":"number","currency":"string","created":"number","balanceId":"string","operationId":"string","responsibility":"string"}');
   root:=o->'applicationFee';perform creatornet_team_private.financial_shape_v1(root,'{"id":"string","chargeId":"string","accountId":"string","currency":"string","livemode":"boolean","amountCents":"number","refundedCents":"number"}');
   if f->>'id' is distinct from s->>'feeRefundId' or f->>'feeId' is distinct from s->>'applicationFeeId' or f->'amountCents' is distinct from s->'actualFeeRefundCents' or
    (f->>'amountCents')::bigint not between 1 and (s->>'feeRefundCents')::bigint or f->>'operationId' is distinct from s->>'id' or f->>'responsibility' is distinct from s->>'responsibility' or f->>'currency' is distinct from 'usd' or
    (f->>'created')::numeric<(s->>'createdAt')::numeric-5 or (f->>'created')::numeric>extract(epoch from clock_timestamp())+5 or root->>'id' is distinct from s->>'applicationFeeId' or root->>'chargeId' is distinct from s->>'chargeId' or
    root->>'accountId' is distinct from c->>'destinationId' or root->>'currency' is distinct from 'usd' or root->'livemode' is distinct from c->'livemode' or
    (root->>'refundedCents')::bigint not between (f->>'amountCents')::bigint and (root->>'amountCents')::bigint then raise exception 'OWNED_SHARED_FEE_REFUND_REQUIRED';end if;
   v_refs:=v_refs||jsonb_build_array(jsonb_build_object('id',f->>'balanceId','sourceId',f->>'id','kind','application_fee_refund','amountCents',-(f->>'amountCents')::bigint));
  elsif (s->>'feeRefundCents')::bigint<>0 or o?'feeRefund' or o?'applicationFee' then raise exception 'ORIGINAL_SHARED_FEE_IDENTITY_REQUIRED';end if;
 else
  if (select count(*) from jsonb_object_keys(o))<>3 or not o?&array['charge','transfer','dispute'] then raise exception 'OWNED_SHARED_TIP_REQUIRED';end if;
  r:=o->'transfer';perform creatornet_team_private.financial_shape_v1(r,'{"id":"string","amountCents":"number","currency":"string","destinationId":"string","created":"number","balanceId":"string","livemode":"boolean","sourceTransaction":"null","sourceType":"string","transferGroup":"string","tipId":"string","disputeId":"string"}');
  f:=o->'dispute';perform creatornet_team_private.financial_shape_v1(f,'{"id":"string","status":"string","chargeId":"string","paymentIntentId":"string","currency":"string","livemode":"boolean"}');
  if r->>'id' is distinct from s->>'restorationTransferId' or r->'amountCents' is distinct from s->'restorationCents' or (r->>'amountCents')::bigint<=0 or r->>'currency' is distinct from 'usd' or r->'livemode' is distinct from c->'livemode' or
   r->>'destinationId' is distinct from s->>'destinationId' or r->>'sourceType' is distinct from 'card' or r->>'transferGroup' is distinct from 'creatornet-tip-dispute-restore:'||(s->>'disputeId') or r->>'tipId' is distinct from s->>'tipId' or r->>'disputeId' is distinct from s->>'disputeId' or
   c->>'transferId' is distinct from s->>'originalTransferId' or c->>'destinationId' is distinct from s->>'destinationId' or f->>'id' is distinct from s->>'disputeId' or f->>'status' is distinct from 'won' or f->>'chargeId' is distinct from s->>'chargeId' or
   f->>'paymentIntentId' is distinct from s->>'paymentIntentId' or f->>'currency' is distinct from 'usd' or f->'livemode' is distinct from c->'livemode' or (r->>'created')::numeric<(s->>'createdAt')::numeric-5 or (r->>'created')::numeric>extract(epoch from clock_timestamp())+5 then raise exception 'OWNED_SHARED_TIP_REQUIRED';end if;
  v_refs:=jsonb_build_array(jsonb_build_object('id',r->>'balanceId','sourceId',r->>'id','kind','transfer','amountCents',-(s->>'restorationCents')::bigint));
 end if;
 if jsonb_array_length(p->'balances')<>jsonb_array_length(v_refs) or jsonb_array_length(v_refs)<>(select count(distinct v->>'id') from jsonb_array_elements(v_refs) v) or
  jsonb_array_length(p->'balances')<>(select count(distinct v->>'id') from jsonb_array_elements(p->'balances') v) then raise exception 'SHARED_CASH_BALANCE_COVERAGE_REQUIRED';end if;
 for e in select value from jsonb_array_elements(p->'balances') loop
  perform creatornet_team_private.financial_shape_v1(e,'{"id":"string","sourceId":"string","kind":"string","amountCents":"number","feeCents":"number","netCents":"number","currency":"string","created":"number","availableOn":"number","status":"string","balanceType":"string","feeDetails":"array","requestId":"string"}');
  if e->>'id'!~'^txn_[A-Za-z0-9]+$' or e->>'currency' is distinct from 'usd' or e->>'status' is distinct from 'available' or e->>'balanceType' is distinct from 'payments' or e->>'requestId'!~'^req_[A-Za-z0-9]+$' or
   (e->>'netCents')::numeric<>(e->>'amountCents')::numeric-(e->>'feeCents')::numeric or (e->>'created')::numeric<(s->>'createdAt')::numeric-5 or (e->>'created')::numeric>extract(epoch from clock_timestamp())+5 or
   (e->>'availableOn')::numeric not between 1 and extract(epoch from clock_timestamp()) or not exists(select 1 from jsonb_array_elements(v_refs) v where v=e-'feeCents'-'netCents'-'currency'-'created'-'availableOn'-'status'-'balanceType'-'feeDetails'-'requestId') or
   jsonb_array_length(e->'feeDetails')>32 then raise exception 'OWNED_SHARED_CASH_BALANCE_REQUIRED';end if;
  v_fees:=0;for part in select value from jsonb_array_elements(e->'feeDetails') loop
   perform creatornet_team_private.financial_shape_v1(part,'{"amount":"number","currency":"string","application":"null","type":"string"}');
   if part->>'currency' is distinct from 'usd' or part->>'type' not in ('stripe_fee','tax','payment_method_passthrough_fee') then raise exception 'ACTUAL_SHARED_CASH_FEE_REQUIRED';end if;
   v_fees:=v_fees+(part->>'amount')::numeric;
  end loop;if v_fees<>(e->>'feeCents')::numeric then raise exception 'ACTUAL_SHARED_CASH_FEE_REQUIRED';end if;
  select source_kind,source_id,identity into v_old from public.sales_team_shared_cash_balance_entries_v1 where transaction_id=e->>'id';
  if found and (v_old.source_kind is distinct from s->>'kind' or v_old.source_id is distinct from s->>'id' or v_old.identity is distinct from e-'requestId'-'status'-'availableOn') then raise exception 'ORIGINAL_SHARED_CASH_BALANCE_CHANGED';end if;
 end loop;
 -- Required repeated original reads and the exact owned transaction references.
 for v_path in select path from (
  select '/v1/charges/'||(s->>'chargeId') path,2 required union all
  select '/v1/refunds/'||(s->>'refundId'),2 where s->>'kind'='legacy_refund' union all
  select '/v1/application_fees/'||(s->>'applicationFeeId'),1 where s->>'kind'='legacy_refund' and s->>'feeRefundId' is not null union all
  select '/v1/application_fees/'||(s->>'applicationFeeId')||'/refunds/'||(s->>'feeRefundId'),2 where s->>'kind'='legacy_refund' and s->>'feeRefundId' is not null union all
  select '/v1/transfers/'||(s->>'restorationTransferId'),2 where s->>'kind'='tip_restoration' union all
  select '/v1/disputes/'||(s->>'disputeId'),2 where s->>'kind'='tip_restoration'
 ) required_paths where required>(select count(*) from jsonb_array_elements(p->'reads') v where v->>'path'=required_paths.path) loop raise exception 'INDEPENDENT_SHARED_CASH_READS_REQUIRED: %',v_path;end loop;
 if exists(select 1 from jsonb_array_elements(p->'balances') balance_row where not exists(select 1 from jsonb_array_elements(p->'reads') v where v->>'path'='/v1/balance_transactions/'||(balance_row->>'id') and v->>'requestId'=balance_row->>'requestId')) then raise exception 'INDEPENDENT_SHARED_CASH_READS_REQUIRED';end if;
end $$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_shared_cash_checks_v1','sales_team_shared_cash_check_results_v1','sales_team_shared_cash_balance_entries_v1','sales_team_shared_cash_resolutions_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated',name);execute format('grant select,insert on public.%I to service_role',name);
  execute format('create trigger immutable_shared_cash_check before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where (pronamespace='public'::regnamespace and proname in ('begin_sales_team_shared_cash_check_v1','complete_sales_team_shared_cash_check_v1','sales_team_shared_cash_admitted_v1','shared_cash_admitted_before_resolution_v1')) or
  (pronamespace='creatornet_team_private'::regnamespace and proname in ('shared_cash_reader_authorized_v1','shared_cash_original_v1','shared_cash_contract_digest_v1','shared_cash_trace_v1','shared_platform_cash_liabilities_v1','shared_cash_liabilities_before_resolution_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
