-- Local candidate: freeze earned-share transfer originals and protect uncertain
-- principal/cost. No scheduler, provider POST or accounting release is installed.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column transfer_reservations_enabled boolean not null default false;
alter table public.sales_team_cash_policy_v1 add column transfer_contract_sha256 text check(transfer_contract_sha256~'^[a-f0-9]{64}$'),
 add column transfer_cost_reserve_cents bigint check(transfer_cost_reserve_cents between 0 and 9007199254740991);
create table public.sales_team_settlement_runs_v1 (
 run_id uuid primary key references public.sales_team_worker_runs_v1(id) on delete restrict,
 lease_token uuid not null default gen_random_uuid(),context jsonb not null,contract_sha256 text not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_requests_v1 (
 id uuid primary key,operation_id uuid not null unique,receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,creator_id uuid not null references auth.users(id) on delete restrict,
 beneficiary text not null check(beneficiary in ('creator','closer')),beneficiary_user_id uuid not null references auth.users(id) on delete restrict,
 destination_id text not null check(destination_id~'^acct_[A-Za-z0-9]+$'),amount_cents bigint not null check(amount_cents between 1 and 99999999),
 receipt_revision integer not null,original_worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 context jsonb not null,request jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_settlement_tasks_v1 (
 id uuid primary key,run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(),unique(run_id,request_id)
);
create table public.sales_team_transfer_cash_reservations_v1 (
 request_id uuid primary key references public.sales_team_transfer_requests_v1(id) on delete restrict,
 read_id uuid not null references public.sales_team_cash_observations_v1(read_id) on delete restrict,
 cost_reserve_cents bigint not null check(cost_reserve_cents>=0),created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_cash_rechecks_v1 (
 read_id uuid primary key references public.sales_team_cash_observations_v1(read_id) on delete restrict,
 request_id uuid not null references public.sales_team_transfer_requests_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_transfer_cancellations_v1 (
 request_id uuid primary key references public.sales_team_transfer_requests_v1(id) on delete restrict,
 worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 reason text not null check(reason='not_dispatched'),created_at timestamptz not null default clock_timestamp()
);
-- A later independently verified observation contract must own inserts here.
-- Service callers receive SELECT only in this candidate: no fake completion.
create table public.sales_team_transfer_completions_v1 (
 request_id uuid primary key references public.sales_team_transfer_requests_v1(id) on delete restrict,
 transfer_id text not null unique check(transfer_id~'^tr_[A-Za-z0-9]+$'),balance_id text not null unique check(balance_id~'^txn_[A-Za-z0-9]+$'),
 worker_run_id uuid not null references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 proof jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table public.sales_team_cash_reads_v1 add column settlement_worker_run_id uuid references public.sales_team_settlement_runs_v1(run_id) on delete restrict,
 add constraint sales_team_cash_settlement_observer_v1 check(settlement_worker_run_id is null or actor_id is null and source_kind is null and source_id is null);
create function creatornet_team_private.transfer_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid),E'\n' order by p.oid::regprocedure::text collate "C"),'UTF8')),'hex') from pg_proc p where
 (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in ('transfer_contract_digest_v1','settlement_worker_v1','transfer_unpaid_credit_v1','cash_encumbered_v1','cash_encumbered_before_transfers_v1','cash_protection_v1','cash_available_floor_v1','financial_shape_v1','reject_history_change','refund_retained_cash_plan_v1','transfer_share_v1')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('claim_sales_team_settlement_run_v1','begin_sales_team_settlement_cash_v1','complete_sales_team_settlement_cash_v1','reserve_sales_team_transfer_v1','cancel_unsent_sales_team_transfer_v1','sales_team_transfer_request_json_v1','sales_team_transfer_operation_admitted_v1','sales_team_operation_admitted_v1','claim_sales_team_provider_operation_v1','claim_sales_team_operation_before_transfer_v1','claim_sales_team_operation_before_refund_v1','sales_team_operation_json_v1','bind_sales_team_provider_operation_v1','mark_sales_team_provider_unknown_v1','assert_sales_team_provider_dispatch_v1','assert_sales_team_dispatch_before_transfer_v1','sales_team_transfer_operation_id_v1'))
