begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Extend only source admission for the existing transactional receipt writer.
-- Shared locks, fee validation, duplicate/race checks, accounting and access
-- state remain in that same function. A manual source has no Checkout Session.
create or replace function public.record_buyer_mentorship_first_receipt_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  b public.buyer_mentorship_bootstraps_v1%rowtype; o public.buyer_mentorship_bootstrap_operations_v1%rowtype;
  f public.buyer_mentorship_first_receipts_v1%rowtype; l public.payment_fee_ledger%rowtype;
  v_sub text; v_hold text; v_customer text; v_gross bigint; v_platform bigint; v_processing bigint; v_net bigint;
  v_fees jsonb; v_schedule jsonb; v_paid bigint; v_end bigint; v_next bigint;
  v_purchase uuid:=gen_random_uuid(); v_ledger uuid:=gen_random_uuid();
  manual public.server_payment_intent_operations_v1%rowtype; confirmation public.server_payment_confirmations_v1%rowtype;
  v_session text; v_dispatch timestamptz; v_expiry bigint;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer receipt reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  perform 1 from public.buyer_mentorship_installment_reservations_v1 where id=r.id and status='reserved' and context=p_context;
  if not found then raise exception 'Buyer receipt reservation changed'; end if;
  if p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>100000 or
    p_proof->>'version' is distinct from 'buyer-mentorship-first-capture-v1' or
    p_proof->>'reservationId' is distinct from r.id::text or p_proof->>'requestId' is distinct from r.request_id::text or
    p_proof->>'buyerId' is distinct from r.buyer_id::text or p_proof->>'creatorId' is distinct from r.creator_id::text or
    p_proof->>'productId' is distinct from r.product_id::text or p_proof->>'postId' is distinct from r.post_id::text or
    p_proof->>'termsFingerprint' is distinct from r.fingerprint or p_proof->'context' is distinct from r.context or
    p_proof->'paymentNumber' is distinct from '1'::jsonb or p_proof->>'buyerCountry' is distinct from 'US' or
    p_proof->>'destinationId' is distinct from r.destination_id or
    coalesce(p_proof->>'paymentIntentId','') !~ '^pi_[A-Za-z0-9]+$' or coalesce(p_proof->>'chargeId','') !~ '^ch_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'balanceTransactionId','') !~ '^txn_[A-Za-z0-9]+$' or coalesce(p_proof->>'transferId','') !~ '^tr_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'paymentMethodId','') !~ '^pm_[A-Za-z0-9]+$' or coalesce(p_proof->>'actualStripeFeeCents','') !~ '^[0-9]+$' or
    (p_proof->>'actualStripeFeeCents')::numeric>99999999 or coalesce(p_proof->>'paidAt','') !~ '^[0-9]+$' then
    raise exception 'Buyer first captured-payment proof differs'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_proof->>'paymentIntentId',73591));
  select * into b from public.buyer_mentorship_bootstraps_v1 where reservation_id=r.id;
  select customer_id into v_customer from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id and bound_at is not null;
  select * into o from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='checkout.create' and bound_at is not null;
  select result_id into v_sub from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='subscription.create' and bound_at is not null;
  select result_id into v_hold from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='subscription.hold' and bound_at is not null;
  if b.reservation_id is null or v_sub is null or v_hold is distinct from v_sub or
    not exists(select 1 from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='product.create' and bound_at is not null and result_id is not null) or
    v_customer is distinct from b.customer_id or p_proof->>'customerId' is distinct from b.customer_id or
    p_proof->>'subscriptionId' is distinct from v_sub then raise exception 'Original first-payment dependencies differ'; end if;
  if p_proof ? 'manualPayment' then
    if jsonb_typeof(p_proof->'manualPayment') is distinct from 'object' or
      (p_proof->'manualPayment')-array['attemptId','confirmationOperationId']<>'{}'::jsonb or
      p_proof#>>'{manualPayment,attemptId}' is distinct from r.attempt_id::text or
      p_proof->'checkoutSessionId' is distinct from 'null'::jsonb or r.released_at is not null or
      exists(select 1 from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='checkout.create') or
      not exists(select 1 from public.server_payment_protocols_v1 where attempt_id=r.attempt_id and reservation_id=r.id and
        buyer_id=r.buyer_id and product_id=r.product_id and context=r.context and kind='first_installment' and
        protocol='creatornet-us-manual-confirmation-v1') then raise exception 'Manual first receipt source differs'; end if;
    select * into manual from public.server_payment_intent_operations_v1 where attempt_id=r.attempt_id;
    select * into confirmation from public.server_payment_confirmations_v1 where attempt_id=r.attempt_id and
      operation_id::text=p_proof#>>'{manualPayment,confirmationOperationId}';
    if manual.bound_at is null or manual.payment_intent_id is distinct from p_proof->>'paymentIntentId' or
      manual.contract->>'termsFingerprint' is distinct from r.fingerprint or manual.contract->'context' is distinct from r.context or
      manual.contract->>'customerId' is distinct from b.customer_id or manual.contract->>'destinationId' is distinct from r.destination_id or
      confirmation.operation_id is null or confirmation.payment_intent_id is distinct from manual.payment_intent_id or
      confirmation.latest_observation->>'status' is distinct from 'succeeded' or
      confirmation.latest_observation->>'paymentIntentId' is distinct from manual.payment_intent_id or
      confirmation.latest_observation->>'chargeId' is distinct from p_proof->>'chargeId' or
      confirmation.latest_observation->>'paymentMethodId' is distinct from p_proof->>'paymentMethodId' or
      exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=r.attempt_id and server_payment_confirmations_v1.phase>confirmation.phase) then
      raise exception 'Manual first receipt needs its original captured confirmation'; end if;
    v_session:=null;v_dispatch:=manual.first_dispatch_at;v_expiry:=(manual.contract->>'expiresAt')::bigint;
  else
    if o.result_id is null or p_proof->>'checkoutSessionId' is distinct from o.result_id or
      exists(select 1 from public.server_payment_protocols_v1 where attempt_id=r.attempt_id) then
      raise exception 'Buyer receipt requires original bound Checkout'; end if;
    v_session:=o.result_id;v_dispatch:=o.first_dispatch_at;v_expiry:=b.anchor_seconds+86400;
  end if;
  v_gross:=(r.terms->>'amountCents')::bigint/(r.terms->>'paymentCount')::integer;
  v_schedule:=r.terms->'firstPaymentFeeSchedule'; v_fees:=p_proof->'fees';
  v_platform:=round(v_gross::numeric*1200/10000)::bigint;
  v_processing:=case when (v_schedule->>'enabled')::boolean then
    round(v_gross::numeric*(v_schedule->>'basisPoints')::integer/10000)::bigint+(v_schedule->>'fixedCents')::bigint else 0 end;
  v_net:=v_gross-v_platform-v_processing;
  if p_proof->>'amountCents' is distinct from v_gross::text or not public.valid_monthly_fee_snapshot_v1(v_fees,v_gross::integer) or
    v_fees->'processingFeeEnabled' is distinct from v_schedule->'enabled' or
    v_fees->'processingFeeBasisPoints' is distinct from v_schedule->'basisPoints' or
    v_fees->'processingFeeFixedCents' is distinct from v_schedule->'fixedCents' or
    v_fees->>'feeScheduleVersion' is distinct from v_schedule->>'version' or v_net<0 then
    raise exception 'Buyer receipt economics differ from acceptance'; end if;
  v_paid:=(p_proof->>'paidAt')::bigint;
  v_end:=case when r.terms->>'serviceMonths' is null then null else public.fixed_service_end_v1(v_paid,(r.terms->>'serviceMonths')::integer) end;
  v_next:=public.fixed_service_end_v1(v_paid,1);
  if v_paid<floor(extract(epoch from v_dispatch)) or v_paid>v_expiry or
    v_paid>floor(extract(epoch from clock_timestamp())) or
    p_proof->'serviceEndsAt' is distinct from coalesce(to_jsonb(v_end),'null'::jsonb) or
    p_proof->'nextPaymentAt' is distinct from to_jsonb(v_next) then raise exception 'Buyer receipt dates differ'; end if;
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  if found then
    if f.proof is distinct from p_proof then raise exception 'Original buyer receipt is immutable'; end if;
    select * into l from public.payment_fee_ledger where id=f.ledger_id;
    if l.id is null or l.purchase_id is distinct from f.purchase_id or l.creator_id is distinct from r.creator_id or
      l.stripe_payment_intent_id is distinct from f.payment_intent_id or l.stripe_charge_id is distinct from f.charge_id or
      l.gross_amount_cents is distinct from v_gross or l.platform_fee_cents is distinct from v_platform or
      l.processing_fee_cents is distinct from v_processing or l.creator_net_cents is distinct from v_net or
      l.earnings_credited_at is null then raise exception 'Existing buyer receipt accounting differs'; end if;
    return jsonb_build_object('recorded',false,'reservationId',r.id,'purchaseId',f.purchase_id,'ledgerId',f.ledger_id);
  end if;
  if exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=p_proof->>'paymentIntentId' and
      (stripe_charge_id is distinct from p_proof->>'chargeId' or charge_amount_cents<>v_gross or refunded_amount_cents>0)) or
    exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=p_proof->>'paymentIntentId') then
    raise exception 'Prior financial observation requires buyer lifecycle reconciliation'; end if;
  if exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=p_proof->>'paymentIntentId' or
      stripe_checkout_session_id=v_session or stripe_charge_id=p_proof->>'chargeId') or
    exists(select 1 from public.purchases where buyer_id=r.buyer_id and product_id=r.product_id) then
    raise exception 'Buyer receipt cannot adopt existing accounting'; end if;
  insert into public.buyer_mentorship_first_receipts_v1(reservation_id,purchase_id,ledger_id,payment_intent_id,charge_id,proof)
    values(r.id,v_purchase,v_ledger,p_proof->>'paymentIntentId',p_proof->>'chargeId',p_proof);
  insert into public.purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,amount_cents,currency,status,kind,product_type,title,
    access_granted,session_id,subscription_id,payment_intent_id,buyer_mentorship_installment_id,paid_at)
    values(v_purchase,r.buyer_id,r.buyer_id,r.creator_id,r.product_id,r.post_id,(r.terms->>'amountCents')::bigint,'usd','active',
      'buyer_mentorship_installments_v1','mentorship',r.terms->>'title',false,v_session,v_sub,p_proof->>'paymentIntentId',r.id,to_timestamp(v_paid));
  insert into public.payment_fee_ledger(id,creator_id,purchase_id,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
    stripe_balance_transaction_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,
    creator_net_cents,actual_stripe_fee_cents,processing_fee_variance_cents,currency,fee_schedule_version,status,earnings_credited_at)
    values(v_ledger,r.creator_id,v_purchase,v_session,p_proof->>'paymentIntentId',p_proof->>'chargeId',p_proof->>'balanceTransactionId',
      v_gross,v_platform,v_processing,v_platform+v_processing,v_net,(p_proof->>'actualStripeFeeCents')::bigint,
      v_processing-(p_proof->>'actualStripeFeeCents')::bigint,'usd',v_schedule->>'version','paid',clock_timestamp());
  update public.profiles set total_earnings_cents=coalesce(total_earnings_cents,0)+v_net where id=r.creator_id;
  if not found then raise exception 'Buyer receipt creator profile missing'; end if;
  insert into public.buyer_mentorship_billing_state_v1(reservation_id,first_paid_at,next_payment_at,service_end_at)
    values(r.id,v_paid,v_next,v_end);
  return jsonb_build_object('recorded',true,'reservationId',r.id,'purchaseId',v_purchase,'ledgerId',v_ledger);
