begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

-- The hosted receipt writer remains the single earnings/access transition.
-- This service-only adapter binds the original manual bootstrap without a
-- Checkout Session, then calls that writer in the same transaction.
do $preflight$ begin
  if current_user<>'postgres' or
    to_regprocedure('public.record_monthly_mentorship_receipt_v1(uuid,uuid,integer,bigint,bigint,jsonb)') is null or
    to_regprocedure('public.read_server_payment_source_v1(uuid,uuid,jsonb,boolean)') is null or
    to_regclass('public.monthly_manual_payment_selections_v1') is null or
    to_regclass('public.server_payment_confirmations_v1') is null or
    to_regprocedure('public.record_monthly_manual_first_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)') is not null then
    raise exception 'Monthly manual receipt prerequisites differ';
  end if;
end $preflight$;

create function public.record_monthly_manual_first_receipt_v1(
  p_id uuid,p_buyer_id uuid,p_context jsonb,p_selection_id uuid,p_ledger_id uuid,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype;
  m public.monthly_manual_payment_selections_v1%rowtype;
  a public.monthly_mentorship_agreements_v1%rowtype;
  customer public.monthly_mentorship_operations_v1%rowtype;
  product public.monthly_mentorship_operations_v1%rowtype;
  sub public.monthly_mentorship_operations_v1%rowtype;
  hold public.monthly_mentorship_operations_v1%rowtype;
  intent public.server_payment_intent_operations_v1%rowtype;
  confirmation public.server_payment_confirmations_v1%rowtype;
  ledger public.payment_fee_ledger%rowtype;
  receipt public.monthly_mentorship_receipts_v1%rowtype;
  purchase public.purchases%rowtype;
  paid_at bigint;
begin
  if current_setting('transaction_isolation')<>'read committed' or
    p_proof is null or jsonb_typeof(p_proof)<>'object' or
    octet_length(p_proof::text)>100000 or p_ledger_id is null then
    raise exception 'Original monthly manual receipt input differs'; end if;
  -- The source reader takes the buyer/product advisory lock, then the owned
  -- agreement lock. It remains readable after a stop or accepted-window expiry.
  s:=public.read_server_payment_source_v1(p_selection_id,p_buyer_id,p_context,false);
  select * into m from public.monthly_manual_payment_selections_v1 where id=p_selection_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  if s.kind is distinct from 'monthly_first' or s.reservation_id is not null or
    s.protocol is distinct from 'creatornet-us-manual-confirmation-v1' or
    m.id is null or m.agreement_id is distinct from p_id or m.buyer_id is distinct from p_buyer_id or
    m.kind is distinct from 'first' or m.payoff_id is not null or
    s.source is distinct from to_jsonb(m) or a.id is null or
    a.buyer_id is distinct from p_buyer_id or a.product_id is distinct from s.product_id or
    a.terms->'paymentContext' is distinct from m.context or
    a.fingerprint is distinct from m.source->>'agreementFingerprint' or
    a.stripe_checkout_session_id is not null then
    raise exception 'Original monthly manual receipt source differs'; end if;
  select * into customer from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind='customer' and scope_key='initial';
  select * into product from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind='product' and scope_key='initial';
  select * into sub from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind='subscription' and scope_key='initial';
  select * into hold from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind='hold' and scope_key='initial';
  if customer.status is distinct from 'complete' or product.status is distinct from 'complete' or
    sub.status is distinct from 'complete' or hold.status is distinct from 'complete' or
    customer.agreement_revision::text is distinct from m.source->>'revision' or
    product.agreement_revision::text is distinct from m.source->>'revision' or
    sub.agreement_revision::text is distinct from m.source->>'revision' or
    hold.agreement_revision::text is distinct from m.source->>'revision' or
    coalesce(customer.provider_id,'')!~'^cus_[A-Za-z0-9]+$' or
    coalesce(sub.provider_id,'')!~'^sub_[A-Za-z0-9]+$' or
    sub.provider_id is distinct from hold.provider_id or
    customer.provider_id is distinct from sub.request#>>'{params,customer}' or
    product.provider_id is distinct from sub.request#>>'{params,items,0,price_data,product}' or
    hold.request is distinct from jsonb_build_object('method','POST','path','/v1/subscriptions/'||sub.provider_id,
      'params',jsonb_build_object('pause_collection',jsonb_build_object('behavior','keep_as_draft'))) then
    raise exception 'Original monthly held subscription differs'; end if;
  select * into intent from public.server_payment_intent_operations_v1 where attempt_id=p_selection_id;
  select * into confirmation from public.server_payment_confirmations_v1
    where attempt_id=p_selection_id and operation_id::text=p_proof#>>'{manualPayment,confirmationOperationId}';
  if intent.attempt_id is null or intent.bound_at is null or
    intent.payment_intent_id is distinct from p_proof->>'paymentIntentId' or
    intent.contract->>'attemptId' is distinct from p_selection_id::text or
    intent.contract->>'kind' is distinct from 'monthly_first' or
    intent.contract->>'termsFingerprint' is distinct from a.fingerprint or
    intent.contract->'context' is distinct from p_context or
    intent.contract->>'customerId' is distinct from customer.provider_id or
    intent.contract->>'destinationId' is distinct from a.terms->>'destinationId' or
    intent.contract->>'amountCents' is distinct from a.monthly_price_cents::text or
    intent.contract#>>'{sourceMetadata,membership_subscription_id}' is distinct from sub.provider_id or
    confirmation.operation_id is null or confirmation.payment_intent_id is distinct from intent.payment_intent_id or
    confirmation.latest_observation->>'status' is distinct from 'succeeded' or
    confirmation.latest_observation->>'paymentIntentId' is distinct from intent.payment_intent_id or
    confirmation.latest_observation->>'chargeId' is distinct from p_proof->>'chargeId' or
    confirmation.latest_observation->>'paymentMethodId' is distinct from p_proof->>'paymentMethodId' or
    exists(select 1 from public.server_payment_confirmations_v1 later
      where later.attempt_id=p_selection_id and later.phase>confirmation.phase) then
    raise exception 'Original monthly captured confirmation differs'; end if;
  if p_proof->>'version' is distinct from 'monthly-mentorship-payment-proof-v1' or
    jsonb_typeof(p_proof->'manualPayment') is distinct from 'object' or
    (p_proof->'manualPayment')-array['attemptId','confirmationOperationId']<>'{}'::jsonb or
    p_proof#>>'{manualPayment,attemptId}' is distinct from p_selection_id::text or
    p_proof->'checkoutSessionId' is distinct from 'null'::jsonb or
    p_proof->'invoiceId' is distinct from 'null'::jsonb or
    p_proof->>'paymentStatus' is distinct from 'succeeded' or
    p_proof->>'buyerCountry' is distinct from 'US' or
    p_proof->>'customerId' is distinct from customer.provider_id or
    p_proof->>'subscriptionId' is distinct from sub.provider_id or
    p_proof->>'destinationId' is distinct from a.terms->>'destinationId' or
    p_proof->'paymentContext' is distinct from a.terms->'paymentContext' or
    p_proof->>'capturedAmountCents' is distinct from a.monthly_price_cents::text or
    p_proof->>'applicationFeeAmountCents' is distinct from a.terms#>>'{firstMonthFees,totalCreatorDeductionCents}' or
    coalesce(p_proof->>'balanceTransactionId','')!~'^txn_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'transferId','')!~'^tr_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'paidAt','')!~'^[0-9]{1,12}$' then
    raise exception 'Monthly manual captured-payment proof differs'; end if;
  paid_at:=(p_proof->>'paidAt')::bigint;
  if paid_at<floor(extract(epoch from intent.first_dispatch_at)) or
    paid_at>(intent.contract->>'expiresAt')::bigint or
    paid_at>floor(extract(epoch from clock_timestamp())) then
    raise exception 'Monthly manual captured-payment time differs'; end if;
  select * into receipt from public.monthly_mentorship_receipts_v1
    where agreement_id=a.id and month_number=1;
  if found then
    if receipt.ledger_id is distinct from p_ledger_id or receipt.provider_proof is distinct from p_proof or
      a.stripe_customer_id is distinct from customer.provider_id or
      a.stripe_subscription_id is distinct from sub.provider_id then
      raise exception 'Original monthly manual receipt replay differs'; end if;
    return false;
  end if;
  select * into ledger from public.payment_fee_ledger where id=p_ledger_id for update;
  if ledger.id is null or ledger.purchase_id is distinct from a.purchase_id or
    ledger.creator_id is distinct from a.creator_id or
    ledger.stripe_checkout_session_id is not null or ledger.stripe_invoice_id is not null or
    ledger.stripe_payment_intent_id is distinct from intent.payment_intent_id or
    ledger.stripe_charge_id is distinct from p_proof->>'chargeId' or
    ledger.stripe_balance_transaction_id is distinct from p_proof->>'balanceTransactionId' or
    ledger.actual_stripe_fee_cents::text is distinct from p_proof->>'actualStripeFeeCents' or
    ledger.status is distinct from 'paid' or ledger.refunded_amount_cents<>0 or
    ledger.earnings_reversed_cents<>0 or ledger.earnings_credited_at is not null or
    (ledger.dispute_status is not null and ledger.dispute_status not in ('won','warning_closed')) or
    exists(select 1 from public.payment_fee_ledger other where other.purchase_id=a.purchase_id and other.id<>p_ledger_id) or
    a.covered_months<>0 or a.anchor_at is not null or
    a.stripe_customer_id is not null or a.stripe_subscription_id is not null or
    exists(select 1 from public.monthly_mentorship_operations_v1
      where agreement_id=a.id and kind='checkout') or
    exists(select 1 from public.monthly_mentorship_initial_closures_v1 where agreement_id=a.id) then
    raise exception 'Monthly manual first receipt accounting requires review'; end if;
  select * into purchase from public.purchases where id=a.purchase_id for update;
  if purchase.id is null or purchase.monthly_mentorship_id is distinct from a.id or
    purchase.buyer_id is distinct from a.buyer_id or
    purchase.kind is distinct from 'monthly_mentorship_v1' or
    purchase.status is distinct from 'pending' or
    purchase.subscription_id is not null or purchase.session_id is not null then
    raise exception 'Monthly manual purchase binding differs'; end if;
  update public.monthly_mentorship_agreements_v1 set
    stripe_customer_id=customer.provider_id,stripe_subscription_id=sub.provider_id,revision=revision+1
    where id=a.id;
  update public.purchases set subscription_id=sub.provider_id where id=a.purchase_id;
  return public.record_monthly_mentorship_receipt_v1(a.id,p_ledger_id,1,paid_at,
    public.monthly_mentorship_boundary_v1(paid_at,1),p_proof);
end $$;
revoke all on function public.record_monthly_manual_first_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.record_monthly_manual_first_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)
  to service_role;
commit;