$$;
create function creatornet_team_private.settlement_worker_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb)
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_settlement_runs_v1 run join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id
  join public.sales_team_financial_config_v1 config on config.singleton and config.context=run.context join public.sales_team_cash_policy_v1 policy on policy.singleton
  where run.run_id=p_run_id and run.lease_token=p_lease_token and run.context=p_context and worker.kind='settlement' and worker.status='running' and worker.lease_until>clock_timestamp() and
   run.contract_sha256=policy.transfer_contract_sha256 and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1()) then raise exception 'CURRENT_SETTLEMENT_WORKER_REQUIRED';end if;
end $$;
create function public.claim_sales_team_settlement_run_v1(p_run_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare slot timestamptz;run public.sales_team_settlement_runs_v1;digest text;begin
 if p_run_id is null or not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'SETTLEMENT_CONTEXT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('creatornet-team-settlement-v1',0));
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_reservations_enabled) then return jsonb_build_object('status','held');end if;
 digest:=creatornet_team_private.transfer_contract_digest_v1();
 if not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and transfer_contract_sha256=digest and transfer_cost_reserve_cents is not null) then raise exception 'TRANSFER_CONTRACT_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.sales_team_settlement_runs_v1 r join public.sales_team_worker_runs_v1 w on w.id=r.run_id where w.status='running' and w.lease_until>clock_timestamp()) then return jsonb_build_object('status','busy');end if;
 slot:=date_bin(interval '15 minutes',clock_timestamp(),'2000-01-01'::timestamptz);
 if exists(select 1 from public.sales_team_worker_runs_v1 where kind='settlement' and scheduled_slot=slot) then return jsonb_build_object('status','slot_consumed');end if;
 insert into public.sales_team_worker_runs_v1(id,kind,scheduled_slot,lease_until,status) values(p_run_id,'settlement',slot,clock_timestamp()+interval '90 seconds','running');
 insert into public.sales_team_settlement_runs_v1(run_id,context,contract_sha256) values(p_run_id,p_context,digest) returning * into run;
 return jsonb_build_object('status','claimed','runId',run.run_id,'leaseToken',run.lease_token);
