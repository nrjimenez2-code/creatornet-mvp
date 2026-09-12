begin;

-- Local, prospective Sandbox candidate. One confirmed buyer action permits
-- ONE new attempt on the ORIGINAL invoice/PI. No lease, reset, default-card
-- replacement, financial evidence rewrite, or collection-hold release.
create table public.exact_installment_retry_admissions (
  confirmation_id uuid primary key references public.exact_installment_payment_confirmations on delete restrict,
  agreement_id uuid not null references public.exact_installment_agreements on delete restrict,
  stripe_invoice_id text not null unique references public.exact_installment_invoice_claims(stripe_invoice_id) on delete restrict,
  admitted_at timestamptz not null default now()
);
alter table public.exact_installment_retry_admissions enable row level security;
revoke all on public.exact_installment_retry_admissions from public,anon,authenticated,service_role;
grant select on public.exact_installment_retry_admissions to service_role;

create function public.admit_exact_installment_retry(p_confirmation_id uuid,p_buyer_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.exact_installment_payment_confirmations%rowtype;
  s public.exact_installment_card_setups%rowtype; a public.exact_installment_agreements%rowtype;
  p public.purchases%rowtype; period public.exact_installment_periods%rowtype; number integer; n integer;
begin
  select * into q from public.exact_installment_payment_confirmations where id=p_confirmation_id and buyer_id=p_buyer_id;
  if not found or p_buyer_id is null then raise exception 'retry confirmation unavailable'; end if;
  select * into a from public.exact_installment_agreements where id=q.agreement_id for update;
  if not found or a.terms->>'buyerId' is distinct from p_buyer_id::text then raise exception 'retry owner differs'; end if;
  -- A lost acknowledgement consumes the attempt. Replays return false even
  -- after expiry, a later stop or successful payment; they NEVER admit again.
  if exists(select 1 from public.exact_installment_retry_admissions where confirmation_id=q.id and
    agreement_id=a.id and stripe_invoice_id=q.stripe_invoice_id) then return false; end if;
  select * into q from public.exact_installment_payment_confirmations where id=q.id for update;
  if q.confirmed_at is null or q.confirmed_at<q.created_at or q.confirmed_at>now() or extract(epoch from q.confirmed_at)>=q.expires_at or
    extract(epoch from now())>=q.expires_at or q.consent_version<>'single-invoice-pay-now-v1' then
    raise exception 'fresh confirmed payment required'; end if;
  -- Locks the original claim and checks the exact recovery hold, observed
  -- decline, current period, active buyer access, no receipt and no other hold.
  -- It never removes that recovery hold, not even transiently.
  s:=public.read_current_exact_card_setup(q.setup_request_id,p_buyer_id);
  if s.agreement_id is distinct from a.id or s.stripe_invoice_id is distinct from q.stripe_invoice_id or
    s.original_payment_intent_id is distinct from q.original_payment_intent_id or s.verified_at is null or
    s.stripe_setup_intent_id is distinct from q.setup_intent_id or s.replacement_payment_method_id is distinct from q.replacement_payment_method_id or
    s.authorization_snapshot is distinct from q.authorization_snapshot then raise exception 'retry setup binding differs'; end if;
  number:=(q.authorization_snapshot->>'paymentNumber')::integer;
  select * into period from public.exact_installment_periods where agreement_id=a.id and payment_number=number;
  if not found or period.amount_cents is distinct from q.amount_cents or period.application_fee_cents is distinct from q.application_fee_cents or
    a.status<>'active' or a.purchase_id is null or
    not exists(select 1 from public.exact_installment_activations where agreement_id=a.id and status='complete') then
    raise exception 'retry agreement or amount not ready'; end if;

  -- Preserve ALL original 045 ledger/refund/purchase/booking checks. The only
  -- exception is the one unpaid invoice's own hold, checked strictly above.
  -- Normal renewal admission still rejects every hold via the unchanged 045 RPC.
  perform 1 from public.payment_fee_ledger l join public.exact_installment_receipts r on r.ledger_id=l.id
    where r.agreement_id=a.id order by r.payment_number for update of l;
  select * into p from public.purchases where id=a.purchase_id for update;
  n:=(a.terms->>'paymentCount')::integer;
  if not found or p.status<>'active' or p.access_granted is distinct from true or p.is_refund is distinct from false or
    p.is_suspect is distinct from false or p.paid_count is distinct from number-1 or p.target_months is distinct from n or
    p.subscription_id is distinct from a.stripe_subscription_id or p.session_id is distinct from a.stripe_checkout_session_id or
    p.buyer_id::text is distinct from a.terms->>'buyerId' or p.creator_id::text is distinct from a.terms->>'creatorId' or
    p.booking_id::text is distinct from a.terms->>'bookingId' or p.post_id::text is distinct from a.terms->>'postId' or
    p.product_id::text is distinct from a.terms->>'productId' or lower(p.currency) is distinct from 'usd' then
    raise exception 'retry purchase not ready'; end if;
  if (select count(*) from public.exact_installment_receipts where agreement_id=a.id and counted_at is not null)<>number-1 or
    (select count(*) from public.exact_installment_receipts r join public.payment_fee_ledger l on l.id=r.ledger_id
      where r.agreement_id=a.id and r.payment_number<number and r.counted_at is not null and
        l.earnings_credited_at is not null and l.purchase_id=a.purchase_id and l.creator_id::text=a.terms->>'creatorId' and
        l.booking_payment_id=a.booking_payment_id and l.stripe_payment_intent_id=r.stripe_payment_intent_id and l.status='paid' and
        l.refunded_amount_cents=0 and l.earnings_reversed_cents=0 and (l.dispute_status is null or l.dispute_status='won'))<>number-1 then
    raise exception 'retry prior receipts require review'; end if;
  if exists(select 1 from public.exact_installment_receipts r where r.agreement_id=a.id and (
    exists(select 1 from public.payment_refund_state f where f.stripe_payment_intent_id=r.stripe_payment_intent_id and f.refunded_amount_cents>0) or
    exists(select 1 from public.payment_dispute_state d where d.stripe_payment_intent_id=r.stripe_payment_intent_id and d.status<>'won') or
    exists(select 1 from public.refund_operations o where o.stripe_payment_intent_id=r.stripe_payment_intent_id and
      (o.status<>'failed' or o.stripe_refund_id is not null)))) or
    not exists(select 1 from public.bookings where id=(a.terms->>'bookingId')::uuid and buyer_id=p.buyer_id and
      creator_id=p.creator_id and post_id=p.post_id and status::text in ('booked','completed')) or
    not exists(select 1 from public.booking_payments where id=a.booking_payment_id and booking_id=p.booking_id and
      buyer_id=p.buyer_id and product_id=p.product_id and status::text in ('pending','link_sent','completed')) then
    raise exception 'retry reconciliation required'; end if;
  insert into public.exact_installment_retry_admissions(confirmation_id,agreement_id,stripe_invoice_id)
    values(q.id,a.id,q.stripe_invoice_id);
  return true;
end;
$$;

-- A pre-admission recovery reader may not overwrite an outcome after a new
-- attempt was admitted. Existing optimistic revision checks include this basis.
create or replace function public.exact_installment_recovery_basis(p_agreement_id uuid,p_invoice_id text)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('agreementStatus',a.status,'claimStatus',c.status,'paymentIntentId',c.stripe_payment_intent_id,
    'dispatchStartedAt',c.dispatch_started_at,'receiptCountedAt',r.counted_at,'ledgerId',r.ledger_id,
    'retryConfirmationId',retry.confirmation_id,'retryAdmittedAt',retry.admitted_at)
  from public.exact_installment_agreements a join public.exact_installment_invoice_claims c on c.agreement_id=a.id
    left join public.exact_installment_receipts r on r.agreement_id=c.agreement_id and r.payment_number=c.payment_number
    left join public.exact_installment_retry_admissions retry on retry.agreement_id=c.agreement_id and retry.stripe_invoice_id=c.stripe_invoice_id
  where a.id=p_agreement_id and c.stripe_invoice_id=p_invoice_id;
$$;

-- Independent admission evidence is required before accounting for the new
-- card. Original claim/card snapshots stay immutable. Reconciliation remains
-- possible after expiry or a later hold, because money already captured must
-- still be accounted for. Existing once-only receipt/ledger rules are retained.
create function public.record_exact_installment_retry_receipt(p_confirmation_id uuid,p_invoice_id text,p_payment_intent_id text,
  p_amount_cents bigint,p_application_fee_cents bigint,p_paid_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.exact_installment_payment_confirmations%rowtype; retry public.exact_installment_retry_admissions%rowtype;
begin
  select * into q from public.exact_installment_payment_confirmations where id=p_confirmation_id;
  if not found then raise exception 'retry receipt confirmation missing'; end if;
  perform 1 from public.exact_installment_agreements where id=q.agreement_id for update;
  select * into retry from public.exact_installment_retry_admissions where confirmation_id=q.id;
  if not found or retry.agreement_id is distinct from q.agreement_id or retry.stripe_invoice_id is distinct from q.stripe_invoice_id or
    q.confirmed_at is null or q.consent_version<>'single-invoice-pay-now-v1' or retry.admitted_at<q.confirmed_at or extract(epoch from retry.admitted_at)>=q.expires_at or
    q.stripe_invoice_id is distinct from p_invoice_id or q.original_payment_intent_id is distinct from p_payment_intent_id or
    q.amount_cents is distinct from p_amount_cents or q.application_fee_cents is distinct from p_application_fee_cents or
    p_paid_at is null or p_paid_at<date_trunc('second',retry.admitted_at) or p_paid_at>now() then
    raise exception 'retry captured payment differs'; end if;
  return public.record_exact_installment_renewal_receipt(q.agreement_id,p_invoice_id,p_payment_intent_id,
    p_amount_cents,p_application_fee_cents,p_paid_at);
end;
$$;

revoke all on function public.admit_exact_installment_retry(uuid,uuid),
  public.record_exact_installment_retry_receipt(uuid,text,text,bigint,bigint,timestamptz),
  public.exact_installment_recovery_basis(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.admit_exact_installment_retry(uuid,uuid),
  public.record_exact_installment_retry_receipt(uuid,text,text,bigint,bigint,timestamptz) to service_role;
commit;
