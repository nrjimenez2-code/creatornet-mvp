begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Fixed purchase service is independent of the payment count. This reader
-- authorizes only an owned, durably credited purchase, not provider metadata.
-- Collection holds and automatic-debit revocation do not erase that purchase.
-- Financial reconciliation holds, refunds/disputes and service expiry deny it.
create function public.read_buyer_mentorship_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare p public.purchases%rowtype; r public.buyer_mentorship_installment_reservations_v1%rowtype;
  f public.buyer_mentorship_first_receipts_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype;
  financial boolean:=false; seconds integer:=0; at_time numeric:=extract(epoch from clock_timestamp());
begin
  select * into p from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id;
  if not found then return jsonb_build_object('applicable',false,'allowed',false,'maxAgeSeconds',0); end if;
  if p.buyer_mentorship_installment_id is null then
    return jsonb_build_object('applicable',false,'allowed',coalesce(p.access_granted and p.status<>'refunded',false),
      'maxAgeSeconds',case when p.access_granted and p.status<>'refunded' then 3600 else 0 end);
  end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where id=p.buyer_mentorship_installment_id and buyer_id=p_buyer_id;
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id and purchase_id=p.id;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=f.reservation_id;
  financial:=coalesce(r.id is not null and f.reservation_id is not null and b.reservation_id is not null and
    p.kind='buyer_mentorship_installments_v1' and p.status in ('active','complete') and
    not p.is_refund and not p.is_suspect and p.creator_id=r.creator_id and p.product_id=r.product_id and p.post_id=r.post_id and
    p.payment_intent_id=f.payment_intent_id and p.session_id=f.proof->>'checkoutSessionId' and
    p.subscription_id=f.proof->>'subscriptionId' and r.fingerprint=f.proof->>'termsFingerprint' and
    r.context=f.proof->'context' and b.first_paid_at=(f.proof->>'paidAt')::bigint and
    b.service_end_at is not distinct from (f.proof->>'serviceEndsAt')::bigint and
    b.paid_count between 1 and (r.terms->>'paymentCount')::integer and b.financial_hold_at is null and
    exists(select 1 from public.payment_fee_ledger where id=f.ledger_id and purchase_id=p.id and
      creator_id=r.creator_id and stripe_payment_intent_id=f.payment_intent_id and stripe_charge_id=f.charge_id and
      gross_amount_cents=(f.proof->>'amountCents')::bigint and earnings_credited_at is not null and status='paid') and
    not exists(select 1 from public.payment_fee_ledger l where l.purchase_id=p.id and
      (l.status<>'paid' or l.refunded_amount_cents>0 or l.earnings_reversed_cents>0 or
        l.dispute_status is not null and l.dispute_status not in ('won','warning_closed'))) and
    not exists(select 1 from public.payment_fee_ledger l join public.payment_refund_state s
      on s.stripe_payment_intent_id=l.stripe_payment_intent_id where l.purchase_id=p.id and s.refunded_amount_cents>0) and
    not exists(select 1 from public.payment_fee_ledger l join public.payment_dispute_state s
      on s.stripe_payment_intent_id=l.stripe_payment_intent_id where l.purchase_id=p.id and s.status not in ('won','warning_closed')) and
    not exists(select 1 from public.payment_fee_ledger l join public.refund_operations o
      on o.stripe_payment_intent_id=l.stripe_payment_intent_id where l.purchase_id=p.id and o.status not in ('failed','completed')),false);
  if financial and at_time>=b.first_paid_at then
    seconds:=floor(least(3600,case when b.service_end_at is null then 3600 else greatest(0,b.service_end_at-at_time) end))::integer;
  end if;
  return jsonb_build_object('applicable',true,'reservationId',r.id,'serviceStartAt',b.first_paid_at,
    'serviceEndAt',b.service_end_at,'financialAccess',financial,'allowed',seconds>0,'maxAgeSeconds',seconds);
end $$;
revoke all on function public.read_buyer_mentorship_entitlement_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_entitlement_v1(uuid,uuid) to service_role;
commit;
