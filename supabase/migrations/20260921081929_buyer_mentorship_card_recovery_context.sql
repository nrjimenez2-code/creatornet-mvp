begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create or replace function public.read_buyer_mentorship_recovery_action_context_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_invoice_id text,p_outcome text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; a public.buyer_mentorship_payment_admissions_v1%rowtype;
  b public.buyer_mentorship_billing_state_v1%rowtype; p public.buyer_mentorship_collection_periods_v1%rowtype;
  recovery public.buyer_mentorship_payment_recoveries_v1%rowtype; first public.buyer_mentorship_first_receipts_v1%rowtype;
  card public.buyer_mentorship_invoice_cards_v1%rowtype;
  boot public.buyer_mentorship_bootstraps_v1%rowtype; product text; prior jsonb:='[]'::jsonb; receipt jsonb; pi text; n integer;
begin
  if p_outcome is null or p_outcome not in ('action_required','payment_method_required') then
    raise exception 'Unsupported buyer recovery action'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer bank context unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into a from public.buyer_mentorship_payment_admissions_v1 where reservation_id=r.id and invoice_id=p_invoice_id;
  if not found then raise exception 'Buyer bank context requires original admission'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.payment_intent_id,73591));
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=a.payment_number;
  select * into recovery from public.buyer_mentorship_payment_recoveries_v1 where reservation_id=r.id and payment_number=a.payment_number;
  select * into first from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  select * into card from public.buyer_mentorship_invoice_cards_v1 where reservation_id=r.id and payment_number=a.payment_number;
  select * into boot from public.buyer_mentorship_bootstraps_v1 where reservation_id=r.id;
  select result_id into product from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='product.create' and bound_at is not null;
  if b.reservation_id is null or b.debit_revoked_at is not null or b.financial_hold_at is not null or b.collection_hold_at is null or
    b.paid_count<>a.payment_number-1 or p.reservation_id is null or p.counted_at is not null or p.invoice_id is distinct from a.invoice_id or
    p.admitted_at is distinct from a.admitted_at or recovery.invoice_id is distinct from a.invoice_id or
    recovery.payment_intent_id is distinct from a.payment_intent_id or recovery.outcome is distinct from p_outcome or
    first.reservation_id is null or card.invoice_id is distinct from a.invoice_id or a.payment_method_id is distinct from card.payment_method_id or
    card.original_default_payment_method_id is distinct from first.proof->>'paymentMethodId' or
    boot.customer_id is distinct from first.proof->>'customerId' or product is null or
    exists(select 1 from public.buyer_mentorship_later_receipts_v1 where reservation_id=r.id and payment_number=a.payment_number) then
    raise exception 'Buyer bank action not authorized'; end if;
  for n in 1..a.payment_number-1 loop
    if n=1 then pi:=first.payment_intent_id;
    else select payment_intent_id into pi from public.buyer_mentorship_later_receipts_v1 where reservation_id=r.id and payment_number=n;
    end if;
    receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,pi);
    if receipt is null or receipt#>'{proof,paymentNumber}' is distinct from to_jsonb(n) or
      not exists(select 1 from public.payment_fee_ledger where id=(receipt->>'ledgerId')::uuid and status='paid') or
      exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=pi and refunded_amount_cents>0) or
      exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=pi) or
      exists(select 1 from public.refund_operations where stripe_payment_intent_id=pi and status not in ('failed','completed')) then
      raise exception 'Buyer bank prior payment requires review'; end if;
    prior:=prior||jsonb_build_array(jsonb_build_object('paymentNumber',n,'paymentIntentId',pi));
  end loop;
  if exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=a.payment_intent_id) or
    exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=a.payment_intent_id) or
    exists(select 1 from public.refund_operations where stripe_payment_intent_id=a.payment_intent_id and status not in ('failed','completed')) then
    raise exception 'Buyer bank current payment requires review'; end if;
  return jsonb_build_object('reservationId',r.id,'paymentIntentId',a.payment_intent_id,'paymentMethodId',a.payment_method_id,
    'defaultPaymentMethodId',card.original_default_payment_method_id,'cardAuthorizationId',card.authorization_quote_id,
    'billing',to_jsonb(b),'recovery',to_jsonb(recovery),'prior',prior,'firstProof',first.proof,
    'dependencies',jsonb_build_object('customerId',boot.customer_id,'subscriptionId',first.proof->>'subscriptionId','productId',product,'anchorSeconds',boot.anchor_seconds));
end $$;
revoke all on function public.read_buyer_mentorship_recovery_action_context_v1(uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_recovery_action_context_v1(uuid,uuid,jsonb,text,text) to service_role;
commit;
