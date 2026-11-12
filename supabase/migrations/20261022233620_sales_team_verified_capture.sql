-- Local-only receipt recovery. Does not authorize new provider activity.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
-- Dispatch time is the admission instant, even inside a longer transaction.
-- Preserve every existing operation timestamp and original request identity.
alter table public.sales_team_provider_operations_v1 alter column first_dispatch_at set default clock_timestamp();
alter table public.sales_team_controls_v1 add column receipt_recording_enabled boolean not null default false;
create table public.sales_team_capture_provenance_v1 (
 receipt_id uuid primary key references public.sales_team_receipts_v1(id) on delete restrict,
 obligation_id uuid not null unique references public.sales_team_payment_attempts_v1(obligation_id) on delete restrict,
 confirmation_operation_id uuid not null references public.sales_team_provider_operations_v1(id) on delete restrict,
 readback jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create function public.read_sales_team_capture_source_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;t public.sales_team_payment_attempts_v1;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 select t0.* into t from public.sales_team_payment_attempts_v1 t0 join public.sales_team_payment_obligations_v1 o on o.id=t0.obligation_id
  where t0.sale_id=a.id and (case when p_obligation_id is null then o.period_number=1 else o.id=p_obligation_id end);
 if t.obligation_id is null then return null;end if;
 return jsonb_build_object('contract',t.contract,'intent',(select to_jsonb(o) from public.sales_team_provider_operations_v1 o where id=t.intent_operation_id),
  'firstConfirmationDispatchAt',(select min(op.first_dispatch_at) from public.sales_team_payment_confirmations_v1 c join public.sales_team_provider_operations_v1 op on op.id=c.operation_id where c.obligation_id=t.obligation_id),
  'confirmation',(select to_jsonb(c)||jsonb_build_object('operation',(select to_jsonb(op) from public.sales_team_provider_operations_v1 op where op.id=c.operation_id))
   from public.sales_team_payment_confirmations_v1 c where c.obligation_id=t.obligation_id order by c.step_number desc limit 1),
  'receipt',(select to_jsonb(r) from public.sales_team_receipts_v1 r where obligation_id=t.obligation_id));
end $$;

create function public.record_verified_sales_team_capture_v1(p_sale_id uuid,p_buyer_id uuid,p_obligation_id uuid,p_confirmation_id uuid,p_capture jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;t public.sales_team_payment_attempts_v1;c public.sales_team_payment_confirmations_v1;o public.sales_team_provider_operations_v1;
 r public.sales_team_receipts_v1;v public.sales_team_capture_provenance_v1;receipt_proof jsonb:=p_capture->'receipt';rb jsonb:=p_capture->'readback';result jsonb;cost_proof jsonb;k text;
begin
 if jsonb_typeof(p_capture) is distinct from 'object' or jsonb_typeof(receipt_proof) is distinct from 'object' or jsonb_typeof(rb) is distinct from 'object' or
  exists(select 1 from jsonb_object_keys(p_capture) key where key not in ('receipt','readback')) then raise exception 'ORIGINAL_TEAM_CAPTURE_REQUIRED';end if;
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into t from public.sales_team_payment_attempts_v1 where obligation_id=p_obligation_id and sale_id=a.id;
 select * into c from public.sales_team_payment_confirmations_v1 where operation_id=p_confirmation_id and obligation_id=t.obligation_id;
 select * into o from public.sales_team_provider_operations_v1 where id=c.operation_id;
 select * into r from public.sales_team_receipts_v1 where obligation_id=t.obligation_id;
 if t.obligation_id is null or c.operation_id is null or o.status is distinct from 'bound' or o.kind<>'confirmation' or
  o.context is distinct from a.context or o.sale_id is distinct from a.id or o.actor_id is distinct from a.buyer_id or o.creator_id is distinct from a.creator_id or
  o.provider_id is distinct from receipt_proof->>'paymentIntentId' or o.request is distinct from c.request or c.token_proof->>'country' is distinct from 'US' or
  coalesce(c.token_proof->>'previewHash','')!~'^[a-f0-9]{64}$' or
  (select min(op.first_dispatch_at) from public.sales_team_payment_confirmations_v1 c0 join public.sales_team_provider_operations_v1 op on op.id=c0.operation_id where c0.obligation_id=t.obligation_id)>to_timestamp((receipt_proof->>'paidAt')::bigint)+interval '5 seconds' or
  o.first_dispatch_at>clock_timestamp() or o.first_dispatch_at>=to_timestamp((t.contract->>'expiresAt')::bigint) or
  coalesce(rb->>'intentRequestId','')!~'^req_[A-Za-z0-9]+$' or rb->>'chargeRequestId' is distinct from receipt_proof->>'providerRequestId' or
  (receipt_proof->>'processingCostCents' is not null and coalesce(rb->>'balanceRequestId','')!~'^req_[A-Za-z0-9]+$') or
  coalesce((rb->>'readStartedAt')::bigint,0)<extract(epoch from clock_timestamp())*1000-60000 or
  coalesce((rb->>'observedAt')::bigint,0)<extract(epoch from clock_timestamp())-30 or (rb->>'observedAt')::bigint>extract(epoch from clock_timestamp())+1 then raise exception 'ORIGINAL_TEAM_CAPTURE_REQUIRED';end if;
 for k in select jsonb_object_keys(rb) loop if k not in ('intentRequestId','chargeRequestId','balanceRequestId','readStartedAt','observedAt') then raise exception 'PRIVATE_PROVIDER_DATA_NOT_ALLOWED';end if;end loop;
 if r.id is null and not exists(select 1 from public.sales_team_controls_v1 where singleton and receipt_recording_enabled) then raise exception 'TEAM_RECEIPT_RECORDING_HELD';end if;
 result:=public.record_sales_team_receipt_v1(t.obligation_id,receipt_proof->>'paymentIntentId',receipt_proof->>'chargeId',to_timestamp((receipt_proof->>'paidAt')::bigint),
  receipt_proof->>'balanceTransactionId',(receipt_proof->>'processingCostCents')::bigint,to_timestamp((receipt_proof->>'availableOn')::double precision),'capture:'||t.obligation_id::text,receipt_proof);
 select * into r from public.sales_team_receipts_v1 where id=(result->>'id')::uuid;
 select * into v from public.sales_team_capture_provenance_v1 where receipt_id=r.id;
 if v.receipt_id is not null and v.confirmation_operation_id<>p_confirmation_id then raise exception 'ORIGINAL_TEAM_CAPTURE_CHANGED';end if;
 if coalesce((receipt_proof->>'refundedCents')::bigint,-1) not between r.refunded_subtotal_cents and r.subtotal_cents then raise exception 'TEAM_REFUND_OBSERVATION_STALE';end if;
 if (receipt_proof->>'refundedCents')::bigint>r.refunded_subtotal_cents or v.receipt_id is null and (receipt_proof->>'disputed')::boolean then
  -- Known refunded principal is excluded immediately. Responsibility and any
  -- dispute loss still need the complete independent financial observation.
  update public.sales_team_receipts_v1 set refunded_subtotal_cents=(receipt_proof->>'refundedCents')::bigint,
   confirmed_loss_subtotal_cents=greatest(confirmed_loss_subtotal_cents,(receipt_proof->>'refundedCents')::bigint),
   dispute_hold=dispute_hold or (v.receipt_id is null and (receipt_proof->>'disputed')::boolean),review_hold=true,observation_revision=observation_revision+1 where id=r.id;
  insert into public.sales_team_financial_observations_v1(receipt_id,source_identity,proof)
  values(r.id,'capture-financial:'||(receipt_proof->>'refundedCents')||':'||(receipt_proof->>'disputed'),receipt_proof) on conflict(receipt_id,source_identity) do nothing;
  perform public.recompute_sales_team_balances_v1(a.id,'capture-financial:'||(receipt_proof->>'refundedCents')||':'||(receipt_proof->>'disputed'),receipt_proof);
  select * into r from public.sales_team_receipts_v1 where id=r.id;result:=to_jsonb(r);
 end if;
 if v.receipt_id is null then
  -- The minimum hold starts no earlier than independently verified capture.
  -- Later cost/refund observations cannot reset this original saved hold.
  update public.sales_team_commission_balances_v1 set hold_until=greatest(hold_until,clock_timestamp()+make_interval(days=>(a.terms->'commission'->>'holdDays')::integer)) where receipt_id=r.id;
 end if;
 insert into public.sales_team_capture_provenance_v1(receipt_id,obligation_id,confirmation_operation_id,readback)
 values(r.id,t.obligation_id,p_confirmation_id,rb) on conflict(receipt_id) do nothing;
 if r.processing_cost_cents is null and receipt_proof->>'processingCostCents' is not null then
  -- Pure late-cost recovery cannot clear any already recorded financial hold.
  if r.refunded_subtotal_cents<>0 or r.confirmed_loss_subtotal_cents<>0 or r.dispute_hold or r.review_hold or
   coalesce((receipt_proof->>'refundedCents')::bigint,0)<>0 or (receipt_proof->>'disputed')::boolean is distinct from false then raise exception 'TEAM_FINANCIAL_RECONCILIATION_REQUIRED';end if;
  cost_proof:=jsonb_build_object('context',a.context,'chargeId',r.charge_id,'paymentIntentId',r.payment_intent_id,'refundedCents',0,'totalLossCents',0,
   'disputeHold',false,'reviewHold',false,'platformFeeReturnedCents',0,'platformProcessingCostCreditCents',0,'alerts','[]'::jsonb,'refundIds','[]'::jsonb,'decisionIds','[]'::jsonb,
   'providerEvidenceIds',jsonb_build_array(receipt_proof->>'balanceTransactionId'),'providerRequestIds',jsonb_build_array(rb->>'chargeRequestId',rb->>'balanceRequestId'));
  result:=public.reconcile_sales_team_receipt_v1(r.id,r.observation_revision,'capture-cost:'||t.obligation_id::text,0,0,false,false,(receipt_proof->>'processingCostCents')::bigint,
   receipt_proof->>'balanceTransactionId',to_timestamp((receipt_proof->>'availableOn')::double precision),cost_proof);
 elsif r.processing_cost_cents is not null and (receipt_proof->>'processingCostCents')::bigint is distinct from r.processing_cost_cents then raise exception 'ORIGINAL_TEAM_CAPTURE_COST_CHANGED';end if;
 return result;
end $$;
alter table public.sales_team_capture_provenance_v1 enable row level security;
revoke all on public.sales_team_capture_provenance_v1 from public,anon,authenticated;
grant select,insert on public.sales_team_capture_provenance_v1 to service_role;
create trigger sales_team_capture_immutable_v1 before update or delete on public.sales_team_capture_provenance_v1 for each row execute function creatornet_team_private.reject_history_change();
revoke all on function public.read_sales_team_capture_source_v1(uuid,uuid,uuid),public.record_verified_sales_team_capture_v1(uuid,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_sales_team_capture_source_v1(uuid,uuid,uuid),public.record_verified_sales_team_capture_v1(uuid,uuid,uuid,uuid,jsonb) to service_role;
commit;