end $$;
create function creatornet_team_private.transfer_share_v1(p_receipt_id uuid,p_beneficiary text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;c public.sales_team_creator_balances_v1;b public.sales_team_commission_balances_v1;
 recipient public.sales_team_recipients_v1;v_user_id uuid;destination text;unpaid bigint;begin
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id;select * into a from public.sales_team_sale_agreements_v1 where id=r.sale_id;
 select * into c from public.sales_team_creator_balances_v1 where receipt_id=r.id;select * into b from public.sales_team_commission_balances_v1 where receipt_id=r.id;
 if a.id is null or c.creator_id is distinct from a.creator_id or c.sale_id is distinct from a.id or b.creator_id is distinct from a.creator_id or b.sale_id is distinct from a.id or b.membership_id is distinct from a.membership_id or
  r.review_hold or r.dispute_hold or r.processing_cost_cents is null or r.available_on is null or r.available_on>clock_timestamp() or
  exists(select 1 from public.sales_team_payment_runtime_v1 where sale_id=a.id and financial_hold) or
  exists(select 1 from public.sales_team_refund_requests_v1 where sale_id=a.id and not public.sales_team_refund_request_resolved_v1(id)) or
  not exists(select 1 from public.sales_team_financial_checks_v1 checked join public.sales_team_financial_check_results_v1 done on done.check_id=checked.id
   where checked.receipt_id=r.id and checked.context=a.context and done.created_at>=r.observed_at and done.created_at>clock_timestamp()-interval '2 minutes' and
    done.proof->'balances'->'complete'='true'::jsonb and done.proof->'financial'->'reviewHold'='false'::jsonb and done.proof->'financial'->'disputeHold'='false'::jsonb) then return null;end if;
 if p_beneficiary='creator' then
  if exists(select 1 from public.sales_team_creator_balances_v1 debt where debt.creator_id=a.creator_id and (debt.creator_deficit_cents>0 or debt.creator_released_cents-debt.creator_reversed_cents>debt.creator_proceeds_cents)) or
   exists(select 1 from public.sales_team_commission_balances_v1 debt where debt.creator_id=a.creator_id and debt.released_cents-debt.reversed_cents>debt.earned_cents) then return null;end if;
  v_user_id:=a.creator_id;destination:=a.terms->'distribution'->>'creatorRecipientId';unpaid:=greatest(0,c.creator_proceeds_cents-c.creator_released_cents+c.creator_reversed_cents);
 elsif p_beneficiary='closer' then
  if b.hold_until is distinct from r.paid_at+make_interval(days=>(a.terms->'commission'->>'holdDays')::integer) or b.hold_until>clock_timestamp() then return null;end if;
  if exists(select 1 from public.sales_team_commission_balances_v1 debt where debt.creator_id=a.creator_id and debt.membership_id=a.membership_id and debt.released_cents-debt.reversed_cents>debt.earned_cents) then return null;end if;
  v_user_id:=a.closer_id;destination:=a.terms->'distribution'->>'closerRecipientId';unpaid:=greatest(0,b.earned_cents-b.released_cents+b.reversed_cents);
 else return null;end if;
 select * into recipient from public.sales_team_recipients_v1 where user_id=v_user_id;
 if unpaid not between 1 and 99999999 or recipient.account_id is distinct from destination or not recipient.ownership_verified or not recipient.transfers_active or not recipient.payouts_ready or
  recipient.country<>'US' or recipient.currency<>'usd' or recipient.mode is distinct from a.context->>'mode' or recipient.platform_account_id is distinct from a.context->>'platformAccountId' or
  recipient.verified_at is null or recipient.verified_at<=clock_timestamp()-interval '15 minutes' then return null;end if;
 return jsonb_build_object('receiptId',r.id,'saleId',a.id,'creatorId',a.creator_id,'userId',v_user_id,'beneficiary',p_beneficiary,'destinationId',destination,'amountCents',unpaid,
  'revision',r.observation_revision,'context',a.context,'chargeId',r.charge_id,'transferGroup','cn_team_'||a.id::text);
end $$;
create function public.sales_team_transfer_operation_id_v1(p_request_id uuid)
returns uuid language sql immutable security invoker set search_path=pg_catalog as $$
 select overlay(overlay(substring(encode(sha256(convert_to('creatornet-team-v1:'||p_request_id::text||':transfer:settlement:v1','UTF8')),'hex'),1,32) placing '4' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;
create function public.sales_team_transfer_request_json_v1(p_request_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select to_jsonb(q)||jsonb_build_object('chargeId',(select charge_id from public.sales_team_receipts_v1 where id=q.receipt_id),
  'approvedRecipientId',(select terms->'distribution'->>(case when q.beneficiary='creator' then 'creatorRecipientId' else 'closerRecipientId' end) from public.sales_team_sale_agreements_v1 where id=q.sale_id),
  'scope',jsonb_build_object('scopeId',q.id,'scopeKey','settlement:v1','kind','transfer','saleId',q.sale_id,'creatorId',q.creator_id,'actorId',null,'workerRunId',q.original_worker_run_id),
  'operation',public.sales_team_operation_json_v1(q.operation_id),'canceled',exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id),
  'completed',exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id)) from public.sales_team_transfer_requests_v1 q where q.id=p_request_id
$$;
create function creatornet_team_private.transfer_unpaid_credit_v1(p_request_id uuid)
returns bigint language sql stable security invoker set search_path=pg_catalog as $$
 select coalesce((select least(q.amount_cents,case when q.beneficiary='creator' then greatest(0,c.creator_proceeds_cents-c.creator_released_cents+c.creator_reversed_cents) else greatest(0,b.earned_cents-b.released_cents+b.reversed_cents) end)
 from public.sales_team_transfer_requests_v1 q join public.sales_team_sale_agreements_v1 a on a.id=q.sale_id and a.creator_id=q.creator_id and a.context=q.context
 join public.sales_team_creator_balances_v1 c on c.receipt_id=q.receipt_id and c.creator_id=q.creator_id and c.sale_id=q.sale_id
 join public.sales_team_commission_balances_v1 b on b.receipt_id=q.receipt_id and b.creator_id=q.creator_id and b.sale_id=q.sale_id and b.membership_id=a.membership_id where q.id=p_request_id),0)::bigint
$$;
alter function creatornet_team_private.cash_encumbered_v1() rename to cash_encumbered_before_transfers_v1;
create function creatornet_team_private.cash_encumbered_v1()
returns numeric language sql stable security invoker set search_path=pg_catalog as $$
 select creatornet_team_private.cash_encumbered_before_transfers_v1()+coalesce((select sum(q.amount_cents::numeric-creatornet_team_private.transfer_unpaid_credit_v1(q.id)+reserved.cost_reserve_cents)
 from public.sales_team_transfer_cash_reservations_v1 reserved join public.sales_team_transfer_requests_v1 q on q.id=reserved.request_id
 where not exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id) and not exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id)),0)