end $$;
revoke all on function public.record_buyer_mentorship_first_receipt_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_buyer_mentorship_first_receipt_v1(uuid,uuid,jsonb,jsonb) to service_role;

-- Null is the truthful session identity for the manual source.
create or replace function public.read_buyer_mentorship_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare p public.purchases%rowtype; r public.buyer_mentorship_installment_reservations_v1%rowtype;
  f public.buyer_mentorship_first_receipts_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype;
  financial boolean:=false; seconds integer:=0; at_time numeric:=extract(epoch from clock_timestamp());
begin
  select * into p from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id;
  if not found then return jsonb_build_object('applicable',false,'allowed',false,'maxAgeSeconds',0); end if;
  if p.buyer_mentorship_installment_id is null then
    return jsonb_build_object('applicable',false,'allowed',coalesce(p.access_granted and p.status<>'refunded',false),
      'maxAgeSeconds',case when p.access_granted and p.status<>'refunded' then 3600 else 0 end);
  end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where id=p.buyer_mentorship_installment_id and buyer_id=p_buyer_id;
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id and purchase_id=p.id;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=f.reservation_id;
  financial:=coalesce(r.id is not null and f.reservation_id is not null and b.reservation_id is not null and
    p.kind='buyer_mentorship_installments_v1' and p.status in ('active','complete') and
    not p.is_refund and not p.is_suspect and p.creator_id=r.creator_id and p.product_id=r.product_id and p.post_id=r.post_id and
    p.payment_intent_id=f.payment_intent_id and p.session_id is not distinct from f.proof->>'checkoutSessionId' and
    p.subscription_id=f.proof->>'subscriptionId' and r.fingerprint=f.proof->>'termsFingerprint' and
    r.context=f.proof->'context' and b.first_paid_at=(f.proof->>'paidAt')::bigint and
    b.service_end_at is not distinct from (f.proof->>'serviceEndsAt')::bigint and
    b.paid_count between 1 and (r.terms->>'paymentCount')::integer and b.financial_hold_at is null and
    exists(select 1 from public.payment_fee_ledger where id=f.ledger_id and purchase_id=p.id and
      creator_id=r.creator_id and stripe_payment_intent_id=f.payment_intent_id and stripe_charge_id=f.charge_id and
      gross_amount_cents=(f.proof->>'amountCents')::bigint and earnings_credited_at is not null and status='paid') and
    not exists(select 1 from public.payment_fee_ledger l where l.purchase_id=p.id and
      (l.status<>'paid' or l.refunded_amount_cents>0 or l.earnings_reversed_cents>0 or
        l.dispute_status is not null and l.dispute_status not in ('won','warning_closed'))) and
    not exists(select 1 from public.payment_fee_ledger l join public.payment_refund_state s
      on s.stripe_payment_intent_id=l.stripe_payment_intent_id where l.purchase_id=p.id and s.refunded_amount_cents>0) and
    not exists(select 1 from public.payment_fee_ledger l join public.payment_dispute_state s
      on s.stripe_payment_intent_id=l.stripe_payment_intent_id where l.purchase_id=p.id and s.status not in ('won','warning_closed')) and
    not exists(select 1 from public.payment_fee_ledger l join public.refund_operations o
      on o.stripe_payment_intent_id=l.stripe_payment_intent_id where l.purchase_id=p.id and o.status not in ('failed','completed')),false);
  if financial and at_time>=b.first_paid_at then
    seconds:=floor(least(3600,case when b.service_end_at is null then 3600 else greatest(0,b.service_end_at-at_time) end))::integer;
  end if;
  return jsonb_build_object('applicable',true,'reservationId',r.id,'serviceStartAt',b.first_paid_at,
    'serviceEndAt',b.service_end_at,'financialAccess',financial,'allowed',seconds>0,'maxAgeSeconds',seconds);
