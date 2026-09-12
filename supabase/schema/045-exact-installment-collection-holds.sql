begin;

-- Prospective candidate only, after 021 and 040-044. A collection hold is NOT debt
-- forgiveness, a Stripe cancellation, an access change, or a refund approval.
-- No automatic release: failed/ambiguous refunds require explicit review.
create table public.exact_installment_collection_holds (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.exact_installment_agreements on delete restrict,
  reason text not null check(reason in ('admin_refund','cancellation_review')),
  request_id uuid not null unique,
  refund_operation_id uuid unique references public.refund_operations on delete restrict,
  requested_by uuid not null references public.profiles on delete restrict,
  created_at timestamptz not null default now(),
  check ((reason='admin_refund' and refund_operation_id is not null and request_id=refund_operation_id)
    or (reason='cancellation_review' and refund_operation_id is null))
);
create index exact_installment_collection_holds_agreement on public.exact_installment_collection_holds(agreement_id);
alter table public.exact_installment_collection_holds enable row level security;
revoke all on public.exact_installment_collection_holds from public,anon,authenticated,service_role;
grant select on public.exact_installment_collection_holds to service_role;

-- Preserve the existing function identity and all 043 admission checks. Every
-- caller still locks the SAME agreement row, so a hold and new invoice admission
-- cannot pass each other. No renamed old assertion remains as a bypass.
create or replace function public.assert_exact_installment_renewal_ready(p_agreement_id uuid,p_number integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  p public.purchases%rowtype;
  period public.exact_installment_periods%rowtype;
  n integer;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status<>'active' or a.purchase_id is null then raise exception 'renewal agreement not active'; end if;
  if exists(select 1 from public.exact_installment_collection_holds where agreement_id=p_agreement_id) then
    raise exception 'installment collection is held for review'; end if;
  select * into period from public.exact_installment_periods
    where agreement_id=a.id and payment_number=p_number;
  if not found or extract(epoch from now())<period.due_at or extract(epoch from now())>=period.period_end then
    raise exception 'renewal is outside its authorized period'; end if;
  if not exists(select 1 from public.exact_installment_activations where agreement_id=a.id and status='complete') then
    raise exception 'activation not complete'; end if;
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

-- Support must verify the request and authenticated administrator before calling.
-- This ONLY stops future renewal admission; an open first Checkout or an admitted
-- charge can still finish. Stripe cleanup, effective cancellation and access are
-- deliberately separate. Reusing a request for another plan/actor fails closed.
create function public.hold_exact_installment_for_cancellation(p_agreement_id uuid,p_request_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare h public.exact_installment_collection_holds%rowtype;
begin
  if p_request_id is null or p_actor_id is null or not exists(
    select 1 from public.profiles where id=p_actor_id and role='admin') then
    raise exception 'verified administrator required'; end if;
  perform 1 from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found then raise exception 'installment agreement missing'; end if;
  insert into public.exact_installment_collection_holds(agreement_id,reason,request_id,requested_by)
    values(p_agreement_id,'cancellation_review',p_request_id,p_actor_id) on conflict(request_id) do nothing;
  select * into h from public.exact_installment_collection_holds where request_id=p_request_id;
  if not found or h.agreement_id is distinct from p_agreement_id or h.reason<>'cancellation_review' or
    h.requested_by is distinct from p_actor_id then raise exception 'collection hold request changed'; end if;
  return h.id;
end;
$$;

-- Called after the existing refund processor claims its operation, BEFORE any
-- Stripe refund mutation. Mapping uses immutable receipt/ledger IDs, not the
-- purchase's latest PaymentIntent or an invoice ID (first payment has none).
-- Lock order: agreement -> refund operation. Never add an agreement-locking
-- trigger to 021's ledger-first reservation; that would invert collector locks.
create function public.admit_exact_installment_admin_refund(p_operation_id uuid,p_processing_token uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare
  o public.refund_operations%rowtype;
  a public.exact_installment_agreements%rowtype;
  h public.exact_installment_collection_holds%rowtype;
  agreement_id uuid;
begin
  select * into o from public.refund_operations where id=p_operation_id;
  if not found or p_processing_token is null then raise exception 'refund operation missing'; end if;
  select r.agreement_id into agreement_id from public.exact_installment_receipts r
    where r.stripe_payment_intent_id=o.stripe_payment_intent_id;
  if agreement_id is null then
    -- A bound exact purchase without the required immutable receipt must not
    -- be misclassified as an ordinary legacy refund.
    if exists(select 1 from public.payment_fee_ledger l join public.exact_installment_agreements existing_agreement
      on existing_agreement.purchase_id=l.purchase_id or existing_agreement.booking_payment_id=l.booking_payment_id
      where l.id=o.payment_fee_ledger_id) or exists(select 1 from public.exact_installment_invoice_claims c
      where c.stripe_payment_intent_id=o.stripe_payment_intent_id) then
      raise exception 'exact refund receipt requires reconciliation'; end if;
    return 'not_applicable';
  end if;
  select * into a from public.exact_installment_agreements where id=agreement_id for update;
  select * into o from public.refund_operations where id=p_operation_id for update;
  if o.processing_token is distinct from p_processing_token or o.processing_claimed_at is null or
    o.processing_claimed_at<=now()-interval '5 minutes' or o.status in ('failed','completed') or
    not exists(select 1 from public.profiles where id=o.initiated_by and role='admin') then
    raise exception 'refund processing claim or administrator invalid'; end if;
  if not exists(select 1 from public.exact_installment_receipts r join public.payment_fee_ledger l on l.id=r.ledger_id
    where r.agreement_id=a.id and r.stripe_payment_intent_id=o.stripe_payment_intent_id and
      r.ledger_id=o.payment_fee_ledger_id and r.counted_at is not null and l.earnings_credited_at is not null and
      l.stripe_payment_intent_id=r.stripe_payment_intent_id and l.purchase_id=a.purchase_id and
      l.booking_payment_id=a.booking_payment_id and l.creator_id=o.creator_id and
      l.creator_id::text=a.terms->>'creatorId') then raise exception 'refund receipt identity mismatch'; end if;
  insert into public.exact_installment_collection_holds(agreement_id,reason,request_id,refund_operation_id,requested_by)
    values(a.id,'admin_refund',o.id,o.id,o.initiated_by) on conflict(request_id) do nothing;
  select * into h from public.exact_installment_collection_holds where request_id=o.id;
  if not found or h.agreement_id is distinct from a.id or h.reason<>'admin_refund' or
    h.refund_operation_id is distinct from o.id or h.requested_by is distinct from o.initiated_by then
    raise exception 'refund collection hold identity mismatch'; end if;

  -- An elapsed lease is NOT proof that a dispatched charge failed. A paid Stripe
  -- receipt without atomic local credit is also unresolved. Persist the hold and
  -- return (do not raise/roll back it) until that evidence has been reconciled.
  if exists(select 1 from public.exact_installment_invoice_claims c where c.agreement_id=a.id and
    (c.status='dispatching' or (c.dispatch_started_at is not null and (c.status<>'paid' or not exists(
      select 1 from public.exact_installment_receipts r join public.payment_fee_ledger l on l.id=r.ledger_id
      where r.agreement_id=c.agreement_id and r.payment_number=c.payment_number and
        r.stripe_payment_intent_id=c.stripe_payment_intent_id and r.stripe_invoice_id=c.stripe_invoice_id and
        r.counted_at is not null and l.earnings_credited_at is not null and l.purchase_id=a.purchase_id))))) or
    exists(select 1 from public.exact_installment_receipts r where r.agreement_id=a.id and r.counted_at is null) then
    return 'reconciliation_required';
  end if;
  return 'held';
end;
$$;

revoke all on function public.assert_exact_installment_renewal_ready(uuid,integer),
  public.hold_exact_installment_for_cancellation(uuid,uuid,uuid),
  public.admit_exact_installment_admin_refund(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.hold_exact_installment_for_cancellation(uuid,uuid,uuid),
  public.admit_exact_installment_admin_refund(uuid,uuid) to service_role;
commit;
