begin;

-- Prospective Sandbox only. This reader NEVER admits a debit, changes a card,
-- releases a hold, or rewrites a receipt. The action form checks current safety
-- before releasing the existing PI's bank challenge to its authenticated buyer.
-- The non-action form permits accounting for money already captured after a stop.
create function public.read_exact_installment_bank_context(p_agreement_id uuid,p_invoice_id text,p_buyer_id uuid,p_for_action boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; c public.exact_installment_invoice_claims%rowtype;
  period public.exact_installment_periods%rowtype; p public.purchases%rowtype;
  q public.exact_installment_payment_confirmations%rowtype; s public.exact_installment_card_setups%rowtype;
  retry public.exact_installment_retry_admissions%rowtype; snapshot jsonb;
  payment_method text; admitted timestamptz; number integer; n integer;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or p_buyer_id is null or p_for_action is null or a.terms->>'buyerId' is distinct from p_buyer_id::text then
    raise exception 'bank review unavailable'; end if;
  select * into c from public.exact_installment_invoice_claims where agreement_id=a.id and stripe_invoice_id=p_invoice_id for update;
  if not found or c.status not in ('dispatching','paid','review_required') or c.dispatch_started_at is null or
    c.stripe_payment_intent_id is null or c.dispatch_started_at>now() then raise exception 'original admission required'; end if;
  select * into period from public.exact_installment_periods where agreement_id=a.id and payment_number=c.payment_number;
  if not found then raise exception 'scheduled period missing'; end if;
  snapshot:=public.claim_exact_installment_invoice(a.id,c.stripe_invoice_id,a.stripe_subscription_id,period.due_at,period.period_end,gen_random_uuid());
  if snapshot->>'status' is distinct from 'reconcile' or snapshot->>'paymentIntentId' is distinct from c.stripe_payment_intent_id then
    raise exception 'original admission changed'; end if;
  payment_method:=snapshot->'authorization'->>'paymentMethodId'; admitted:=c.dispatch_started_at;
  select * into retry from public.exact_installment_retry_admissions where agreement_id=a.id and stripe_invoice_id=c.stripe_invoice_id;
  if found then
    select * into q from public.exact_installment_payment_confirmations where id=retry.confirmation_id;
    if not found or q.agreement_id is distinct from a.id or q.buyer_id is distinct from p_buyer_id or
      q.stripe_invoice_id is distinct from c.stripe_invoice_id or q.original_payment_intent_id is distinct from c.stripe_payment_intent_id or
      q.consent_version is distinct from 'single-invoice-pay-now-v1' or q.confirmed_at is null or q.confirmed_at<q.created_at or
      retry.admitted_at<q.confirmed_at or retry.admitted_at>now() or extract(epoch from retry.admitted_at)>=q.expires_at or
      q.authorization_snapshot is distinct from snapshot->'authorization' or q.amount_cents is distinct from period.amount_cents or
      q.application_fee_cents is distinct from period.application_fee_cents then raise exception 'retry admission differs'; end if;
    select * into s from public.exact_installment_card_setups where id=q.setup_request_id;
    if not found or s.buyer_id is distinct from p_buyer_id or s.agreement_id is distinct from a.id or
      s.stripe_invoice_id is distinct from c.stripe_invoice_id or s.original_payment_intent_id is distinct from c.stripe_payment_intent_id or
      s.authorization_snapshot is distinct from q.authorization_snapshot or s.verified_at is null or
      s.stripe_setup_intent_id is distinct from q.setup_intent_id or s.replacement_payment_method_id is distinct from q.replacement_payment_method_id then
      raise exception 'verified card binding differs'; end if;
    payment_method:=q.replacement_payment_method_id; admitted:=retry.admitted_at;
  end if;
  if p_for_action then
    if a.status<>'active' or a.purchase_id is null or c.status<>'dispatching' or
      extract(epoch from now())<period.due_at or extract(epoch from now())>=period.period_end or
      not exists(select 1 from public.exact_installment_payment_recoveries where agreement_id=a.id and stripe_invoice_id=c.stripe_invoice_id and
        stripe_payment_intent_id=c.stripe_payment_intent_id and outcome='action_required') or
      not exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id and reason='invoice_recovery' and
        stripe_object_id=c.stripe_invoice_id and stripe_payment_intent_id=c.stripe_payment_intent_id) or
      exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id and
        (reason<>'invoice_recovery' or stripe_object_id is distinct from c.stripe_invoice_id or stripe_payment_intent_id is distinct from c.stripe_payment_intent_id)) or
      exists(select 1 from public.exact_installment_billing_stops where agreement_id=a.id) or
      exists(select 1 from public.exact_installment_receipts where agreement_id=a.id and payment_number>=c.payment_number) then
      raise exception 'bank verification requires review'; end if;
    number:=c.payment_number; n:=(a.terms->>'paymentCount')::integer;
    -- Keep all 045/053 purchase, ledger, refund, dispute and booking checks.
    -- The only permitted hold is this already-admitted invoice's recovery hold.
    perform 1 from public.payment_fee_ledger l join public.exact_installment_receipts r on r.ledger_id=l.id
      where r.agreement_id=a.id order by r.payment_number for update of l;
    select * into p from public.purchases where id=a.purchase_id for update;
    if not found or p.status<>'active' or p.access_granted is distinct from true or p.is_refund is distinct from false or
      p.is_suspect is distinct from false or p.paid_count is distinct from number-1 or p.target_months is distinct from n or
      p.subscription_id is distinct from a.stripe_subscription_id or p.session_id is distinct from a.stripe_checkout_session_id or
      p.buyer_id::text is distinct from a.terms->>'buyerId' or p.creator_id::text is distinct from a.terms->>'creatorId' or
      p.booking_id::text is distinct from a.terms->>'bookingId' or p.post_id::text is distinct from a.terms->>'postId' or
      p.product_id::text is distinct from a.terms->>'productId' or lower(p.currency) is distinct from 'usd' then
      raise exception 'bank review purchase not ready'; end if;
    if (select count(*) from public.exact_installment_receipts where agreement_id=a.id and counted_at is not null)<>number-1 or
      (select count(*) from public.exact_installment_receipts r join public.payment_fee_ledger l on l.id=r.ledger_id
        where r.agreement_id=a.id and r.payment_number<number and r.counted_at is not null and
          l.earnings_credited_at is not null and l.purchase_id=a.purchase_id and l.creator_id::text=a.terms->>'creatorId' and
          l.booking_payment_id=a.booking_payment_id and l.stripe_payment_intent_id=r.stripe_payment_intent_id and l.status='paid' and
          l.refunded_amount_cents=0 and l.earnings_reversed_cents=0 and (l.dispute_status is null or l.dispute_status='won'))<>number-1 then
      raise exception 'bank review prior receipts require review'; end if;
    if exists(select 1 from public.exact_installment_receipts r where r.agreement_id=a.id and (
      exists(select 1 from public.payment_refund_state f where f.stripe_payment_intent_id=r.stripe_payment_intent_id and f.refunded_amount_cents>0) or
      exists(select 1 from public.payment_dispute_state d where d.stripe_payment_intent_id=r.stripe_payment_intent_id and d.status<>'won') or
      exists(select 1 from public.refund_operations o where o.stripe_payment_intent_id=r.stripe_payment_intent_id and
        (o.status<>'failed' or o.stripe_refund_id is not null)))) or
      not exists(select 1 from public.bookings where id=(a.terms->>'bookingId')::uuid and buyer_id=p.buyer_id and
        creator_id=p.creator_id and post_id=p.post_id and status::text in ('booked','completed')) or
      not exists(select 1 from public.booking_payments where id=a.booking_payment_id and booking_id=p.booking_id and
        buyer_id=p.buyer_id and product_id=p.product_id and status::text in ('pending','link_sent','completed')) then
      raise exception 'bank review reconciliation required'; end if;
  end if;
  return snapshot || jsonb_build_object('buyerId',p_buyer_id,'paymentMethodId',payment_method,
    'admittedAt',floor(extract(epoch from admitted))::bigint,'retryId',retry.confirmation_id);
end;
$$;
revoke all on function public.read_exact_installment_bank_context(uuid,text,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.read_exact_installment_bank_context(uuid,text,uuid,boolean) to service_role;
commit;