end $$;
revoke all on function public.read_buyer_mentorship_entitlement_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_entitlement_v1(uuid,uuid) to service_role;

-- A late capture remains account-able after a stop. Starting/retrying
-- activation and reopening collection do not. Completion of an already
-- dispatched activation remains recordable with its original proof.
create function public.guard_manual_first_payment_dispatch_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=new.reservation_id;
  if not found then raise exception 'Original manual reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  if exists(select 1 from public.server_payment_stops_v1 where attempt_id=r.attempt_id) then
    if tg_table_name='buyer_mentorship_activation_operations_v1' then
      if tg_op='INSERT' then raise exception 'Manual purchase stop requires reconciliation'; end if;
      if new.lease_token is distinct from old.lease_token or new.lease_until is distinct from old.lease_until then
        raise exception 'Manual purchase stop requires reconciliation'; end if;
    elsif new.collection_hold_at is null then
      raise exception 'Manual purchase stop prevents collection release';
    end if;
  end if;
  return new;
end $$;
create trigger guard_manual_first_payment_dispatch_v1 before insert or update on public.buyer_mentorship_activation_operations_v1
  for each row execute function public.guard_manual_first_payment_dispatch_v1();
create trigger guard_manual_first_payment_dispatch_v1 before insert or update on public.buyer_mentorship_billing_state_v1
  for each row execute function public.guard_manual_first_payment_dispatch_v1();

create function public.hold_manual_first_payment_collection_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype;
begin
  select * into s from public.server_payment_protocols_v1 where attempt_id=new.attempt_id;
  if not found then raise exception 'Original manual payment source unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.buyer_id::text||':'||s.product_id::text,72913));
  if s.kind='first_installment' then
    update public.buyer_mentorship_billing_state_v1 set collection_hold_at=clock_timestamp(),revision=revision+1
      where reservation_id=s.reservation_id and collection_hold_at is null;
  end if;
  return new;
end $$;
create trigger hold_manual_first_payment_collection_v1 after insert on public.server_payment_stops_v1
  for each row execute function public.hold_manual_first_payment_collection_v1();
revoke all on function public.guard_manual_first_payment_dispatch_v1(),public.hold_manual_first_payment_collection_v1()
  from public,anon,authenticated;

commit;
