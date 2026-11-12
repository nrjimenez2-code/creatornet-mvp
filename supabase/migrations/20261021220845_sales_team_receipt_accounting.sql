-- Verified-receipt accounting only. Local candidate; no provider dispatch.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';

alter table public.sales_team_receipts_v1 add column observation_revision integer not null default 1;
alter table public.sales_team_receipts_v1 add column platform_fee_return_cents bigint check(platform_fee_return_cents>=0);
alter table public.sales_team_receipts_v1 add column platform_processing_credit_cents bigint not null default 0 check(platform_processing_credit_cents>=0);
comment on column public.sales_team_receipts_v1.confirmed_loss_subtotal_cents is
 'Independently reconciled combined sale-subtotal loss, including any overlap with refunds. Never add this to refunded_subtotal_cents.';
create table public.sales_team_creator_balances_v1 (
 receipt_id uuid primary key references public.sales_team_receipts_v1(id) on delete restrict,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 platform_revenue_cents bigint not null check(platform_revenue_cents>=0),
 creator_proceeds_cents bigint not null check(creator_proceeds_cents>=0),
 creator_released_cents bigint not null default 0 check(creator_released_cents>=0),
 creator_reversed_cents bigint not null default 0 check(creator_reversed_cents between 0 and creator_released_cents),
 processing_reserve_cents bigint not null check(processing_reserve_cents>=0),
 payout_cost_reserve_cents bigint not null check(payout_cost_reserve_cents>=0),
 actual_processing_cost_cents bigint not null check(actual_processing_cost_cents>=0),
 platform_processing_credit_cents bigint not null default 0 check(platform_processing_credit_cents>=0),
 creator_deficit_cents bigint not null check(creator_deficit_cents>=0),
 tax_reserve_cents bigint not null check(tax_reserve_cents>=0),
 updated_at timestamptz not null default now()
);
create table public.sales_team_financial_observations_v1 (
 id uuid primary key default gen_random_uuid(),
 receipt_id uuid not null references public.sales_team_receipts_v1(id) on delete restrict,
 source_identity text not null,
 proof jsonb not null,
 created_at timestamptz not null default now(),
 unique(receipt_id,source_identity)
);

create function public.initialize_sales_team_payment_v1(p_sale_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_sale public.sales_team_sale_agreements_v1;v_obligation public.sales_team_payment_obligations_v1;v_amount integer;
begin
 select * into v_sale from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if v_sale.id is null then raise exception 'OWNED_SALE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||v_sale.creator_id::text,0));
 select * into v_obligation from public.sales_team_payment_obligations_v1 where sale_id=p_sale_id and period_number=1;
 if v_obligation.id is not null then return to_jsonb(v_obligation); end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and new_sales_enabled) then raise exception 'TEAM_SALES_DISABLED'; end if;
 v_amount:=(v_sale.terms->'payments'->0->>'amountCents')::integer;
 insert into public.sales_team_payment_runtime_v1(sale_id) values(p_sale_id) on conflict(sale_id) do nothing;
 insert into public.sales_team_payment_obligations_v1(id,sale_id,period_number,amount_cents,due_at)
 values(gen_random_uuid(),p_sale_id,1,v_amount,v_sale.accepted_at) returning * into v_obligation;
 return to_jsonb(v_obligation);
end $$;