$$;
create function public.begin_sales_team_settlement_cash_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_read_id uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 insert into public.sales_team_cash_reads_v1(id,actor_id,context,protection,settlement_worker_run_id) values(p_read_id,null,p_context,creatornet_team_private.cash_protection_v1(p_context),p_run_id);
end $$;
create function public.complete_sales_team_settlement_cash_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_read_id uuid,p_proof jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.sales_team_cash_reads_v1;begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select * into r from public.sales_team_cash_reads_v1 where id=p_read_id and settlement_worker_run_id=p_run_id;
 perform creatornet_team_private.financial_shape_v1(p_proof,'{"context":"object","availableCents":"number","firstRequestId":"string","secondRequestId":"string","readStartedAt":"number"}');
 if r.id is null or r.context is distinct from p_context or r.protection is distinct from creatornet_team_private.cash_protection_v1(p_context) or p_proof->'context' is distinct from p_context or
  (p_proof->>'readStartedAt')::numeric not between extract(epoch from r.created_at)*1000-5 and extract(epoch from clock_timestamp())*1000 or r.created_at<clock_timestamp()-interval '25 seconds' or
  p_proof->>'firstRequestId'!~'^req_[A-Za-z0-9]+$' or p_proof->>'secondRequestId'!~'^req_[A-Za-z0-9]+$' or p_proof->>'firstRequestId'=p_proof->>'secondRequestId' then raise exception 'FRESH_SETTLEMENT_CASH_REQUIRED';end if;
 insert into public.sales_team_cash_observations_v1(read_id,available_cents,proof) values(r.id,(p_proof->>'availableCents')::bigint,p_proof);
