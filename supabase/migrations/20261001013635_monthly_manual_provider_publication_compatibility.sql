-- REVIEW ONLY: additive manual provider-publication compatibility candidate. No hosted approval.
-- Preserves the seven sealed migrations and original hosted requirements.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $manual_publication_preflight$ begin
 if current_user<>'postgres' or
   to_regclass('public.monthly_manual_provider_publications_v1') is not null or
   to_regprocedure('public.record_monthly_manual_first_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)') is null or
   md5(pg_get_functiondef('public.guard_monthly_provider_publication_v1()'::regprocedure)) is distinct from 'd040c1770b43e1272f1da3557ed2c508' then
  raise exception 'Manual publication compatibility prerequisites differ';end if;
end $manual_publication_preflight$;
create table public.monthly_manual_provider_publications_v1(
 agreement_id uuid primary key references public.monthly_mentorship_agreements_v1(id),
 selection_id uuid not null unique references public.monthly_manual_payment_selections_v1(id),
 ledger_id uuid not null unique references public.payment_fee_ledger(id),
 customer_id text not null check(customer_id ~ '^cus_[A-Za-z0-9]+$'),
 subscription_id text not null check(subscription_id ~ '^sub_[A-Za-z0-9]+$'),
 proof jsonb not null check(jsonb_typeof(proof)='object' and octet_length(proof::text)<=100000),
 created_at timestamptz not null default clock_timestamp()
);
alter table public.monthly_manual_provider_publications_v1 enable row level security;
revoke all on public.monthly_manual_provider_publications_v1 from public,anon,authenticated,service_role;
create function public.guard_monthly_manual_provider_publication_record_v1() returns trigger language plpgsql security definer set search_path=pg_catalog as $publication_record$
begin raise exception 'Original manual provider publication record is immutable'; end;
$publication_record$;
revoke all on function public.guard_monthly_manual_provider_publication_record_v1() from public,anon,authenticated,service_role;
create trigger guard_monthly_manual_provider_publication_record_v1 before update or delete
 on public.monthly_manual_provider_publications_v1 for each row execute function public.guard_monthly_manual_provider_publication_record_v1();
create trigger guard_monthly_manual_provider_publication_record_no_truncate_v1 before truncate
 on public.monthly_manual_provider_publications_v1 for each statement execute function public.guard_monthly_manual_provider_publication_record_v1();
create or replace function public.guard_monthly_provider_publication_v1() returns trigger language plpgsql security definer set search_path=pg_catalog as $manual_publication$
begin
  if new.stripe_subscription_id is null then return new; end if;
  -- Preserve the three owned completed bootstrap requirements for both paths.
  if not exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=new.id and kind='customer' and scope_key='initial' and status='complete' and provider_id=new.stripe_customer_id) or
    not exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=new.id and kind='subscription' and scope_key='initial' and status='complete' and provider_id=new.stripe_subscription_id) or
    not exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=new.id and kind='hold' and scope_key='initial' and status='complete' and provider_id=new.stripe_subscription_id) then
    raise exception 'Monthly provider publication requires completed owned operations'; end if;
  -- Existing hosted publication continues to require its owned Checkout.
  if exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=new.id and kind='checkout' and scope_key='initial' and status='complete' and provider_id=new.stripe_checkout_session_id) then return new; end if;
  -- Only the validated manual-first receipt writer can INSERT this record.
  -- Callers cannot acquire publication authority by writing public journals.
  if tg_op='UPDATE' and old.stripe_customer_id is null and old.stripe_subscription_id is null and
    old.stripe_checkout_session_id is null and new.stripe_checkout_session_id is null and
    old.covered_months=0 and old.anchor_at is null and new.covered_months=0 and new.anchor_at is null and
    new.id=old.id and new.purchase_id=old.purchase_id and new.buyer_id=old.buyer_id and
    new.creator_id=old.creator_id and new.product_id=old.product_id and new.post_id=old.post_id and
    new.terms=old.terms and new.fingerprint=old.fingerprint and new.revision=old.revision+1 and
    exists(select 1 from public.monthly_manual_provider_publications_v1 j
      join public.monthly_manual_payment_selections_v1 m on m.id=j.selection_id
      join public.server_payment_protocols_v1 s on s.attempt_id=m.id
      join public.payment_fee_ledger l on l.id=j.ledger_id
      where j.agreement_id=old.id and j.customer_id=new.stripe_customer_id and
        j.subscription_id=new.stripe_subscription_id and m.agreement_id=old.id and
        m.kind='first' and m.payoff_id is null and m.buyer_id=old.buyer_id and
        m.context=old.terms->'paymentContext' and m.source->>'revision'=old.revision::text and
        m.source->>'agreementFingerprint'=old.fingerprint and s.kind='monthly_first' and
        s.reservation_id is null and s.buyer_id=old.buyer_id and s.product_id=old.product_id and
        s.source=to_jsonb(m) and l.purchase_id=old.purchase_id and l.creator_id=old.creator_id and
        l.status='paid' and l.earnings_credited_at is null and l.refunded_amount_cents=0 and
        l.earnings_reversed_cents=0 and l.stripe_checkout_session_id is null and l.stripe_invoice_id is null and
        j.proof->>'version'='monthly-mentorship-payment-proof-v1' and j.proof->>'buyerCountry'='US' and
        j.proof->'paymentContext'=m.context and j.proof->>'customerId'=j.customer_id and
        j.proof->>'subscriptionId'=j.subscription_id and j.proof->>'paymentIntentId'=l.stripe_payment_intent_id and
        j.proof->>'chargeId'=l.stripe_charge_id and j.proof#>>'{manualPayment,attemptId}'=m.id::text) then
    return new;
  end if;
  raise exception 'Monthly provider publication requires completed owned operations';
end;
$manual_publication$;
create or replace function public.record_monthly_manual_first_receipt_v1(
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
  -- This owner-only admission is created only after every original receipt
  -- source, confirmation, proof, fee, ledger and purchase check above passes.
  -- A later failure rolls it back with the receipt and financial credit.
  insert into public.monthly_manual_provider_publications_v1(
    agreement_id,selection_id,ledger_id,customer_id,subscription_id,proof)
    values(a.id,m.id,ledger.id,customer.provider_id,sub.provider_id,p_proof);
  update public.monthly_mentorship_agreements_v1 set
    stripe_customer_id=customer.provider_id,stripe_subscription_id=sub.provider_id,revision=revision+1
    where id=a.id;
  update public.purchases set subscription_id=sub.provider_id where id=a.purchase_id;
  return public.record_monthly_mentorship_receipt_v1(a.id,p_ledger_id,1,paid_at,
    public.monthly_mentorship_boundary_v1(paid_at,1),p_proof);
end $$;
commit;
