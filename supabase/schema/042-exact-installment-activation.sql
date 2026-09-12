begin;

-- Prospective held plans only. Apply after 019, 021, 040 and 041, following
-- staging review. No Stripe calls, automatic collection or legacy backfill.
create table public.exact_installment_activations (
  agreement_id uuid primary key references public.exact_installment_agreements(id) on delete restrict,
  activation_snapshot jsonb not null,
  status text not null check (status in ('running', 'complete')),
  claim_token uuid not null,
  lease_until timestamptz not null,
  first_started_at timestamptz not null default now(),
  activated_at timestamptz,
  check ((status = 'complete') = (activated_at is not null))
);
create table public.exact_installment_periods (
  agreement_id uuid not null references public.exact_installment_agreements(id) on delete restrict,
  payment_number integer not null check (payment_number between 2 and 24),
  due_at bigint not null,
  period_end bigint not null check (period_end > due_at),
  amount_cents bigint not null check (amount_cents between 50 and 99999999),
  application_fee_cents bigint not null check (application_fee_cents between 0 and amount_cents),
  primary key (agreement_id, payment_number),
  unique (agreement_id, due_at)
);
alter table public.exact_installment_activations enable row level security;
alter table public.exact_installment_periods enable row level security;
revoke all on public.exact_installment_activations, public.exact_installment_periods
  from public, anon, authenticated, service_role;
grant select on public.exact_installment_activations, public.exact_installment_periods to service_role;

-- Timestamp arithmetic is explicitly UTC and clamps the day in a short month.
-- Each offset is anchored on the supplied date, never repeatedly adds 30 days.
create function public.exact_installment_month(p_anchor bigint, p_months integer)
returns bigint language plpgsql immutable set search_path = public, pg_temp as $$
declare origin timestamp; target timestamp; last_day integer;
begin
  if p_anchor is null or p_anchor not between 1 and 253402300799 or
     p_months is null or p_months not between 0 and 24 then raise exception 'invalid month boundary'; end if;
  origin := to_timestamp(p_anchor) at time zone 'UTC';
  target := date_trunc('month', origin) + make_interval(months => p_months);
  last_day := extract(day from target + interval '1 month - 1 day')::integer;
  target := target + make_interval(days => least(extract(day from origin)::integer, last_day) - 1)
    + (origin - date_trunc('day', origin));
  return extract(epoch from target at time zone 'UTC')::bigint;
end;
$$;