end $$;
create function public.reserve_sales_team_transfer_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid,p_request_id uuid,p_receipt_id uuid,p_beneficiary text,p_read_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;s jsonb;r public.sales_team_cash_reads_v1;v_protection jsonb;cost bigint;scope jsonb;begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 if p_task_id is null or p_request_id is null or p_receipt_id is null then raise exception 'TRANSFER_IDENTITIES_REQUIRED';end if;
 if (select count(*) from public.sales_team_settlement_tasks_v1 where run_id=p_run_id)>=3 and not exists(select 1 from public.sales_team_settlement_tasks_v1 where id=p_task_id and run_id=p_run_id) then raise exception 'SETTLEMENT_TASK_LIMIT_REQUIRED';end if;
 select * into q from public.sales_team_transfer_requests_v1 where id=p_request_id;
 if q.id is not null then
  if q.receipt_id is distinct from p_receipt_id or q.beneficiary is distinct from p_beneficiary or q.context is distinct from p_context then raise exception 'ORIGINAL_TRANSFER_REQUEST_CHANGED';end if;
 else
  if not exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_reservations_enabled) then raise exception 'TRANSFER_RESERVATIONS_HELD';end if;
  s:=creatornet_team_private.transfer_share_v1(p_receipt_id,p_beneficiary);
  if s is null or s->'context' is distinct from p_context then raise exception 'CURRENT_EARNED_TRANSFER_SOURCE_REQUIRED';end if;
  perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||(s->>'creatorId'),0));s:=creatornet_team_private.transfer_share_v1(p_receipt_id,p_beneficiary);
  if s is null then raise exception 'CURRENT_EARNED_TRANSFER_SOURCE_REQUIRED';end if;
  if exists(select 1 from public.sales_team_transfer_requests_v1 prior where prior.receipt_id=p_receipt_id and prior.beneficiary=p_beneficiary and
   not exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=prior.id) and not exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=prior.id)) then raise exception 'ORIGINAL_TRANSFER_REQUEST_REQUIRED';end if;
  if exists(select 1 from public.sales_team_cash_reservations_v1 reserved join public.sales_team_refund_requests_v1 refund on refund.id=reserved.request_id where refund.sale_id=(s->>'saleId')::uuid and reserved.retained_creator_cents+reserved.retained_commission_cents>0 and
   not exists(select 1 from public.sales_team_cash_resolutions_v1 done where done.operation_id=reserved.operation_id)) then raise exception 'ORIGINAL_RETAINED_RESERVATION_REQUIRED';end if;
  v_protection:=creatornet_team_private.cash_protection_v1(p_context);select transfer_cost_reserve_cents into cost from public.sales_team_cash_policy_v1 where singleton;
  select cash.* into r from public.sales_team_cash_reads_v1 cash where cash.id=p_read_id and cash.settlement_worker_run_id=p_run_id and cash.context=p_context and cash.protection=v_protection;
  if r.id is null or cost is null or r.created_at<clock_timestamp()-interval '25 seconds' or not exists(select 1 from public.sales_team_cash_observations_v1 where read_id=r.id) then raise exception 'FRESH_SETTLEMENT_CASH_REQUIRED';end if;
  if not coalesce(creatornet_team_private.cash_available_floor_v1(p_context,v_protection->'epoch')>=(v_protection->>'teamCents')::numeric+(v_protection->'shared'->>'protectedCents')::numeric+(v_protection->>'reserveCents')::numeric+creatornet_team_private.cash_encumbered_v1()+cost,false) then raise exception 'PROTECTED_PLATFORM_FUNDS_INSUFFICIENT';end if;
  if not exists(select 1 from public.sales_team_receipts_v1 receipt join public.sales_team_provider_operations_v1 intent on intent.provider_id=receipt.payment_intent_id and intent.kind='intent'
   where receipt.id=p_receipt_id and intent.sale_id=(s->>'saleId')::uuid and intent.context=p_context and intent.request->'params'->>'transfer_group'=s->>'transferGroup') then raise exception 'ORIGINAL_TRANSFER_GROUP_REQUIRED';end if;
  if (select coalesce(sum(prior.amount_cents),0) from public.sales_team_transfer_requests_v1 prior where prior.receipt_id=p_receipt_id and not exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=prior.id))+(s->>'amountCents')::bigint>
   (select subtotal_cents from public.sales_team_receipts_v1 where id=p_receipt_id) then raise exception 'ORIGINAL_CHARGE_TRANSFER_CAPACITY_REQUIRED';end if;
  insert into public.sales_team_transfer_requests_v1(id,operation_id,receipt_id,sale_id,creator_id,beneficiary,beneficiary_user_id,destination_id,amount_cents,receipt_revision,original_worker_run_id,context,request)
  values(p_request_id,public.sales_team_transfer_operation_id_v1(p_request_id),p_receipt_id,(s->>'saleId')::uuid,(s->>'creatorId')::uuid,p_beneficiary,(s->>'userId')::uuid,s->>'destinationId',(s->>'amountCents')::bigint,(s->>'revision')::integer,p_run_id,p_context,
   jsonb_build_object('apiVersion','2026-08-26.dahlia','method','POST','path','/v1/transfers','params',jsonb_build_object('amount',(s->>'amountCents')::bigint,'currency','usd','destination',s->>'destinationId','source_transaction',s->>'chargeId','source_type','card','transfer_group',s->>'transferGroup','metadata',jsonb_build_object('team_protocol','creatornet-team-distribution-v1','team_sale_id',s->>'saleId','team_receipt_id',p_receipt_id,'team_transfer_request_id',p_request_id,'team_provider_operation_id',public.sales_team_transfer_operation_id_v1(p_request_id),'team_beneficiary',p_beneficiary)))) returning * into q;
  insert into public.sales_team_transfer_cash_reservations_v1(request_id,read_id,cost_reserve_cents) values(q.id,r.id,cost);
 end if;
 if exists(select 1 from public.sales_team_settlement_tasks_v1 where id=p_task_id and (run_id<>p_run_id or request_id<>q.id)) then raise exception 'ORIGINAL_SETTLEMENT_TASK_CHANGED';end if;
 if exists(select 1 from public.sales_team_settlement_tasks_v1 where run_id=p_run_id and request_id=q.id and id<>p_task_id) then raise exception 'ORIGINAL_SETTLEMENT_TASK_CHANGED';end if;
 select * into r from public.sales_team_cash_reads_v1 where id=p_read_id and settlement_worker_run_id=p_run_id and context=p_context;
 if r.id is null or r.created_at<clock_timestamp()-interval '25 seconds' or r.protection is distinct from creatornet_team_private.cash_protection_v1(p_context) or not exists(select 1 from public.sales_team_cash_observations_v1 where read_id=r.id) then raise exception 'FRESH_SETTLEMENT_CASH_REQUIRED';end if;
 insert into public.sales_team_settlement_tasks_v1(id,run_id,request_id) values(p_task_id,p_run_id,q.id) on conflict(run_id,request_id) do nothing;
 insert into public.sales_team_transfer_cash_rechecks_v1(read_id,request_id,worker_run_id) values(r.id,q.id,p_run_id) on conflict(read_id) do nothing;
 return public.sales_team_transfer_request_json_v1(q.id);
