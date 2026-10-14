begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- An observation can precede accounting. Keep its original capture receipt
-- and cumulative refund even then; never manufacture a clean sale to reverse.
create table public.full_server_payment_refund_events_v1 (
  event_id text primary key check(event_id ~ '^evt_[A-Za-z0-9]+$'),
  attempt_id uuid not null references public.full_server_payment_receipts_v1(attempt_id),
  payment_intent_id text not null,
  charge_id text not null,
  observed_refunded_cents bigint not null check(observed_refunded_cents>0),
  recorded_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz
);
alter table public.full_server_payment_refund_events_v1 enable row level security;
revoke all on public.full_server_payment_refund_events_v1 from public,anon,authenticated,service_role;
grant select on public.full_server_payment_refund_events_v1 to service_role;

create function public.apply_full_server_payment_refund_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_proof jsonb,p_refunded_cents bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; r public.full_server_payment_receipts_v1%rowtype;
  prior public.payment_refund_state%rowtype; e public.full_server_payment_refund_events_v1%rowtype; o public.orders%rowtype;
  cumulative bigint; original jsonb;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if s.kind<>'full' or p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$' or
    p_refunded_cents is null or p_refunded_cents not between 1 and 99999999 then
    raise exception 'Original full refund evidence required'; end if;
  -- Source read holds the same buyer/product lock as full accounting. The
  -- receipt writer validates immutable source, consent and captured phase and
  -- takes the shared PI observation lock before any financial writes.
  perform public.record_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context,p_proof);
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id for update;
  if p_refunded_cents>(r.proof->>'amountCents')::bigint then raise exception 'Full refund exceeds original capture'; end if;
  select * into prior from public.payment_refund_state where stripe_payment_intent_id=r.payment_intent_id;
  if found and (prior.stripe_charge_id is distinct from r.charge_id or
      prior.charge_amount_cents is distinct from (r.proof->>'amountCents')::bigint) then
    raise exception 'Prior full refund identity differs'; end if;
  insert into public.full_server_payment_refund_events_v1(event_id,attempt_id,payment_intent_id,charge_id,observed_refunded_cents)
    values(p_event_id,s.attempt_id,r.payment_intent_id,r.charge_id,p_refunded_cents) on conflict(event_id) do nothing;
  select * into e from public.full_server_payment_refund_events_v1 where event_id=p_event_id;
  if e.attempt_id is distinct from s.attempt_id or e.payment_intent_id is distinct from r.payment_intent_id or
    e.charge_id is distinct from r.charge_id then raise exception 'Original full refund event differs'; end if;
  cumulative:=public.record_payment_refund_state(r.payment_intent_id,r.charge_id,(r.proof->>'amountCents')::bigint,p_refunded_cents);
  update public.full_server_payment_refund_events_v1 set observed_refunded_cents=greatest(observed_refunded_cents,p_refunded_cents)
    where event_id=p_event_id;
  if r.accounted_at is null then
    return jsonb_build_object('status','refund_recorded_accounting_review','attemptId',s.attempt_id,
      'paymentIntentId',r.payment_intent_id,'refundedCents',cumulative);
  end if;
  -- The accounted branch only verifies and returns original links. It never
  -- credits again, even after a reversal has cleared an earnings claim.
  original:=public.account_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context);
  if original->>'accounted' is distinct from 'false' or original->>'purchaseId' is distinct from r.purchase_id::text or
    original->>'ledgerId' is distinct from r.ledger_id::text then raise exception 'Original full refund accounting differs'; end if;
  if exists(select 1 from public.payment_fee_ledger where id=r.ledger_id and earnings_credited_at is not null) then
    raise exception 'Full receipt cannot reverse a second earnings credit'; end if;
  select * into o from public.orders where id=(r.proof->>'orderId')::uuid for update;
  if o.id is null or o.stripe_payment_intent_id is distinct from r.payment_intent_id or
    o.buyer_id is distinct from s.buyer_id or o.creator_id::text is distinct from r.proof->>'creatorId' or
    o.post_id::text is distinct from r.proof->>'postId' or o.amount_cents::text is distinct from r.proof->>'amountCents' or
    o.currency is distinct from 'usd' or o.status is null or o.status not in ('paid','refunded') or
    o.platform_fee::text is distinct from r.proof#>>'{fees,platformFeeCents}' or
    o.processing_fee::text is distinct from r.proof#>>'{fees,processingFeeCents}' or
    o.creator_amount::text is distinct from r.proof#>>'{fees,creatorNetCents}' then
    raise exception 'Original full refund order differs'; end if;
  -- Fee attribution uses the original frozen receipt, including for captures
  -- accounted before this migration. Never reconstruct fees from today's offer.
  if exists(select 1 from public.purchases where id=r.purchase_id and
    ((platform_fee_cents is not null and platform_fee_cents::text is distinct from r.proof#>>'{fees,platformFeeCents}') or
     (processing_fee_cents is not null and processing_fee_cents::text is distinct from r.proof#>>'{fees,processingFeeCents}'))) then
    raise exception 'Original full refund purchase fees differ'; end if;
  update public.purchases set platform_fee_cents=(r.proof#>>'{fees,platformFeeCents}')::bigint,
    processing_fee_cents=(r.proof#>>'{fees,processingFeeCents}')::bigint where id=r.purchase_id;
  perform public.apply_purchase_refund_earnings(r.purchase_id,cumulative);
  perform public.apply_payment_fee_ledger_refund(r.ledger_id,cumulative);
  update public.orders set refunded_amount=greatest(coalesce(refunded_amount,0),cumulative),
    status=case when cumulative=(r.proof->>'amountCents')::bigint then 'refunded' else status end,
    updated_at=clock_timestamp() where id=(r.proof->>'orderId')::uuid and stripe_payment_intent_id=r.payment_intent_id;
  if not found then raise exception 'Original full refund order missing'; end if;
  update public.full_server_payment_refund_events_v1 set applied_at=coalesce(applied_at,clock_timestamp()) where event_id=p_event_id;
  return jsonb_build_object('status','original_refund_applied','attemptId',s.attempt_id,'paymentIntentId',r.payment_intent_id,
    'purchaseId',r.purchase_id,'ledgerId',r.ledger_id,'refundedCents',cumulative);
end $$;
revoke all on function public.apply_full_server_payment_refund_v1(uuid,uuid,jsonb,text,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.apply_full_server_payment_refund_v1(uuid,uuid,jsonb,text,jsonb,bigint) to service_role;
commit;