-- Locks are agreement -> ledger -> purchase, consistent with receipt credit.
-- This is a conservative activation stop, NOT a new cancellation/refund policy.
-- Any refund, unresolved dispute, closed purchase or in-flight admin refund
-- requires reconciliation; this RPC never resumes collection or reverses money.
create function public.assert_exact_installment_activation_ready(p_agreement_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  r public.exact_installment_receipts%rowtype;
  l public.payment_fee_ledger%rowtype;
  p public.purchases%rowtype;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status <> 'awaiting_first' or a.purchase_id is null then raise exception 'activation agreement not ready'; end if;
  select * into r from public.exact_installment_receipts where agreement_id=a.id and payment_number=1;
  if not found or r.counted_at is null or r.ledger_id is null or r.paid_at > now() then
    raise exception 'credited first receipt required'; end if;
  select * into l from public.payment_fee_ledger where id=r.ledger_id for update;
  if not found or l.purchase_id is distinct from a.purchase_id or
     l.creator_id::text is distinct from a.terms->>'creatorId' or l.booking_payment_id is distinct from a.booking_payment_id or
     l.stripe_payment_intent_id is distinct from r.stripe_payment_intent_id or l.earnings_credited_at is null or
     l.status <> 'paid' or l.refunded_amount_cents <> 0 or l.earnings_reversed_cents <> 0 or
     (l.dispute_status is not null and l.dispute_status <> 'won') then raise exception 'first ledger requires review'; end if;
  select * into p from public.purchases where id=a.purchase_id for update;
  if not found or p.status <> 'active' or not p.access_granted or p.paid_count <> 1 or
     p.subscription_id is distinct from a.stripe_subscription_id or
     p.session_id is distinct from a.stripe_checkout_session_id or p.creator_id::text is distinct from a.terms->>'creatorId' or
     p.buyer_id::text is distinct from a.terms->>'buyerId' or p.post_id::text is distinct from a.terms->>'postId' or
     p.product_id::text is distinct from a.terms->>'productId' or p.booking_id::text is distinct from a.terms->>'bookingId' or
     p.target_months is distinct from (a.terms->>'paymentCount')::integer or
     p.payment_intent_id is distinct from r.stripe_payment_intent_id then raise exception 'activation purchase not ready'; end if;
  if not exists (select 1 from public.bookings where id=(a.terms->>'bookingId')::uuid and
       buyer_id::text=a.terms->>'buyerId' and creator_id::text=a.terms->>'creatorId' and post_id::text=a.terms->>'postId' and
       status::text in ('booked','completed')) or
     not exists (select 1 from public.booking_payments where id=a.booking_payment_id and
       booking_id::text=a.terms->>'bookingId' and buyer_id::text=a.terms->>'buyerId' and product_id::text=a.terms->>'productId' and
       status::text in ('pending','link_sent','completed')) or
     exists (select 1 from public.payment_refund_state where stripe_payment_intent_id=r.stripe_payment_intent_id and refunded_amount_cents>0) or
     exists (select 1 from public.payment_dispute_state where stripe_payment_intent_id=r.stripe_payment_intent_id and status<>'won') or
     exists (select 1 from public.refund_operations where stripe_payment_intent_id=r.stripe_payment_intent_id and
       (status<>'failed' or stripe_refund_id is not null)) then raise exception 'activation reconciliation required'; end if;
end;
$$;

create function public.claim_exact_installment_activation(p_agreement_id uuid, p_payment_method_id text,
  p_subscription_item_id text, p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  r public.exact_installment_receipts%rowtype;
  op public.exact_installment_activations%rowtype;
  authorized jsonb;
  first_paid bigint;
  renewal bigint;
begin
  if p_payment_method_id is null or p_payment_method_id !~ '^pm_[a-zA-Z0-9]+$' or
     p_subscription_item_id is null or p_subscription_item_id !~ '^si_[a-zA-Z0-9]+$' or p_claim_token is null then
    raise exception 'invalid activation identity'; end if;
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status not in ('awaiting_first','active','complete') then raise exception 'activation agreement not ready'; end if;
  select * into r from public.exact_installment_receipts where agreement_id=a.id and payment_number=1;
  if not found or r.counted_at is null then raise exception 'credited first receipt required'; end if;
  first_paid := floor(extract(epoch from r.paid_at))::bigint;
  renewal := public.exact_installment_month(first_paid,1);
  authorized := jsonb_build_object('agreementId',a.id,'firstPaymentIntentId',r.stripe_payment_intent_id,
    'firstPaidAt',first_paid,'paymentMethodId',p_payment_method_id,'subscriptionItemId',p_subscription_item_id,
    'firstRenewalAt',renewal,'cancelAt',public.exact_installment_month(renewal,(a.terms->>'paymentCount')::integer-1));
  select * into op from public.exact_installment_activations where agreement_id=a.id for update;
  if found then
    if op.activation_snapshot is distinct from authorized then raise exception 'activation parameters changed'; end if;
    if op.status='complete' then
      if a.status not in ('active','complete') then raise exception 'activation state inconsistent'; end if;
      return jsonb_build_object('status','complete','authorization',authorized);
    end if;
    if now() >= op.first_started_at + interval '20 hours' then
      update public.exact_installment_agreements set status='review_required',updated_at=now() where id=a.id;
      return jsonb_build_object('status','review_required');
    end if;
    if op.lease_until>now() then return jsonb_build_object('status','busy'); end if;
  end if;
  perform public.assert_exact_installment_activation_ready(a.id);
  if now() >= a.created_at + interval '48 hours' or extract(epoch from now()) >= renewal then
    raise exception 'activation bootstrap window expired'; end if;
  insert into public.exact_installment_activations(agreement_id,activation_snapshot,status,claim_token,lease_until)
    values(a.id,authorized,'running',p_claim_token,now()+interval '3 minutes')
    on conflict(agreement_id) do update set claim_token=excluded.claim_token,lease_until=excluded.lease_until;
  return jsonb_build_object('status','new','authorization',authorized);
end;
$$;

-- The caller has verified Stripe's returned anchor, fixed end, correct existing
-- card and indefinite hold. Recheck local state before declaring activation.
-- Periods are EXPECTATIONS, not permission to collect or evidence of payment.
create function public.complete_exact_installment_activation(p_agreement_id uuid, p_claim_token uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  op public.exact_installment_activations%rowtype;
  n integer; k integer; total bigint; gross bigint; deduction bigint; renewal bigint; schedule jsonb;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found then raise exception 'agreement missing'; end if;
  select * into op from public.exact_installment_activations where agreement_id=a.id for update;
  if not found or op.status<>'running' or op.claim_token is distinct from p_claim_token or op.lease_until<=now() then
    raise exception 'activation claim lost'; end if;
  perform public.assert_exact_installment_activation_ready(a.id);
  renewal := (op.activation_snapshot->>'firstRenewalAt')::bigint;
  if extract(epoch from now()) >= renewal then raise exception 'activation renewal already due'; end if;
  n := (a.terms->>'paymentCount')::integer; total := (a.terms->>'totalCents')::bigint;
  schedule := a.terms->'renewalFeeSchedule';
  for k in 2..n loop
    gross := total / n + case when k=n then total % n else 0 end;
    deduction := round(gross::numeric*1200/10000)::bigint;
    if (schedule->>'enabled')::boolean then deduction := deduction +
      round(gross::numeric*(schedule->>'basisPoints')::integer/10000)::bigint + (schedule->>'fixedCents')::bigint; end if;
    insert into public.exact_installment_periods(agreement_id,payment_number,due_at,period_end,amount_cents,application_fee_cents)
    values(a.id,k,public.exact_installment_month(renewal,k-2),public.exact_installment_month(renewal,k-1),gross,deduction);
  end loop;
  update public.exact_installment_activations set status='complete',activated_at=now() where agreement_id=a.id;
  update public.exact_installment_agreements set status='active',updated_at=now() where id=a.id;
end;
$$;

revoke all on function public.exact_installment_month(bigint,integer),
  public.assert_exact_installment_activation_ready(uuid),
  public.claim_exact_installment_activation(uuid,text,text,uuid),
  public.complete_exact_installment_activation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_exact_installment_activation(uuid,text,text,uuid),
  public.complete_exact_installment_activation(uuid,uuid) to service_role;
-- Internal helpers intentionally receive no direct service-role grant.
commit;
