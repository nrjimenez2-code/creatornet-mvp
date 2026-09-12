begin;

-- Prospective Sandbox candidate, after 040-042. No enabled route, scheduler,
-- legacy backfill, automatic retries or Stripe request is installed by SQL.
create table public.exact_installment_invoice_claims (
  agreement_id uuid not null,
  payment_number integer not null,
  stripe_invoice_id text not null unique check (stripe_invoice_id ~ '^in_[a-zA-Z0-9]+$'),
  stripe_payment_intent_id text unique check (stripe_payment_intent_id ~ '^pi_[a-zA-Z0-9]+$'),
  status text not null check (status in ('preparing','prepared','dispatching','paid','review_required')),
  claim_token uuid not null,
  lease_until timestamptz not null,
  first_started_at timestamptz not null default now(),
  dispatch_started_at timestamptz,
  primary key (agreement_id,payment_number),
  foreign key (agreement_id,payment_number) references public.exact_installment_periods on delete restrict,
  check (status not in ('prepared','dispatching','paid') or stripe_payment_intent_id is not null),
  check (status <> 'dispatching' or dispatch_started_at is not null)
);
alter table public.exact_installment_invoice_claims enable row level security;
revoke all on public.exact_installment_invoice_claims from public,anon,authenticated,service_role;
grant select on public.exact_installment_invoice_claims to service_role;

