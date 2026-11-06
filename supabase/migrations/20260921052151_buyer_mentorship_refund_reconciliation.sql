begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.buyer_mentorship_refund_events_v1 (
  event_id text primary key check(event_id ~ '^evt_[A-Za-z0-9]+$'),
  reservation_id uuid not null references public.buyer_mentorship_first_receipts_v1(reservation_id),
  payment_intent_id text not null check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  charge_id text not null check(charge_id ~ '^ch_[A-Za-z0-9]+$'),
  gross_cents bigint not null check(gross_cents between 50 and 99999999),
  observed_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz,
  cumulative_refunded_cents bigint check(cumulative_refunded_cents between 1 and gross_cents)
);
alter table public.buyer_mentorship_refund_events_v1 enable row level security;
revoke all on public.buyer_mentorship_refund_events_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_refund_events_v1 to service_role;
grant update(applied_at,cumulative_refunded_cents) on public.buyer_mentorship_refund_events_v1 to service_role;
grant update(financial_hold_at) on public.buyer_mentorship_billing_state_v1 to service_role;

-- Shared owned receipt projection for financial lifecycle inspection. Existing
-- capture proof and fee-ledger identities remain immutable after reversals.
create function public.read_buyer_mentorship_credited_payment_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_payment_intent_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  later public.buyer_mentorship_later_receipts_v1%rowtype; l public.payment_fee_ledger%rowtype;
  proof jsonb; ledger uuid; invoice text;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer financial receipt unavailable'; end if;
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  if not found then return null; end if;
  if f.payment_intent_id=p_payment_intent_id then proof:=f.proof;ledger:=f.ledger_id;
  else
    select * into later from public.buyer_mentorship_later_receipts_v1 where reservation_id=r.id and payment_intent_id=p_payment_intent_id;
    if not found then return null; end if;
    proof:=later.proof;ledger:=later.ledger_id;invoice:=later.invoice_id;
    if not exists(select 1 from public.buyer_mentorship_collection_periods_v1 p join public.buyer_mentorship_payment_admissions_v1 a using(reservation_id,payment_number)
      where p.reservation_id=r.id and p.payment_number=later.payment_number and p.counted_at=later.recorded_at and
      a.payment_intent_id=p_payment_intent_id and p.invoice_id=later.invoice_id and a.invoice_id=later.invoice_id) then
      raise exception 'Buyer later financial receipt binding differs'; end if;
  end if;
  select * into l from public.payment_fee_ledger where id=ledger;
  if l.id is null or l.purchase_id is distinct from f.purchase_id or l.creator_id is distinct from r.creator_id or
    l.earnings_credited_at is null or l.booking_payment_id is not null or l.currency is distinct from 'usd' or
    l.stripe_payment_intent_id is distinct from p_payment_intent_id or l.stripe_invoice_id is distinct from invoice or
    l.stripe_charge_id is distinct from proof->>'chargeId' or l.stripe_balance_transaction_id is distinct from proof->>'balanceTransactionId' or
    l.gross_amount_cents is distinct from (proof->>'amountCents')::bigint or
    l.total_creator_deduction_cents is distinct from (proof#>>'{fees,totalCreatorDeductionCents}')::bigint or
    l.creator_net_cents is distinct from (proof#>>'{fees,creatorNetCents}')::bigint or
    l.actual_stripe_fee_cents is distinct from (proof->>'actualStripeFeeCents')::bigint or
    proof->>'reservationId' is distinct from r.id::text or proof->>'buyerId' is distinct from p_buyer_id::text or
    proof->>'termsFingerprint' is distinct from r.fingerprint or proof->'context' is distinct from p_context then
    raise exception 'Buyer credited financial evidence differs'; end if;
  return jsonb_build_object('reservationId',r.id,'purchaseId',f.purchase_id,'ledgerId',ledger,'invoiceId',invoice,'proof',proof);
end $$;
revoke all on function public.read_buyer_mentorship_credited_payment_v1(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_credited_payment_v1(uuid,uuid,jsonb,text) to service_role;

create function public.hold_buyer_mentorship_refund_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_event_id text,
  p_payment_intent_id text,p_charge_id text,p_gross_cents bigint)
returns uuid language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  event public.buyer_mentorship_refund_events_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer refund unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  perform pg_advisory_xact_lock(hashtextextended(p_payment_intent_id,73591));
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  if f.reservation_id is null or not (
    (f.payment_intent_id=p_payment_intent_id and f.charge_id=p_charge_id and (f.proof->>'amountCents')::bigint=p_gross_cents) or
    exists(select 1 from public.buyer_mentorship_payment_admissions_v1 a join public.buyer_mentorship_collection_periods_v1 p using(reservation_id,payment_number)
      where a.reservation_id=r.id and a.payment_intent_id=p_payment_intent_id and p.amount_cents=p_gross_cents)) then
    raise exception 'Buyer refund requires original payment binding'; end if;
  insert into public.buyer_mentorship_refund_events_v1(event_id,reservation_id,payment_intent_id,charge_id,gross_cents)
    values(p_event_id,r.id,p_payment_intent_id,p_charge_id,p_gross_cents) on conflict(event_id) do nothing;
  select * into event from public.buyer_mentorship_refund_events_v1 where event_id=p_event_id;
  if event.reservation_id is distinct from r.id or event.payment_intent_id is distinct from p_payment_intent_id or
    event.charge_id is distinct from p_charge_id or event.gross_cents is distinct from p_gross_cents then raise exception 'Original buyer refund event differs'; end if;
  update public.buyer_mentorship_billing_state_v1 set financial_hold_at=clock_timestamp(),revision=revision+1
    where reservation_id=r.id and financial_hold_at is null;
  return r.id;
end $$;
revoke all on function public.hold_buyer_mentorship_refund_v1(uuid,uuid,jsonb,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.hold_buyer_mentorship_refund_v1(uuid,uuid,jsonb,text,text,text,bigint) to service_role;

-- Atomic ownership wrapper; reuse the established cumulative refund and
-- proportional creator/fee reversal functions instead of a parallel ledger.
create function public.apply_buyer_mentorship_refund_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_event_id text,
  p_payment_intent_id text,p_charge_id text,p_gross_cents bigint,p_refunded_cents bigint)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare reservation uuid; receipt jsonb; cumulative bigint; reversed bigint;
begin
  if p_refunded_cents is null or p_refunded_cents<1 or p_refunded_cents>p_gross_cents then raise exception 'Invalid buyer refund total'; end if;
  reservation:=public.hold_buyer_mentorship_refund_v1(p_request_id,p_buyer_id,p_context,p_event_id,p_payment_intent_id,p_charge_id,p_gross_cents);
  receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,p_payment_intent_id);
  if receipt is null or receipt#>>'{proof,chargeId}' is distinct from p_charge_id or
    receipt#>'{proof,amountCents}' is distinct from to_jsonb(p_gross_cents) then raise exception 'Buyer refund credited receipt unavailable'; end if;
  if exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=p_payment_intent_id and
    (stripe_charge_id<>p_charge_id or charge_amount_cents<>p_gross_cents)) then raise exception 'Prior buyer refund identity differs'; end if;
  cumulative:=public.record_payment_refund_state(p_payment_intent_id,p_charge_id,p_gross_cents,p_refunded_cents);
  reversed:=public.apply_payment_fee_ledger_refund((receipt->>'ledgerId')::uuid,cumulative);
  update public.buyer_mentorship_refund_events_v1 set applied_at=coalesce(applied_at,clock_timestamp()),
    cumulative_refunded_cents=greatest(coalesce(cumulative_refunded_cents,0),cumulative) where event_id=p_event_id;
  return jsonb_build_object('reservationId',reservation,'cumulativeRefundedCents',cumulative,'reversedCents',reversed);
end $$;
revoke all on function public.apply_buyer_mentorship_refund_v1(uuid,uuid,jsonb,text,text,text,bigint,bigint) from public,anon,authenticated;
grant execute on function public.apply_buyer_mentorship_refund_v1(uuid,uuid,jsonb,text,text,text,bigint,bigint) to service_role;
commit;
