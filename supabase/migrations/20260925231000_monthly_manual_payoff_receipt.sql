begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

-- A captured manual payoff has no Checkout Session. Preserve the hosted
-- payoff writer and add a separate service-only transaction over the frozen
-- selection, original intent, latest confirmation, ledger and payoff hold.
do $preflight$ begin
  if current_user<>'postgres' or
    to_regprocedure('public.record_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,uuid,jsonb)') is null or
    to_regprocedure('public.read_server_payment_source_v1(uuid,uuid,jsonb,boolean)') is null or
    to_regclass('public.monthly_manual_payment_selections_v1') is null or
    to_regclass('public.server_payment_confirmations_v1') is null or
    to_regprocedure('public.record_monthly_manual_payoff_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)') is not null then
    raise exception 'Monthly manual payoff receipt prerequisites differ'; end if;
end $preflight$;

create function public.record_monthly_manual_payoff_receipt_v1(
  p_payoff_id uuid,p_buyer_id uuid,p_context jsonb,p_selection_id uuid,p_ledger_id uuid,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype;
  m public.monthly_manual_payment_selections_v1%rowtype;
  a public.monthly_mentorship_agreements_v1%rowtype;
  pf public.monthly_mentorship_payoffs_v1%rowtype;
  intent public.server_payment_intent_operations_v1%rowtype;
  confirmation public.server_payment_confirmations_v1%rowtype;
  ledger public.payment_fee_ledger%rowtype;
  purchase public.purchases%rowtype;
  fees jsonb; paid_at bigint;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_ledger_id is null or
    p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>100000 then
    raise exception 'Original manual payoff receipt input differs'; end if;
  s:=public.read_server_payment_source_v1(p_selection_id,p_buyer_id,p_context,false);
  select * into m from public.monthly_manual_payment_selections_v1 where id=p_selection_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=m.agreement_id for update;
  select * into pf from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id for update;
  if s.kind is distinct from 'monthly_payoff' or s.reservation_id is not null or
    s.protocol is distinct from 'creatornet-us-manual-confirmation-v1' or
    m.id is null or m.id is distinct from s.attempt_id or m.kind is distinct from 'payoff' or
    m.payoff_id is distinct from p_payoff_id or m.buyer_id is distinct from p_buyer_id or
    s.source is distinct from to_jsonb(m) or a.id is null or
    a.buyer_id is distinct from p_buyer_id or a.product_id is distinct from s.product_id or
    a.fingerprint is distinct from m.source->>'agreementFingerprint' or
    a.terms->'paymentContext' is distinct from m.context or
    pf.id is null or pf.agreement_id is distinct from a.id or pf.buyer_id is distinct from p_buyer_id or
    pf.fingerprint is distinct from m.source->>'sourceFingerprint' or
    pf.terms is distinct from m.source->'terms' or pf.amount_cents::text is distinct from m.source->>'amountCents' or
    pf.checkout_request is not null or pf.checkout_dispatched_at is not null or
    pf.stripe_checkout_session_id is not null or pf.checkout_request_id is not null then
    raise exception 'Original manual payoff receipt source differs'; end if;
  -- An identical captured receipt is a read-only replay. It cannot credit twice.
  if pf.status='captured' then
    if pf.ledger_id is distinct from p_ledger_id or pf.provider_proof is distinct from p_proof then
      raise exception 'Original manual payoff receipt replay differs'; end if;
    return false;
  end if;
  if pf.status<>'accepted' or pf.ledger_id is not null or pf.provider_proof is not null or
    a.payoff_hold_at is null or a.covered_months<>pf.first_unpaid_month-1 or
    a.stripe_customer_id is null or a.stripe_subscription_id is null then
    raise exception 'Original manual payoff balance requires reconciliation'; end if;
  select * into intent from public.server_payment_intent_operations_v1 where attempt_id=p_selection_id;
  select * into confirmation from public.server_payment_confirmations_v1
    where attempt_id=p_selection_id and operation_id::text=p_proof#>>'{manualPayment,confirmationOperationId}';
  if intent.attempt_id is null or intent.bound_at is null or
    intent.payment_intent_id is distinct from p_proof->>'paymentIntentId' or
    intent.contract->>'attemptId' is distinct from p_selection_id::text or
    intent.contract->>'kind' is distinct from 'monthly_payoff' or
    intent.contract->>'termsFingerprint' is distinct from pf.fingerprint or
    intent.contract->'context' is distinct from p_context or
    intent.contract->>'customerId' is distinct from a.stripe_customer_id or
    intent.contract->>'destinationId' is distinct from a.terms->>'destinationId' or
    intent.contract->>'amountCents' is distinct from pf.amount_cents::text or
    confirmation.operation_id is null or confirmation.payment_intent_id is distinct from intent.payment_intent_id or
    confirmation.latest_observation->>'status' is distinct from 'succeeded' or
    confirmation.latest_observation->>'paymentIntentId' is distinct from intent.payment_intent_id or
    confirmation.latest_observation->>'chargeId' is distinct from p_proof->>'chargeId' or
    confirmation.latest_observation->>'paymentMethodId' is distinct from p_proof->>'paymentMethodId' or
    exists(select 1 from public.server_payment_confirmations_v1 later
      where later.attempt_id=p_selection_id and later.phase>confirmation.phase) then
    raise exception 'Original manual payoff confirmation differs'; end if;
  if p_proof->>'version' is distinct from 'monthly-mentorship-payoff-proof-v1' or
    jsonb_typeof(p_proof->'manualPayment') is distinct from 'object' or
    (p_proof->'manualPayment')-array['attemptId','confirmationOperationId']<>'{}'::jsonb or
    p_proof#>>'{manualPayment,attemptId}' is distinct from p_selection_id::text or
    p_proof->'checkoutSessionId' is distinct from 'null'::jsonb or
    p_proof->>'payoffId' is distinct from p_payoff_id::text or
    p_proof->>'payoffFingerprint' is distinct from pf.fingerprint or
    p_proof->>'paymentStatus' is distinct from 'succeeded' or
    p_proof->>'buyerCountry' is distinct from 'US' or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or
    p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    p_proof->>'destinationId' is distinct from a.terms->>'destinationId' or
    p_proof->'paymentContext' is distinct from a.terms->'paymentContext' or
    p_proof->>'capturedAmountCents' is distinct from pf.amount_cents::text or
    p_proof->>'applicationFeeAmountCents' is distinct from pf.terms#>>'{fees,totalCreatorDeductionCents}' or
    p_proof->>'periodStart' is distinct from pf.period_start::text or
    p_proof->>'periodEnd' is distinct from pf.period_end::text or
    coalesce(p_proof->>'balanceTransactionId','')!~'^txn_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'transferId','')!~'^tr_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'paidAt','')!~'^[0-9]{1,12}$' then
    raise exception 'Original manual payoff captured proof differs'; end if;
  paid_at:=(p_proof->>'paidAt')::bigint;
  if paid_at<floor(extract(epoch from intent.first_dispatch_at)) or
    paid_at>(intent.contract->>'expiresAt')::bigint or
    paid_at>floor(extract(epoch from clock_timestamp())) then
    raise exception 'Original manual payoff capture time differs'; end if;
  select * into ledger from public.payment_fee_ledger where id=p_ledger_id for update;
  fees:=pf.terms->'fees';
  if ledger.id is null or ledger.purchase_id is distinct from a.purchase_id or
    ledger.creator_id is distinct from a.creator_id or ledger.currency is distinct from 'usd' or
    ledger.status is distinct from 'paid' or ledger.refunded_amount_cents<>0 or
    ledger.earnings_reversed_cents<>0 or ledger.earnings_credited_at is not null or
    (ledger.dispute_status is not null and ledger.dispute_status not in ('won','warning_closed')) or
    ledger.stripe_checkout_session_id is not null or ledger.stripe_invoice_id is not null or
    ledger.stripe_payment_intent_id is distinct from intent.payment_intent_id or
    ledger.stripe_charge_id is distinct from p_proof->>'chargeId' or
    ledger.stripe_balance_transaction_id is distinct from p_proof->>'balanceTransactionId' or
    ledger.actual_stripe_fee_cents::text is distinct from p_proof->>'actualStripeFeeCents' or
    ledger.gross_amount_cents<>pf.amount_cents or
    ledger.platform_fee_cents::text is distinct from fees->>'platformFeeCents' or
    ledger.processing_fee_cents::text is distinct from fees->>'processingFeeCents' or
    ledger.total_creator_deduction_cents::text is distinct from fees->>'totalCreatorDeductionCents' or
    ledger.creator_net_cents::text is distinct from fees->>'creatorNetCents' or
    ledger.fee_schedule_version is distinct from fees->>'feeScheduleVersion' then
    raise exception 'Original manual payoff ledger requires review'; end if;
  select * into purchase from public.purchases where id=a.purchase_id for update;
  if purchase.id is null or purchase.monthly_mentorship_id is distinct from a.id or
    purchase.buyer_id is distinct from a.buyer_id or purchase.status is distinct from 'active' or
    purchase.subscription_id is distinct from a.stripe_subscription_id then
    raise exception 'Original manual payoff purchase differs'; end if;
  update public.profiles set total_earnings_cents=coalesce(total_earnings_cents,0)+
    ledger.creator_net_cents where id=a.creator_id;
  if not found then raise exception 'Original manual payoff creator missing'; end if;
  update public.payment_fee_ledger set earnings_credited_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=ledger.id;
  update public.monthly_mentorship_payoffs_v1 set ledger_id=ledger.id,provider_proof=p_proof,
    captured_at=clock_timestamp(),status='captured' where id=pf.id;
  update public.monthly_mentorship_agreements_v1 set covered_months=minimum_months,
    payoff_hold_at=null,renewal_stopped_at=coalesce(renewal_stopped_at,clock_timestamp()),
    revision=revision+1,billing_next_attempt_at='infinity' where id=a.id;
  insert into public.monthly_mentorship_exit_requests_v1(agreement_id,buyer_id,kind,accepted_snapshot)
    values(a.id,a.buyer_id,'stop_renewal',pf.terms)
    on conflict(agreement_id,kind) do nothing;
  return true;
end $$;
revoke all on function public.record_monthly_manual_payoff_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.record_monthly_manual_payoff_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)
  to service_role;
commit;