-- Conservative admission check, not a new cancellation/refund policy. Every
-- prior installment must be credited. An ambiguous refund/dispute is held for
-- review; no missed-period catch-up charge after that period ends.
create function public.assert_exact_installment_renewal_ready(p_agreement_id uuid,p_number integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  p public.purchases%rowtype;
  period public.exact_installment_periods%rowtype;
  n integer;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status<>'active' or a.purchase_id is null then raise exception 'renewal agreement not active'; end if;
  select * into period from public.exact_installment_periods
    where agreement_id=a.id and payment_number=p_number;
  if not found or extract(epoch from now())<period.due_at or extract(epoch from now())>=period.period_end then
    raise exception 'renewal is outside its authorized period'; end if;
  if not exists(select 1 from public.exact_installment_activations where agreement_id=a.id and status='complete') then
    raise exception 'activation not complete'; end if;
  -- Consistent agreement -> ledger -> purchase order. Lock all prior ledgers
  -- before examining the refund mirrors, never just the most recent charge.
  perform 1 from public.payment_fee_ledger l join public.exact_installment_receipts r on r.ledger_id=l.id
    where r.agreement_id=a.id order by r.payment_number for update of l;
  select * into p from public.purchases where id=a.purchase_id for update;
  n:=(a.terms->>'paymentCount')::integer;
  if not found or p.status<>'active' or p.access_granted is distinct from true or
    p.paid_count is distinct from p_number-1 or p.target_months is distinct from n or
    p.subscription_id is distinct from a.stripe_subscription_id or p.session_id is distinct from a.stripe_checkout_session_id or
    p.buyer_id::text is distinct from a.terms->>'buyerId' or p.creator_id::text is distinct from a.terms->>'creatorId' or
    p.booking_id::text is distinct from a.terms->>'bookingId' or p.post_id::text is distinct from a.terms->>'postId' or
    p.product_id::text is distinct from a.terms->>'productId' or lower(p.currency) is distinct from 'usd' then
    raise exception 'renewal purchase not ready'; end if;
  if (select count(*) from public.exact_installment_receipts where agreement_id=a.id and counted_at is not null)<>p_number-1 or
    (select count(*) from public.exact_installment_receipts r join public.payment_fee_ledger l on l.id=r.ledger_id
      where r.agreement_id=a.id and r.payment_number<p_number and r.counted_at is not null and
        l.earnings_credited_at is not null and l.purchase_id=a.purchase_id and
        l.creator_id::text=a.terms->>'creatorId' and l.booking_payment_id=a.booking_payment_id and
        l.stripe_payment_intent_id=r.stripe_payment_intent_id and l.status='paid' and
        l.refunded_amount_cents=0 and l.earnings_reversed_cents=0 and
        (l.dispute_status is null or l.dispute_status='won'))<>p_number-1 then
    raise exception 'prior receipts or ledgers require review'; end if;
  if exists(select 1 from public.exact_installment_receipts r where r.agreement_id=a.id and (
    exists(select 1 from public.payment_refund_state f where f.stripe_payment_intent_id=r.stripe_payment_intent_id and f.refunded_amount_cents>0) or
    exists(select 1 from public.payment_dispute_state d where d.stripe_payment_intent_id=r.stripe_payment_intent_id and d.status<>'won') or
    exists(select 1 from public.refund_operations o where o.stripe_payment_intent_id=r.stripe_payment_intent_id and
      (o.status<>'failed' or o.stripe_refund_id is not null)))) or
    not exists(select 1 from public.bookings where id=(a.terms->>'bookingId')::uuid and
      buyer_id=p.buyer_id and creator_id=p.creator_id and post_id=p.post_id and status::text in ('booked','completed')) or
    not exists(select 1 from public.booking_payments where id=a.booking_payment_id and
      booking_id=p.booking_id and buyer_id=p.buyer_id and product_id=p.product_id and status::text in ('pending','link_sent','completed')) then
    raise exception 'renewal reconciliation required'; end if;
end;
$$;

-- Invoice identity and period come from a Stripe retrieve on the server. The
-- RPC derives the amounts, item, customer and dates from immutable local state.
create function public.claim_exact_installment_invoice(p_agreement_id uuid,p_invoice_id text,
  p_subscription_id text,p_period_start bigint,p_period_end bigint,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  period public.exact_installment_periods%rowtype;
  op public.exact_installment_invoice_claims%rowtype;
  act public.exact_installment_activations%rowtype;
  authorized jsonb;
begin
  if p_invoice_id is null or p_invoice_id !~ '^in_[a-zA-Z0-9]+$' or p_claim_token is null then
    raise exception 'invalid renewal identity'; end if;
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.stripe_subscription_id is distinct from p_subscription_id then raise exception 'renewal subscription mismatch'; end if;
  select * into period from public.exact_installment_periods where agreement_id=a.id and
    due_at=p_period_start and period_end=p_period_end;
  if not found then raise exception 'no matching scheduled period'; end if;
  select * into act from public.exact_installment_activations where agreement_id=a.id and status='complete';
  if not found then raise exception 'activation not complete'; end if;
  authorized:=jsonb_build_object('planId',a.id,'bookingPaymentId',a.booking_payment_id,'invoiceId',p_invoice_id,
    'subscriptionId',a.stripe_subscription_id,'subscriptionItemId',act.activation_snapshot->>'subscriptionItemId',
    'customerId',a.stripe_customer_id,'destinationId',a.terms->>'destinationId','currency','usd',
    'totalCents',(a.terms->>'totalCents')::bigint,'paymentCount',(a.terms->>'paymentCount')::integer,
    'paymentNumber',period.payment_number,'periodStart',period.due_at,'periodEnd',period.period_end,
    'cancelAt',(act.activation_snapshot->>'cancelAt')::bigint,'feeSchedule',a.terms->'renewalFeeSchedule',
    'paymentMethodId',act.activation_snapshot->>'paymentMethodId');
  select * into op from public.exact_installment_invoice_claims
    where agreement_id=a.id and payment_number=period.payment_number for update;
  if found then
    if op.stripe_invoice_id<>p_invoice_id then raise exception 'another invoice already bound to period'; end if;
    -- Once dispatch is admitted, NEVER permit a second pay attempt through an
    -- expired lease or an expired Stripe idempotency key. Reconcile by retrieve.
    if op.status in ('dispatching','paid','review_required') then
      return jsonb_build_object('status','reconcile','authorization',authorized,'paymentIntentId',op.stripe_payment_intent_id); end if;
    if now()>=op.first_started_at+interval '20 hours' then
      update public.exact_installment_invoice_claims set status='review_required' where agreement_id=a.id and payment_number=period.payment_number;
      return jsonb_build_object('status','reconcile','authorization',authorized,'paymentIntentId',op.stripe_payment_intent_id); end if;
    if op.lease_until>now() then return jsonb_build_object('status','busy'); end if;
  end if;
  perform public.assert_exact_installment_renewal_ready(a.id,period.payment_number);
  insert into public.exact_installment_invoice_claims(agreement_id,payment_number,stripe_invoice_id,status,claim_token,lease_until)
    values(a.id,period.payment_number,p_invoice_id,'preparing',p_claim_token,now()+interval '3 minutes')
    on conflict(agreement_id,payment_number) do update set claim_token=excluded.claim_token,lease_until=excluded.lease_until;
  return jsonb_build_object('status','prepare','authorization',authorized);
end;
$$;

create function public.prepare_exact_installment_dispatch(p_agreement_id uuid,p_invoice_id text,
  p_payment_intent_id text,p_claim_token uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare op public.exact_installment_invoice_claims%rowtype;
begin
  perform 1 from public.exact_installment_agreements where id=p_agreement_id for update;
  select * into op from public.exact_installment_invoice_claims where agreement_id=p_agreement_id and stripe_invoice_id=p_invoice_id for update;
  if not found or op.status not in ('preparing','prepared') or op.claim_token is distinct from p_claim_token or op.lease_until<=now() then
    raise exception 'renewal preparation claim lost'; end if;
  if p_payment_intent_id is null or p_payment_intent_id !~ '^pi_[a-zA-Z0-9]+$' or
    (op.stripe_payment_intent_id is not null and op.stripe_payment_intent_id<>p_payment_intent_id) then
    raise exception 'invoice PaymentIntent changed'; end if;
  perform public.assert_exact_installment_renewal_ready(p_agreement_id,op.payment_number);
  update public.exact_installment_invoice_claims set status='prepared',stripe_payment_intent_id=p_payment_intent_id
    where agreement_id=p_agreement_id and payment_number=op.payment_number;
end;
$$;

create function public.admit_exact_installment_dispatch(p_agreement_id uuid,p_invoice_id text,p_claim_token uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare op public.exact_installment_invoice_claims%rowtype;
begin
  perform 1 from public.exact_installment_agreements where id=p_agreement_id for update;
  select * into op from public.exact_installment_invoice_claims where agreement_id=p_agreement_id and stripe_invoice_id=p_invoice_id for update;
  if not found or op.status<>'prepared' or op.claim_token is distinct from p_claim_token or op.lease_until<=now() then
    raise exception 'renewal dispatch claim lost'; end if;
  perform public.assert_exact_installment_renewal_ready(p_agreement_id,op.payment_number);
  update public.exact_installment_invoice_claims set status='dispatching',dispatch_started_at=now()
    where agreement_id=p_agreement_id and payment_number=op.payment_number;
  -- Admission is not a payment. Never mark paid or credit here. Integrators
  -- must coordinate cancellation/refund admission before enabling callers.
end;
$$;

-- A delayed succeeded event can record evidence even after a plan is held or
-- canceled; accounting/access rules remain in 041 and are NOT bypassed here.
create function public.record_exact_installment_renewal_receipt(p_agreement_id uuid,p_invoice_id text,
  p_payment_intent_id text,p_amount_cents bigint,p_application_fee_cents bigint,p_paid_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  op public.exact_installment_invoice_claims%rowtype;
  period public.exact_installment_periods%rowtype;
  r public.exact_installment_receipts%rowtype;
begin
  perform 1 from public.exact_installment_agreements where id=p_agreement_id for update;
  select * into op from public.exact_installment_invoice_claims where agreement_id=p_agreement_id and stripe_invoice_id=p_invoice_id for update;
  if not found or op.status not in ('dispatching','paid') or op.stripe_payment_intent_id is distinct from p_payment_intent_id then
    raise exception 'receipt has no admitted invoice payment'; end if;
  select * into period from public.exact_installment_periods where agreement_id=p_agreement_id and payment_number=op.payment_number;
  if p_amount_cents is distinct from period.amount_cents or p_application_fee_cents is distinct from period.application_fee_cents or
    p_paid_at is null or p_paid_at>now() or p_paid_at<op.dispatch_started_at-interval '1 second' then
    raise exception 'renewal receipt evidence mismatch'; end if;
  select * into r from public.exact_installment_receipts where agreement_id=p_agreement_id and payment_number=op.payment_number;
  if found then
    if r.stripe_invoice_id is distinct from p_invoice_id or r.stripe_payment_intent_id is distinct from p_payment_intent_id or
      r.amount_cents is distinct from p_amount_cents or r.application_fee_cents is distinct from p_application_fee_cents or
      r.paid_at is distinct from p_paid_at then raise exception 'renewal receipt changed'; end if;
    return false;
  end if;
  insert into public.exact_installment_receipts(agreement_id,payment_number,stripe_payment_intent_id,stripe_invoice_id,
    amount_cents,application_fee_cents,paid_at) values(p_agreement_id,op.payment_number,p_payment_intent_id,p_invoice_id,
    p_amount_cents,p_application_fee_cents,p_paid_at);
  update public.exact_installment_invoice_claims set status='paid' where agreement_id=p_agreement_id and payment_number=op.payment_number;
  return true;
end;
$$;

create function public.complete_exact_installment_agreement(p_agreement_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; p public.purchases%rowtype; n integer;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status not in ('active','complete') then raise exception 'agreement cannot complete'; end if;
  n:=(a.terms->>'paymentCount')::integer;
  select * into p from public.purchases where id=a.purchase_id for update;
  if not found or p.status<>'complete' or p.paid_count is distinct from n or
    p.subscription_id is distinct from a.stripe_subscription_id or p.session_id is distinct from a.stripe_checkout_session_id or
    (select count(*) from public.exact_installment_receipts where agreement_id=a.id and counted_at is not null)<>n or
    (select sum(amount_cents) from public.exact_installment_receipts where agreement_id=a.id) is distinct from (a.terms->>'totalCents')::bigint or
    (select count(*) from public.exact_installment_invoice_claims where agreement_id=a.id and status='paid')<>n-1 then
    raise exception 'all exact installment receipts must be credited'; end if;
  update public.exact_installment_agreements set status='complete',updated_at=now() where id=a.id;
  -- Stripe's fixed cancel_at remains unchanged. No resumption or extra charge.
end;
$$;

revoke all on function public.assert_exact_installment_renewal_ready(uuid,integer),
  public.claim_exact_installment_invoice(uuid,text,text,bigint,bigint,uuid),
  public.prepare_exact_installment_dispatch(uuid,text,text,uuid),
  public.admit_exact_installment_dispatch(uuid,text,uuid),
  public.record_exact_installment_renewal_receipt(uuid,text,text,bigint,bigint,timestamptz),
  public.complete_exact_installment_agreement(uuid)
  from public,anon,authenticated;
grant execute on function public.claim_exact_installment_invoice(uuid,text,text,bigint,bigint,uuid),
  public.prepare_exact_installment_dispatch(uuid,text,text,uuid),
  public.admit_exact_installment_dispatch(uuid,text,uuid),
  public.record_exact_installment_renewal_receipt(uuid,text,text,bigint,bigint,timestamptz),
  public.complete_exact_installment_agreement(uuid) to service_role;
commit;
