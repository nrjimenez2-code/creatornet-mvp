-- UNAPPLIED. Locked steps 1/7/8: receipt-backed PaymentIntent/charge observations.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regprocedure('public.record_monthly_mentorship_lifecycle_v1(uuid,uuid,jsonb,text,text,text,jsonb)') is null then
    raise exception 'Monthly payment-event prerequisites differ'; end if;
end; $preflight$;
create function public.record_monthly_mentorship_payment_event_v1(p_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_event_type text,p_outcome text,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; e public.monthly_mentorship_lifecycle_v1%rowtype;
  pf public.monthly_mentorship_payoffs_v1%rowtype; v_receipt jsonb; v_ledger uuid; v_amount bigint; v_received bigint; v_month integer;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context or
    a.stripe_customer_id is null or a.stripe_subscription_id is null or
    p_proof->>'version' is distinct from 'monthly-payment-event-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    not coalesce(p_event_id ~ '^evt_[A-Za-z0-9_]+$',false) or
    not coalesce(p_proof->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) or
    not coalesce(p_proof->>'paymentRequestId' ~ '^req_[A-Za-z0-9]+$',false) or
    not coalesce(p_proof->>'paymentIntentId' ~ '^pi_[A-Za-z0-9_]+$',false) or
    not coalesce(p_proof->>'amountCents' ~ '^[0-9]{1,8}$',false) or
    not coalesce(p_proof->>'amountReceivedCents' ~ '^[0-9]{1,8}$',false) or
    p_outcome is null or p_outcome not in ('observed','checkout_attention','review_required','reconciled') or
    p_event_type is null or p_event_type='charge.refunded' or p_event_type like 'charge.dispute.%' then
    raise exception 'Monthly payment-event identity or evidence differs'; end if;
  if not coalesce(case p_proof->>'objectType'
    when 'payment_intent' then p_event_type like 'payment_intent.%' and p_proof->>'objectId'=p_proof->>'paymentIntentId'
    when 'charge' then p_event_type like 'charge.%' and p_proof->>'objectId' ~ '^ch_[A-Za-z0-9_]+$'
    else false end,false) then raise exception 'Monthly payment-event object differs'; end if;
  v_amount:=(p_proof->>'amountCents')::bigint; v_received:=(p_proof->>'amountReceivedCents')::bigint;
  if p_proof->>'path'='first' then
    if p_proof->>'checkoutSessionId' is distinct from a.stripe_checkout_session_id or
      p_proof->>'invoiceId' is not null or p_proof->>'payoffId' is not null then raise exception 'First payment-event link differs'; end if;
    select ledger_id,provider_proof into v_ledger,v_receipt from public.monthly_mentorship_receipts_v1 where agreement_id=a.id and month_number=1;
  elsif p_proof->>'path'='renewal' then
    if not coalesce(p_proof->>'month' ~ '^[1-9][0-9]{0,8}$',false) or
      not coalesce(p_proof->>'invoiceId' ~ '^in_[A-Za-z0-9_]+$',false) or
      p_proof->>'checkoutSessionId' is not null or p_proof->>'payoffId' is not null then raise exception 'Renewal payment-event link differs'; end if;
    v_month:=(p_proof->>'month')::integer;
    if v_month<2 or not exists(select 1 from public.monthly_mentorship_operations_v1 o where o.agreement_id=a.id and
      o.kind='collect' and o.scope_key=v_month::text and o.request->>'path'='/v1/invoices/'||(p_proof->>'invoiceId')||'/pay') then
      raise exception 'Renewal payment-event has no collection admission'; end if;
    select ledger_id,provider_proof into v_ledger,v_receipt from public.monthly_mentorship_receipts_v1 where agreement_id=a.id and month_number=v_month;
  elsif p_proof->>'path'='payoff' then
    select * into pf from public.monthly_mentorship_payoffs_v1 where id::text=p_proof->>'payoffId' and agreement_id=a.id and buyer_id=a.buyer_id;
    if not found or pf.stripe_checkout_session_id is null or
      p_proof->>'checkoutSessionId' is distinct from pf.stripe_checkout_session_id or p_proof->>'invoiceId' is not null then
      raise exception 'Payoff payment-event link differs'; end if;
    if pf.status='captured' then v_ledger:=pf.ledger_id; v_receipt:=pf.provider_proof; end if;
  elsif p_proof->>'path'='unresolved' and p_outcome='review_required' then
    if p_proof->>'checkoutSessionId' is not null or p_proof->>'invoiceId' is not null or p_proof->>'payoffId' is not null then
      raise exception 'Unresolved event cannot invent a payment link'; end if;
  else raise exception 'Monthly payment-event path differs'; end if;
  if p_outcome='reconciled' then
    if v_receipt is null or v_ledger is null or p_proof->>'paymentStatus' is distinct from 'succeeded' or
      v_received<>v_amount or p_proof->>'chargeId' is distinct from v_receipt->>'chargeId' or
      p_proof->>'paymentIntentId' is distinct from v_receipt->>'paymentIntentId' or
      v_receipt->'paymentContext' is distinct from p_context or v_receipt->>'customerId' is distinct from a.stripe_customer_id or
      v_receipt->>'subscriptionId' is distinct from a.stripe_subscription_id or
      v_receipt->>'destinationId' is distinct from a.terms->>'destinationId' or
      v_receipt->>'capturedAmountCents' is distinct from v_amount::text or
      (p_proof->>'path'='renewal' and v_receipt->>'invoiceId' is distinct from p_proof->>'invoiceId') or
      (p_proof->>'path'<>'renewal' and v_receipt->>'checkoutSessionId' is distinct from p_proof->>'checkoutSessionId') or
      not exists(select 1 from public.payment_fee_ledger l where l.id=v_ledger and l.purchase_id=a.purchase_id and
        l.creator_id=a.creator_id and l.stripe_payment_intent_id=p_proof->>'paymentIntentId' and
        l.gross_amount_cents=v_amount and l.earnings_credited_at is not null) then
      raise exception 'Monthly payment-event needs actual matching captured receipt'; end if;
  end if;
  select * into e from public.monthly_mentorship_lifecycle_v1 where event_id=p_event_id for update;
  if found and (e.agreement_id<>a.id or e.event_type<>p_event_type or e.object_id is distinct from p_proof->>'objectId') then
    raise exception 'Monthly payment-event identity changed'; end if;
  if e.event_id is null then
    insert into public.monthly_mentorship_lifecycle_v1(event_id,agreement_id,event_type,object_id,first_observation,latest_observation,outcome)
      values(p_event_id,a.id,p_event_type,p_proof->>'objectId',p_proof,p_proof,p_outcome) returning * into e;
  else
    update public.monthly_mentorship_lifecycle_v1 set latest_observation=p_proof,last_observed_at=clock_timestamp(),
      outcome=case when outcome='review_required' then 'review_required'
        when outcome='reconciled' and p_outcome in ('observed','checkout_attention') then 'reconciled' else p_outcome end
      where event_id=p_event_id returning * into e;
  end if;
  if p_outcome='review_required' and a.billing_review_at is null then
    update public.monthly_mentorship_agreements_v1 set billing_review_at=clock_timestamp(),billing_review_reason=p_event_id,
      revision=revision+1,billing_next_attempt_at='infinity' where id=a.id;
  end if;
  -- Observation only: never a new ledger credit, paid month, access grant,
  -- refund, dispute debit, payoff release, provider stop or balance waiver.
  return to_jsonb(e);
end;
$$;
revoke all on function public.record_monthly_mentorship_payment_event_v1(uuid,uuid,jsonb,text,text,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.record_monthly_mentorship_payment_event_v1(uuid,uuid,jsonb,text,text,text,jsonb) to service_role;
commit;