create function public.recompute_sales_team_balances_v1(p_sale_id uuid,p_source_identity text,p_evidence jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare v_sale public.sales_team_sale_agreements_v1;v_receipt record;v_old public.sales_team_creator_balances_v1;v_old_comm public.sales_team_commission_balances_v1;
 v_net bigint;v_cumulative bigint:=0;v_previous bigint:=0;v_commission bigint;v_platform bigint;v_cost bigint;v_reserve bigint;v_payout_reserve bigint;
 v_creator bigint;v_deficit bigint;v_bps integer;v_eligible boolean;v_values jsonb;v_old_values jsonb;v_key text;v_delta bigint;v_member uuid;v_credit bigint;
begin
 select * into v_sale from public.sales_team_sale_agreements_v1 where id=p_sale_id;
 if v_sale.id is null then raise exception 'SALE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||v_sale.creator_id::text,0));
 v_bps:=(v_sale.terms->'commission'->>'commissionBps')::integer;v_member:=v_sale.membership_id;
 for v_receipt in select r.*,o.period_number from public.sales_team_receipts_v1 r join public.sales_team_payment_obligations_v1 o on o.id=r.obligation_id
  where r.sale_id=p_sale_id order by o.period_number,r.id loop
  v_net:=v_receipt.subtotal_cents-greatest(v_receipt.refunded_subtotal_cents,v_receipt.confirmed_loss_subtotal_cents);
  v_eligible:=v_sale.terms->>'paymentKind'<>'monthly' or v_sale.terms->'commission'->>'renewals'='every_renewal' or
   v_receipt.period_number<=coalesce((v_sale.terms->>'initialCommitmentMonths')::integer,1);
  if v_eligible then
   v_cumulative:=v_cumulative+v_net;v_commission:=floor((v_cumulative::numeric*v_bps+5000)/10000)::bigint-v_previous;
   v_previous:=v_previous+v_commission;
  else v_commission:=0;end if;
  v_platform:=floor((v_receipt.subtotal_cents::numeric*1200+5000)/10000)::bigint-coalesce(v_receipt.platform_fee_return_cents,0);
  v_reserve:=case when v_receipt.processing_cost_cents is null and v_sale.terms->'distribution'->'processingFees'->'enabled'='true'::jsonb then
    floor((v_receipt.subtotal_cents::numeric*(v_sale.terms->'distribution'->'processingFees'->>'basisPoints')::integer+5000)/10000)::bigint+
    (v_sale.terms->'distribution'->'processingFees'->>'fixedCents')::integer else 0 end;
  v_cost:=coalesce(v_receipt.processing_cost_cents,0);v_payout_reserve:=(v_sale.terms->'distribution'->>'payoutCostEstimateCents')::bigint;
  v_credit:=v_receipt.platform_processing_credit_cents;
  v_creator:=greatest(0,v_net-v_platform-v_commission-v_cost+v_credit-v_reserve-v_payout_reserve);
  v_deficit:=greatest(0,v_platform+v_commission+v_cost-v_credit+v_reserve+v_payout_reserve-v_net);
  select * into v_old from public.sales_team_creator_balances_v1 where receipt_id=v_receipt.id for update;
  select * into v_old_comm from public.sales_team_commission_balances_v1 where receipt_id=v_receipt.id for update;
  v_values:=jsonb_build_object('platform_revenue',v_platform,'commission_earned',v_commission,'creator_proceeds',v_creator,'creator_deficit',v_deficit,
    'processing_reserve',v_reserve,'processing_cost',v_cost,'platform_processing_credit',v_credit,'payout_cost_reserve',v_payout_reserve,'tax_reserve',v_receipt.tax_cents);
  v_old_values:=jsonb_build_object('platform_revenue',coalesce(v_old.platform_revenue_cents,0),'commission_earned',coalesce(v_old_comm.earned_cents,0),
   'creator_proceeds',coalesce(v_old.creator_proceeds_cents,0),'creator_deficit',coalesce(v_old.creator_deficit_cents,0),
   'processing_reserve',coalesce(v_old.processing_reserve_cents,0),'processing_cost',coalesce(v_old.actual_processing_cost_cents,0),
   'platform_processing_credit',coalesce(v_old.platform_processing_credit_cents,0),'payout_cost_reserve',coalesce(v_old.payout_cost_reserve_cents,0),'tax_reserve',coalesce(v_old.tax_reserve_cents,0));
  for v_key in select jsonb_object_keys(v_values) loop
   v_delta:=(v_values->>v_key)::bigint-(v_old_values->>v_key)::bigint;
   if v_delta<>0 then insert into public.sales_team_financial_ledger_v1(creator_id,sale_id,membership_id,receipt_id,entry_kind,amount_cents,source_identity,evidence)
    values(v_sale.creator_id,p_sale_id,case when v_key='commission_earned' then v_member end,v_receipt.id,
     case when v_key='commission_earned' and v_old_comm.receipt_id is not null then 'commission_adjustment' else v_key end,v_delta,
     p_source_identity||':'||v_receipt.id::text,p_evidence);end if;
  end loop;
  insert into public.sales_team_creator_balances_v1(receipt_id,sale_id,creator_id,platform_revenue_cents,creator_proceeds_cents,processing_reserve_cents,
   payout_cost_reserve_cents,actual_processing_cost_cents,platform_processing_credit_cents,creator_deficit_cents,tax_reserve_cents)
  values(v_receipt.id,p_sale_id,v_sale.creator_id,v_platform,v_creator,v_reserve,v_payout_reserve,v_cost,v_credit,v_deficit,v_receipt.tax_cents)
  on conflict(receipt_id) do update set platform_revenue_cents=excluded.platform_revenue_cents,creator_proceeds_cents=excluded.creator_proceeds_cents,
   processing_reserve_cents=excluded.processing_reserve_cents,payout_cost_reserve_cents=excluded.payout_cost_reserve_cents,
   actual_processing_cost_cents=excluded.actual_processing_cost_cents,platform_processing_credit_cents=excluded.platform_processing_credit_cents,creator_deficit_cents=excluded.creator_deficit_cents,tax_reserve_cents=excluded.tax_reserve_cents,updated_at=clock_timestamp();
  insert into public.sales_team_commission_balances_v1(receipt_id,sale_id,creator_id,membership_id,earned_cents,hold_until)
  values(v_receipt.id,p_sale_id,v_sale.creator_id,v_member,v_commission,v_receipt.paid_at+make_interval(days=>(v_sale.terms->'commission'->>'holdDays')::integer))
  on conflict(receipt_id) do update set earned_cents=excluded.earned_cents,updated_at=clock_timestamp();
 end loop;
end $$;

create function public.record_sales_team_receipt_v1(p_obligation_id uuid,p_payment_intent_id text,p_charge_id text,p_paid_at timestamptz,
 p_balance_transaction_id text,p_processing_cost_cents bigint,p_available_on timestamptz,p_source_identity text,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_obligation public.sales_team_payment_obligations_v1;v_sale public.sales_team_sale_agreements_v1;v_op public.sales_team_provider_operations_v1;v_receipt public.sales_team_receipts_v1;v_key text;
begin
 select * into v_obligation from public.sales_team_payment_obligations_v1 where id=p_obligation_id;
 select * into v_sale from public.sales_team_sale_agreements_v1 where id=v_obligation.sale_id;
 if v_sale.id is null then raise exception 'RECEIPT_SALE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||v_sale.creator_id::text,0));
 select * into v_obligation from public.sales_team_payment_obligations_v1 where id=p_obligation_id for update;
 select * into v_op from public.sales_team_provider_operations_v1 where id=v_obligation.intent_operation_id;
 if v_op.id is null or v_op.kind<>'intent' or v_op.status<>'bound' or v_op.sale_id<>v_sale.id or v_op.provider_id is distinct from p_payment_intent_id or
  v_op.context is distinct from v_sale.context or v_op.request->>'path' is distinct from '/v1/payment_intents' or
  v_op.request->'params'->'metadata'->>'team_obligation_id' is distinct from p_obligation_id::text or
  v_op.request->'params'->'metadata'->>'team_sale_id' is distinct from v_sale.id::text or
  (v_op.request->'params'->>'amount')::bigint is distinct from v_obligation.amount_cents::bigint or
  p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$' or p_charge_id !~ '^ch_[A-Za-z0-9]+$' or p_paid_at is null or
  p_paid_at<v_sale.accepted_at-interval '5 seconds' or p_paid_at>clock_timestamp()+interval '5 seconds' or
  p_proof->>'protocol' is distinct from 'creatornet-team-distribution-v1' or p_proof->'context' is distinct from v_sale.context or
  p_proof->>'paymentIntentId' is distinct from p_payment_intent_id or p_proof->>'chargeId' is distinct from p_charge_id or
  p_proof->>'saleId' is distinct from v_sale.id::text or p_proof->>'obligationId' is distinct from p_obligation_id::text or
  p_proof->>'currency' is distinct from 'usd' or p_proof->'paid' is distinct from 'true'::jsonb or p_proof->'captured' is distinct from 'true'::jsonb or
  (p_proof->>'subtotalCents')::bigint is distinct from v_obligation.amount_cents::bigint or p_proof->>'taxCents' is distinct from '0' or
  (p_proof->>'paidAt')::bigint is distinct from extract(epoch from p_paid_at)::bigint or
  p_proof->>'balanceTransactionId' is distinct from p_balance_transaction_id or
  (p_proof->>'processingCostCents')::bigint is distinct from p_processing_cost_cents or
  to_timestamp((p_proof->>'availableOn')::double precision) is distinct from p_available_on or
  jsonb_typeof(p_proof->'disputed') is distinct from 'boolean' or
  coalesce(p_proof->>'metadataHash','') !~ '^[a-f0-9]{64}$' or coalesce(p_proof->>'providerRequestId','') !~ '^req_[A-Za-z0-9]+$' or
  (p_processing_cost_cents is not null and (p_processing_cost_cents<0 or p_balance_transaction_id is null or p_available_on is null)) then raise exception 'VERIFIED_TEAM_RECEIPT_REQUIRED'; end if;
 for v_key in select jsonb_object_keys(p_proof) loop
  if v_key not in ('protocol','context','paymentIntentId','chargeId','obligationId','saleId','currency','paid','captured','subtotalCents','taxCents',
    'paidAt','balanceTransactionId','processingCostCents','availableOn','refundedCents','disputed','providerRequestId','metadataHash') then raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;
 end loop;
 select * into v_receipt from public.sales_team_receipts_v1 where obligation_id=p_obligation_id;
 if v_receipt.id is not null then
  if v_receipt.payment_intent_id<>p_payment_intent_id or v_receipt.charge_id<>p_charge_id or v_receipt.subtotal_cents<>v_obligation.amount_cents then raise exception 'ORIGINAL_RECEIPT_CHANGED';end if;
  return to_jsonb(v_receipt);
 end if;
 insert into public.sales_team_receipts_v1(sale_id,obligation_id,payment_intent_id,charge_id,balance_transaction_id,subtotal_cents,tax_cents,processing_cost_cents,
  paid_at,available_on,source_event_id,proof,review_hold)
 values(v_sale.id,p_obligation_id,p_payment_intent_id,p_charge_id,p_balance_transaction_id,v_obligation.amount_cents,0,p_processing_cost_cents,
  p_paid_at,p_available_on,p_source_identity,p_proof,coalesce((p_proof->>'refundedCents')::bigint,0)>0 or coalesce((p_proof->>'disputed')::boolean,false)) returning * into v_receipt;
 insert into public.sales_team_financial_observations_v1(receipt_id,source_identity,proof) values(v_receipt.id,p_source_identity,p_proof);
 update public.sales_team_payment_obligations_v1 set status='paid',paid_at=p_paid_at where id=p_obligation_id;
 update public.sales_team_payment_runtime_v1 set anchor_at=case when v_obligation.period_number=1 then coalesce(anchor_at,p_paid_at) else anchor_at end,
  covered_periods=case when v_obligation.period_number=covered_periods+1 then v_obligation.period_number else covered_periods end,updated_at=clock_timestamp() where sale_id=v_sale.id;
 perform public.recompute_sales_team_balances_v1(v_sale.id,'receipt:'||v_receipt.id::text,p_proof);
 return to_jsonb(v_receipt);
end $$;

create function public.reconcile_sales_team_receipt_v1(p_receipt_id uuid,p_expected_revision integer,p_source_identity text,p_refunded_cents bigint,
 p_total_loss_cents bigint,p_dispute_hold boolean,p_review_hold boolean,p_processing_cost_cents bigint,p_balance_transaction_id text,p_available_on timestamptz,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_receipt public.sales_team_receipts_v1;v_creator uuid;v_key text;
begin
 select a.creator_id into v_creator from public.sales_team_receipts_v1 r join public.sales_team_sale_agreements_v1 a on a.id=r.sale_id where r.id=p_receipt_id;
 if v_creator is null then raise exception 'RECEIPT_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||v_creator::text,0));
 select * into v_receipt from public.sales_team_receipts_v1 where id=p_receipt_id for update;
 if exists(select 1 from public.sales_team_financial_observations_v1 where receipt_id=p_receipt_id and source_identity=p_source_identity) then return to_jsonb(v_receipt);end if;
 if v_receipt.observation_revision is distinct from p_expected_revision then raise exception 'FINANCIAL_OBSERVATION_STALE';end if;
 if p_refunded_cents is null or p_total_loss_cents is null or p_refunded_cents<v_receipt.refunded_subtotal_cents or p_refunded_cents>v_receipt.subtotal_cents or
  p_total_loss_cents<p_refunded_cents or p_total_loss_cents>v_receipt.subtotal_cents or p_dispute_hold is null or p_review_hold is null or
  (p_processing_cost_cents is not null and (p_processing_cost_cents<0 or p_balance_transaction_id is null or p_available_on is null)) or
  (v_receipt.processing_cost_cents is not null and (p_processing_cost_cents is distinct from v_receipt.processing_cost_cents or p_balance_transaction_id is distinct from v_receipt.balance_transaction_id)) or
  p_proof->'context' is distinct from (select context from public.sales_team_sale_agreements_v1 where id=v_receipt.sale_id) or
  (p_proof->>'refundedCents')::bigint is distinct from p_refunded_cents or (p_proof->>'totalLossCents')::bigint is distinct from p_total_loss_cents or
  (p_proof->>'disputeHold')::boolean is distinct from p_dispute_hold or (p_proof->>'reviewHold')::boolean is distinct from p_review_hold or
  p_proof->>'platformFeeReturnedCents' is null or (p_proof->>'platformFeeReturnedCents')::bigint not between 0 and floor((v_receipt.subtotal_cents::numeric*1200+5000)/10000)::bigint or
  p_proof->>'platformProcessingCostCreditCents' is null or (p_proof->>'platformProcessingCostCreditCents')::bigint not between 0 and coalesce(p_processing_cost_cents,0) or
  p_proof->>'chargeId' is distinct from v_receipt.charge_id or p_proof->>'paymentIntentId' is distinct from v_receipt.payment_intent_id then raise exception 'VERIFIED_FINANCIAL_RECONCILIATION_REQUIRED';end if;
 for v_key in select jsonb_object_keys(p_proof) loop
  if v_key not in ('context','chargeId','paymentIntentId','refundedCents','totalLossCents','disputeHold','reviewHold','platformFeeReturnedCents',
   'platformProcessingCostCreditCents','alerts','refundIds','decisionIds','disputeId','disputeStatus','providerEvidenceIds','sourceEventId','providerRequestIds') then
   raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;
 end loop;
 update public.sales_team_receipts_v1 set refunded_subtotal_cents=p_refunded_cents,confirmed_loss_subtotal_cents=p_total_loss_cents,
  dispute_hold=p_dispute_hold,review_hold=p_review_hold,processing_cost_cents=p_processing_cost_cents,balance_transaction_id=p_balance_transaction_id,
  platform_fee_return_cents=(p_proof->>'platformFeeReturnedCents')::bigint,platform_processing_credit_cents=(p_proof->>'platformProcessingCostCreditCents')::bigint,
  available_on=p_available_on,observation_revision=observation_revision+1,observed_at=clock_timestamp() where id=p_receipt_id returning * into v_receipt;
 insert into public.sales_team_financial_observations_v1(receipt_id,source_identity,proof) values(p_receipt_id,p_source_identity,p_proof);
 perform public.recompute_sales_team_balances_v1(v_receipt.sale_id,'observation:'||p_source_identity,p_proof);
 return to_jsonb(v_receipt);
end $$;

do $$ declare v_name text;v_sig regprocedure;begin
 foreach v_name in array array['sales_team_creator_balances_v1','sales_team_financial_observations_v1'] loop
  execute format('alter table public.%I enable row level security',v_name);execute format('revoke all on public.%I from public,anon,authenticated',v_name);
  execute format('grant select,insert,update on public.%I to service_role',v_name);
 end loop;
 for v_sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
  ('initialize_sales_team_payment_v1','recompute_sales_team_balances_v1','record_sales_team_receipt_v1','reconcile_sales_team_receipt_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',v_sig);execute format('grant execute on function %s to service_role',v_sig);
 end loop;
end $$;
revoke update on public.sales_team_financial_observations_v1 from service_role;
create trigger sales_team_observation_immutable_v1 before update or delete on public.sales_team_financial_observations_v1 for each row execute function creatornet_team_private.reject_history_change();
commit;
