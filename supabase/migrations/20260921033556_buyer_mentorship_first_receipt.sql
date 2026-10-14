begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Receipt and accounting only. No hosted migration, collection activation,
-- Checkout publication or legacy permanent-access grant is implied.
create table public.buyer_mentorship_first_receipts_v1 (
  reservation_id uuid primary key references public.buyer_mentorship_installment_reservations_v1(id),
  purchase_id uuid not null unique references public.purchases(id) deferrable initially deferred,
  ledger_id uuid not null unique references public.payment_fee_ledger(id) deferrable initially deferred,
  payment_intent_id text not null unique check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  charge_id text not null unique check(charge_id ~ '^ch_[A-Za-z0-9]+$'),
  proof jsonb not null check(jsonb_typeof(proof)='object'),
  recorded_at timestamptz not null default clock_timestamp()
);
create table public.buyer_mentorship_billing_state_v1 (
  reservation_id uuid primary key references public.buyer_mentorship_first_receipts_v1(reservation_id),
  paid_count integer not null default 1 check(paid_count between 1 and 24),
  first_paid_at bigint not null check(first_paid_at>0),
  next_payment_at bigint,
  service_end_at bigint,
  collection_hold_at timestamptz default clock_timestamp(),
  financial_hold_at timestamptz,
  debit_revoked_at timestamptz,
  revision bigint not null default 0,
  check(next_payment_at is null or next_payment_at>first_paid_at),
  check(service_end_at is null or service_end_at>first_paid_at)
);
alter table public.purchases add column buyer_mentorship_installment_id uuid unique
  references public.buyer_mentorship_installment_reservations_v1(id);
alter table public.buyer_mentorship_first_receipts_v1 enable row level security;
alter table public.buyer_mentorship_billing_state_v1 enable row level security;
revoke all on public.buyer_mentorship_first_receipts_v1,public.buyer_mentorship_billing_state_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_first_receipts_v1,public.buyer_mentorship_billing_state_v1 to service_role;

create function public.guard_buyer_mentorship_purchase_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
begin
  if tg_op='UPDATE' and old.buyer_mentorship_installment_id is not null and
    new.buyer_mentorship_installment_id is distinct from old.buyer_mentorship_installment_id then
    raise exception 'Buyer installment purchase identity is immutable'; end if;
  if new.buyer_mentorship_installment_id is null then
    if new.kind='buyer_mentorship_installments_v1' then raise exception 'Buyer installment receipt binding required'; end if;
    return new;
  end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=new.buyer_mentorship_installment_id;
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id and purchase_id=new.id;
  if r.id is null or f.reservation_id is null or new.buyer_id is distinct from r.buyer_id or
    new.buyer_user_id is distinct from r.buyer_id or new.creator_id is distinct from r.creator_id or
    new.product_id is distinct from r.product_id or new.post_id is distinct from r.post_id or new.booking_id is not null or
    new.kind is distinct from 'buyer_mentorship_installments_v1' or new.product_type is distinct from 'mentorship' or
    new.currency is distinct from 'usd' or new.amount_cents::text is distinct from r.terms->>'amountCents' or
    new.title is distinct from r.terms->>'title' or new.session_id is distinct from f.proof->>'checkoutSessionId' or
    new.subscription_id is distinct from f.proof->>'subscriptionId' or new.payment_intent_id is distinct from f.payment_intent_id or
    new.access_granted is distinct from false or new.earnings_credited_at is not null or new.earnings_credited_cents is not null or
    coalesce(new.paid_count,0)<>0 or new.target_months is not null then
    raise exception 'Buyer installments cannot use legacy accounting or permanent access'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_purchase_v1 before insert or update on public.purchases
  for each row execute function public.guard_buyer_mentorship_purchase_v1();
revoke all on function public.guard_buyer_mentorship_purchase_v1() from public,anon,authenticated;

-- The observation may arrive before any buyer receipt exists. The same
-- per-PaymentIntent lock is therefore acquired before every observation write;
-- filtering by an already-present receipt would miss precisely that race.
create function public.lock_buyer_mentorship_financial_observation_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.stripe_payment_intent_id,73591));
  return new;
end $$;
create trigger buyer_mentorship_refund_observation_lock_v1 before insert or update on public.payment_refund_state
  for each row execute function public.lock_buyer_mentorship_financial_observation_v1();
create trigger buyer_mentorship_dispute_observation_lock_v1 before insert or update on public.payment_dispute_state
  for each row execute function public.lock_buyer_mentorship_financial_observation_v1();
revoke all on function public.lock_buyer_mentorship_financial_observation_v1() from public,anon,authenticated;

create function public.record_buyer_mentorship_first_receipt_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  b public.buyer_mentorship_bootstraps_v1%rowtype; o public.buyer_mentorship_bootstrap_operations_v1%rowtype;
  f public.buyer_mentorship_first_receipts_v1%rowtype; l public.payment_fee_ledger%rowtype;
  v_sub text; v_hold text; v_customer text; v_gross bigint; v_platform bigint; v_processing bigint; v_net bigint;
  v_fees jsonb; v_schedule jsonb; v_paid bigint; v_end bigint; v_next bigint;
  v_purchase uuid:=gen_random_uuid(); v_ledger uuid:=gen_random_uuid();
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
  if b.reservation_id is null or o.result_id is null or v_sub is null or v_hold is distinct from v_sub or
    not exists(select 1 from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='product.create' and bound_at is not null and result_id is not null) or
    v_customer is distinct from b.customer_id or p_proof->>'customerId' is distinct from b.customer_id or
    p_proof->>'subscriptionId' is distinct from v_sub or p_proof->>'checkoutSessionId' is distinct from o.result_id then
    raise exception 'Buyer receipt requires original bound Checkout'; end if;
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
  if v_paid<floor(extract(epoch from o.first_dispatch_at)) or v_paid>b.anchor_seconds+86400 or
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
      stripe_checkout_session_id=o.result_id or stripe_charge_id=p_proof->>'chargeId') or
    exists(select 1 from public.purchases where buyer_id=r.buyer_id and product_id=r.product_id) then
    raise exception 'Buyer receipt cannot adopt existing accounting'; end if;
  insert into public.buyer_mentorship_first_receipts_v1(reservation_id,purchase_id,ledger_id,payment_intent_id,charge_id,proof)
    values(r.id,v_purchase,v_ledger,p_proof->>'paymentIntentId',p_proof->>'chargeId',p_proof);
  insert into public.purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,amount_cents,currency,status,kind,product_type,title,
    access_granted,session_id,subscription_id,payment_intent_id,buyer_mentorship_installment_id,paid_at)
    values(v_purchase,r.buyer_id,r.buyer_id,r.creator_id,r.product_id,r.post_id,(r.terms->>'amountCents')::bigint,'usd','active',
      'buyer_mentorship_installments_v1','mentorship',r.terms->>'title',false,o.result_id,v_sub,p_proof->>'paymentIntentId',r.id,to_timestamp(v_paid));
  insert into public.payment_fee_ledger(id,creator_id,purchase_id,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,
    stripe_balance_transaction_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,
    creator_net_cents,actual_stripe_fee_cents,processing_fee_variance_cents,currency,fee_schedule_version,status,earnings_credited_at)
    values(v_ledger,r.creator_id,v_purchase,o.result_id,p_proof->>'paymentIntentId',p_proof->>'chargeId',p_proof->>'balanceTransactionId',
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
commit;