end $$;
create function public.sales_team_transfer_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;s jsonb;protection jsonb;r public.sales_team_cash_reads_v1;begin
 select * into q from public.sales_team_transfer_requests_v1 where id=(p_scope->>'scopeId')::uuid and context=p_context;
 if q.id is null or p_scope is distinct from public.sales_team_transfer_request_json_v1(q.id)->'scope' or
  exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=q.id) or exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=q.id) or
  not exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled and transfer_reservations_enabled) or
  not exists(select 1 from public.sales_team_settlement_tasks_v1 task join public.sales_team_settlement_runs_v1 run on run.run_id=task.run_id join public.sales_team_worker_runs_v1 worker on worker.id=run.run_id
   join public.sales_team_cash_policy_v1 policy on policy.singleton where task.request_id=q.id and run.context=p_context and worker.kind='settlement' and worker.status='running' and worker.lease_until>clock_timestamp() and run.contract_sha256=policy.transfer_contract_sha256 and run.contract_sha256=creatornet_team_private.transfer_contract_digest_v1()) then return false;end if;
 s:=creatornet_team_private.transfer_share_v1(q.receipt_id,q.beneficiary);
 if s is null or s->>'destinationId' is distinct from q.destination_id or s->>'chargeId' is distinct from q.request->'params'->>'source_transaction' or (s->>'amountCents')::bigint<q.amount_cents then return false;end if;
 protection:=creatornet_team_private.cash_protection_v1(p_context);
 select reads.* into r from public.sales_team_transfer_cash_rechecks_v1 checked join public.sales_team_cash_reads_v1 reads on reads.id=checked.read_id
  join public.sales_team_worker_runs_v1 worker on worker.id=checked.worker_run_id where checked.request_id=q.id and reads.settlement_worker_run_id=checked.worker_run_id and worker.kind='settlement' and worker.status='running' and worker.lease_until>clock_timestamp() order by reads.created_at desc,reads.id desc limit 1;
 if r.id is null or r.protection is distinct from protection or r.created_at<clock_timestamp()-interval '25 seconds' then return false;end if;
 if not exists(select 1 from public.sales_team_transfer_cash_reservations_v1 reserved join public.sales_team_cash_policy_v1 policy on policy.singleton where reserved.request_id=q.id and reserved.cost_reserve_cents=policy.transfer_cost_reserve_cents) then return false;end if;
 return coalesce(creatornet_team_private.cash_available_floor_v1(p_context,protection->'epoch')>=(protection->>'teamCents')::numeric+(protection->'shared'->>'protectedCents')::numeric+(protection->>'reserveCents')::numeric+creatornet_team_private.cash_encumbered_v1(),false);
