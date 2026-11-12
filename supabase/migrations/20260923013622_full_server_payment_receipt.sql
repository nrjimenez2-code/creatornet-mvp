begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Immutable original capture evidence only. Existing purchase/ledger/earnings
-- engines remain authoritative for accounting and entitlement.
create table public.full_server_payment_receipts_v1 (
  attempt_id uuid primary key references public.full_server_payment_sources_v1(attempt_id),
  payment_intent_id text not null unique,
  charge_id text not null unique,
  proof jsonb not null check(jsonb_typeof(proof)='object'),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.full_server_payment_receipts_v1 enable row level security;
revoke all on public.full_server_payment_receipts_v1 from public,anon,authenticated,service_role;
grant select on public.full_server_payment_receipts_v1 to service_role;

create function public.record_full_server_payment_receipt_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; op public.server_payment_intent_operations_v1%rowtype;
  phase public.server_payment_confirmations_v1%rowtype; consent public.product_purchase_consents_v1%rowtype;
  saved public.full_server_payment_receipts_v1%rowtype; c jsonb; fees jsonb; schedule jsonb; paid bigint; ends bigint;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if s.kind<>'full' then raise exception 'Original full-payment selection required'; end if;
  select contract into c from public.full_server_payment_sources_v1 where attempt_id=s.attempt_id;
  select * into op from public.server_payment_intent_operations_v1 where attempt_id=s.attempt_id;
  if c is null or op.bound_at is null or op.contract is distinct from c then raise exception 'Original full-payment intent required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(op.payment_intent_id,73591));
  if jsonb_typeof(p_proof) is distinct from 'object' or octet_length(p_proof::text)>100000 or
    p_proof-array['version','attemptId','buyerId','creatorId','productId','postId','orderId','purchaseConsentId',
      'termsFingerprint','context','confirmationOperationId','checkoutSessionId','customerId','paymentIntentId',
      'destinationId','amountCents','fees','chargeId','balanceTransactionId','transferId','paymentMethodId',
      'actualStripeFeeCents','paidAt','buyerCountry','serviceEndsAt']<>'{}'::jsonb or
    p_proof->>'version' is distinct from 'full-server-payment-capture-v1' or
    p_proof->>'attemptId' is distinct from s.attempt_id::text or p_proof->>'buyerId' is distinct from s.buyer_id::text or
    p_proof->>'creatorId' is distinct from c->>'creatorId' or p_proof->>'productId' is distinct from s.product_id::text or
    p_proof->'postId' is distinct from s.source->'post_id' or p_proof->>'orderId' is distinct from s.source->>'order_id' or
    p_proof->>'purchaseConsentId' is distinct from s.source->>'purchase_consent_id' or
    p_proof->>'termsFingerprint' is distinct from c->>'termsFingerprint' or p_proof->'context' is distinct from p_context or
    p_proof->'checkoutSessionId' is distinct from 'null'::jsonb or p_proof->'customerId' is distinct from 'null'::jsonb or
    p_proof->>'paymentIntentId' is distinct from op.payment_intent_id or p_proof->>'destinationId' is distinct from c->>'destinationId' or
    p_proof->'amountCents' is distinct from c->'amountCents' or p_proof->>'buyerCountry' is distinct from 'US' or
    coalesce(p_proof->>'chargeId','')!~'^ch_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'balanceTransactionId','')!~'^txn_[A-Za-z0-9]+$' or coalesce(p_proof->>'transferId','')!~'^tr_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'paymentMethodId','')!~'^pm_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'actualStripeFeeCents','')!~'^[0-9]{1,8}$' or coalesce(p_proof->>'paidAt','')!~'^[0-9]{1,12}$' then
    raise exception 'Full captured-payment proof differs'; end if;
  select * into phase from public.server_payment_confirmations_v1 where attempt_id=s.attempt_id and
    operation_id::text=p_proof->>'confirmationOperationId';
  if phase.operation_id is null or phase.payment_intent_id is distinct from op.payment_intent_id or
    phase.latest_observation->>'status' is distinct from 'succeeded' or
    phase.latest_observation->>'paymentIntentId' is distinct from op.payment_intent_id or
    phase.latest_observation->>'chargeId' is distinct from p_proof->>'chargeId' or
    phase.latest_observation->>'paymentMethodId' is distinct from p_proof->>'paymentMethodId' or
    exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=s.attempt_id and server_payment_confirmations_v1.phase>phase.phase) then
    raise exception 'Full receipt requires the original captured confirmation'; end if;
  select * into consent from public.product_purchase_consents_v1 where id::text=s.source->>'purchase_consent_id';
  if consent.id is null or consent.terms->>'kind' is distinct from 'one_time' or
    consent.terms->>'buyerId' is distinct from s.buyer_id::text or consent.terms->>'creatorId' is distinct from c->>'creatorId' or
    consent.terms->>'productId' is distinct from s.product_id::text or consent.terms->'postId' is distinct from p_proof->'postId' or
    consent.terms->'amountCents' is distinct from c->'amountCents' or consent.terms->>'currency' is distinct from 'usd' or
    consent.terms->>'version' is distinct from c#>>'{sourceMetadata,purchase_policy_version}' or
    floor(extract(epoch from consent.accepted_at)) is distinct from (c->>'acceptedAt')::numeric or
    consent.terms->>'serviceVersion' is distinct from c#>>'{sourceMetadata,fixed_service_version}' then
    raise exception 'Full receipt original consent differs'; end if;
  fees:=p_proof->'fees';schedule:=c->'processingFees';
  if not coalesce(public.valid_monthly_fee_snapshot_v1(fees,(c->>'amountCents')::integer),false) or
    fees->'processingFeeEnabled' is distinct from schedule->'enabled' or
    fees->'processingFeeBasisPoints' is distinct from schedule->'basisPoints' or
    fees->'processingFeeFixedCents' is distinct from schedule->'fixedCents' or
    fees->>'feeScheduleVersion' is distinct from schedule->>'version' then raise exception 'Full receipt economics differ'; end if;
  paid:=(p_proof->>'paidAt')::bigint;
  ends:=case when consent.terms->>'serviceMonths' is null then null else
    public.fixed_service_end_v1(paid,(consent.terms->>'serviceMonths')::integer) end;
  if paid<floor(extract(epoch from op.first_dispatch_at))-5 or paid<(c->>'acceptedAt')::bigint or
    paid>(c->>'expiresAt')::bigint or paid>floor(extract(epoch from clock_timestamp())) or
    p_proof->'serviceEndsAt' is distinct from coalesce(to_jsonb(ends),'null'::jsonb) then raise exception 'Full receipt capture dates differ'; end if;
  select * into saved from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id;
  if found then
    if saved.proof is distinct from p_proof then raise exception 'Original full receipt is immutable'; end if;
    return jsonb_build_object('recorded',false,'attemptId',s.attempt_id,'paymentIntentId',op.payment_intent_id,'accountingRequired',true);
  end if;
  -- Recording evidence never clears a stop or financial hold. It grants no
  -- access and claims no earnings; accounting must inspect those states.
  insert into public.full_server_payment_receipts_v1(attempt_id,payment_intent_id,charge_id,proof)
    values(s.attempt_id,op.payment_intent_id,p_proof->>'chargeId',p_proof);
  return jsonb_build_object('recorded',true,'attemptId',s.attempt_id,'paymentIntentId',op.payment_intent_id,'accountingRequired',true);
end $$;
revoke all on function public.record_full_server_payment_receipt_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_full_server_payment_receipt_v1(uuid,uuid,jsonb,jsonb) to service_role;

do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.read_server_payment_source_v1(uuid,uuid,jsonb,boolean)'::regprocedure);
  needle:=$old$  if p_for_dispatch then
    select * into a$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Manual dispatch source guard differs'; end if;
  execute replace(source,needle,$new$  if p_for_dispatch then
    if exists(select 1 from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id) then
      raise exception 'Full payment already captured'; end if;
    select * into a$new$);
end $patch$;
commit;