end $$;
create function public.cancel_unsent_sales_team_transfer_v1(p_run_id uuid,p_lease_token uuid,p_context jsonb,p_task_id uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;begin
 perform creatornet_team_private.settlement_worker_v1(p_run_id,p_lease_token,p_context);perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
 select original.* into q from public.sales_team_settlement_tasks_v1 task join public.sales_team_transfer_requests_v1 original on original.id=task.request_id where task.id=p_task_id and task.run_id=p_run_id and original.context=p_context;
 if q.id is null then raise exception 'ORIGINAL_TRANSFER_REQUEST_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||q.creator_id::text,0));
 if exists(select 1 from public.sales_team_provider_operations_v1 where id=q.operation_id) then raise exception 'ORIGINAL_TRANSFER_RECOVERY_REQUIRED';end if;
 insert into public.sales_team_transfer_cancellations_v1(request_id,worker_run_id,reason) values(q.id,p_run_id,'not_dispatched') on conflict(request_id) do nothing;
 if found then update public.sales_team_cash_epoch_v1 set epoch=epoch+1 where singleton;end if;
end $$;
-- Preserve existing journals; only the exact reserved transfer kind is admitted.
alter function public.claim_sales_team_provider_operation_v1(uuid,jsonb,jsonb,jsonb) rename to claim_sales_team_operation_before_transfer_v1;
create function public.claim_sales_team_provider_operation_v1(p_operation_id uuid,p_scope jsonb,p_context jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if p_scope->>'kind'='transfer' then
  perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));
  if not exists(select 1 from public.sales_team_transfer_requests_v1 where operation_id=p_operation_id and request=p_request and context=p_context and public.sales_team_transfer_request_json_v1(id)->'scope'=p_scope) then raise exception 'ORIGINAL_EARNED_TRANSFER_REQUIRED';end if;
 end if;
 return public.claim_sales_team_operation_before_transfer_v1(p_operation_id,p_scope,p_context,p_request);
end $$;
alter function public.assert_sales_team_provider_dispatch_v1(uuid,uuid) rename to assert_sales_team_dispatch_before_transfer_v1;
create function public.assert_sales_team_provider_dispatch_v1(p_operation_id uuid,p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if exists(select 1 from public.sales_team_provider_operations_v1 where id=p_operation_id and kind='transfer') then perform pg_advisory_xact_lock(hashtextextended('creatornet-platform-cash-v1',0));end if;
 return public.assert_sales_team_dispatch_before_transfer_v1(p_operation_id,p_lease_token);
end $$;
create or replace function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select case when p_scope->>'kind'='transfer' then public.sales_team_transfer_operation_admitted_v1(p_scope,p_context) when p_scope->>'kind' in ('withdrawal','reversal') then false else public.sales_team_operation_admitted_before_cash_v1(p_scope,p_context) end
$$;
do $guards$ declare src text;needle text;begin
 src:=replace(pg_get_functiondef('creatornet_team_private.refund_retained_cash_plan_v1(uuid)'::regprocedure),chr(13)||chr(10),chr(10));needle:='bps:=(a.terms->''commission''->>''commissionBps'')::integer;';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_RETAINED_PLAN_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'if exists(select 1 from public.sales_team_transfer_requests_v1 pending join public.sales_team_transfer_cash_reservations_v1 reserved on reserved.request_id=pending.id where pending.sale_id=a.id and not exists(select 1 from public.sales_team_transfer_cancellations_v1 where request_id=pending.id) and not exists(select 1 from public.sales_team_transfer_completions_v1 where request_id=pending.id)) then return jsonb_build_object(''creatorCents'',0,''commissionCents'',0,''creatorFloorCents'',0,''commissionFloorCents'',0,''evidence'',jsonb_build_object(''scope'',''pending_original_transfer''));end if;'||needle);
 src:=pg_get_functiondef('creatornet_team_private.cash_protection_v1(jsonb)'::regprocedure);needle:='''policyRevision'',policy.revision';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_CASH_POLICY_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,'''transferContractSha256'',policy.transfer_contract_sha256,''transferCostReserveCents'',policy.transfer_cost_reserve_cents,'||needle);
 src:=pg_get_functiondef('creatornet_team_private.shared_cash_contract_digest_v1()'::regprocedure);needle:='''refund_retained_cash_plan_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_SHARED_DIGEST_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||',''cash_encumbered_before_transfers_v1'',''transfer_unpaid_credit_v1''');
 src:=pg_get_functiondef('creatornet_team_private.retained_cash_contract_digest_v1()'::regprocedure);needle:='''cash_encumbered_v1''';
 if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then raise exception 'TRANSFER_RETAINED_DIGEST_DEPENDENCY_DIFFERS';end if;
 execute replace(src,needle,needle||',''cash_encumbered_before_transfers_v1'',''transfer_unpaid_credit_v1''');
end $guards$;
do $grants$ declare name text;sig regprocedure;begin
 foreach name in array array['sales_team_settlement_runs_v1','sales_team_settlement_tasks_v1','sales_team_transfer_requests_v1','sales_team_transfer_cash_reservations_v1','sales_team_transfer_cash_rechecks_v1','sales_team_transfer_cancellations_v1','sales_team_transfer_completions_v1'] loop
  execute format('alter table public.%I enable row level security',name);execute format('revoke all on public.%I from public,anon,authenticated',name);execute format('grant select on public.%I to service_role',name);
  if name<>'sales_team_transfer_completions_v1' then execute format('grant insert on public.%I to service_role',name);end if;
  execute format('create trigger immutable_transfer_history before update or delete on public.%I for each row execute function creatornet_team_private.reject_history_change()',name);
 end loop;
 for sig in select oid::regprocedure from pg_proc where
 (pronamespace='public'::regnamespace and proname in ('claim_sales_team_settlement_run_v1','begin_sales_team_settlement_cash_v1','complete_sales_team_settlement_cash_v1','reserve_sales_team_transfer_v1','cancel_unsent_sales_team_transfer_v1','sales_team_transfer_request_json_v1','sales_team_transfer_operation_admitted_v1','sales_team_operation_admitted_v1','claim_sales_team_provider_operation_v1','claim_sales_team_operation_before_transfer_v1','assert_sales_team_provider_dispatch_v1','assert_sales_team_dispatch_before_transfer_v1','sales_team_transfer_operation_id_v1')) or
 (pronamespace='creatornet_team_private'::regnamespace and proname in ('transfer_contract_digest_v1','settlement_worker_v1','transfer_share_v1','transfer_unpaid_credit_v1','cash_encumbered_v1','cash_encumbered_before_transfers_v1')) loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $grants$;
commit;
