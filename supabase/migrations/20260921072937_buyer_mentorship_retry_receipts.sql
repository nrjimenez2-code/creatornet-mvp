begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Extend the existing atomic recorder; accounting and counting are unchanged.
create or replace function public.record_buyer_mentorship_later_receipt_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  p public.buyer_mentorship_collection_periods_v1%rowtype; a public.buyer_mentorship_payment_admissions_v1%rowtype;
  b public.buyer_mentorship_billing_state_v1%rowtype; receipt public.buyer_mentorship_later_receipts_v1%rowtype;
  l public.payment_fee_ledger%rowtype; n integer; paid bigint; platform bigint; processing bigint; net bigint;
  ledger uuid:=gen_random_uuid(); next_due bigint; retry public.buyer_mentorship_retry_admissions_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer receipt reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  if p_proof is null or jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>100000 or
    p_proof->>'version' is distinct from 'buyer-mentorship-later-capture-v1' or
    p_proof->>'reservationId' is distinct from r.id::text or p_proof->>'requestId' is distinct from r.request_id::text or
    p_proof->>'buyerId' is distinct from r.buyer_id::text or p_proof->>'creatorId' is distinct from r.creator_id::text or
    p_proof->>'termsFingerprint' is distinct from r.fingerprint or p_proof->'context' is distinct from r.context or
    p_proof->>'destinationId' is distinct from r.destination_id or p_proof->>'buyerCountry' is distinct from 'US' or
    coalesce(p_proof->>'paymentNumber','') !~ '^[0-9]{1,2}$' or
    coalesce(p_proof->>'chargeId','') !~ '^ch_[A-Za-z0-9]+$' or coalesce(p_proof->>'transferId','') !~ '^tr_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'balanceTransactionId','') !~ '^txn_[A-Za-z0-9]+$' or
    coalesce(p_proof->>'actualStripeFeeCents','') !~ '^[0-9]{1,8}$' or coalesce(p_proof->>'paidAt','') !~ '^[0-9]{1,12}$' then
    raise exception 'Buyer later captured-payment proof differs'; end if;
  n:=(p_proof->>'paymentNumber')::integer; paid:=(p_proof->>'paidAt')::bigint;
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=n;
  select * into a from public.buyer_mentorship_payment_admissions_v1 where reservation_id=r.id and payment_number=n;
  select * into retry from public.buyer_mentorship_retry_admissions_v1 where reservation_id=r.id and payment_number=n;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id for update;
  if f.reservation_id is null or p.reservation_id is null or a.reservation_id is null or b.reservation_id is null or
    n<2 or n>(r.terms->>'paymentCount')::integer or
    p.invoice_id is distinct from a.invoice_id or p.admitted_at is distinct from a.admitted_at or
    p_proof->>'invoiceId' is distinct from a.invoice_id or p_proof->>'paymentIntentId' is distinct from a.payment_intent_id or
    (p_proof->>'paymentMethodId' is distinct from a.payment_method_id and
      (retry.quote_id is null or retry.invoice_id is distinct from a.invoice_id or retry.payment_intent_id is distinct from a.payment_intent_id or
       p_proof->>'paymentMethodId' is distinct from retry.payment_method_id or
       paid<floor(extract(epoch from retry.admitted_at)))) or
    p_proof->>'customerId' is distinct from f.proof->>'customerId' or p_proof->>'subscriptionId' is distinct from f.proof->>'subscriptionId' or
    paid<p.due_at or paid<floor(extract(epoch from a.admitted_at)) or paid>floor(extract(epoch from clock_timestamp())) then
    raise exception 'Buyer receipt requires original admitted payment'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.payment_intent_id,73591));
  platform:=round(p.amount_cents::numeric*1200/10000)::bigint;
  processing:=case when (p.fee_schedule->>'enabled')::boolean then
    round(p.amount_cents::numeric*(p.fee_schedule->>'basisPoints')::integer/10000)::bigint+(p.fee_schedule->>'fixedCents')::bigint else 0 end;
  net:=p.amount_cents-platform-processing;
  if p_proof->'amountCents' is distinct from to_jsonb(p.amount_cents) or net<0 or
    not public.valid_monthly_fee_snapshot_v1(p_proof->'fees',p.amount_cents::integer) or
    p_proof#>'{fees,processingFeeEnabled}' is distinct from p.fee_schedule->'enabled' or
    p_proof#>'{fees,processingFeeBasisPoints}' is distinct from p.fee_schedule->'basisPoints' or
    p_proof#>'{fees,processingFeeFixedCents}' is distinct from p.fee_schedule->'fixedCents' or
    p_proof#>>'{fees,feeScheduleVersion}' is distinct from p.fee_schedule->>'version' then
    raise exception 'Buyer later receipt economics differ'; end if;
  select * into receipt from public.buyer_mentorship_later_receipts_v1 where reservation_id=r.id and payment_number=n;
  if found then
    if receipt.proof is distinct from p_proof or p.counted_at is distinct from receipt.recorded_at or b.paid_count<n then
      raise exception 'Original buyer later receipt is immutable'; end if;
    select * into l from public.payment_fee_ledger where id=receipt.ledger_id;
    if l.id is null or l.purchase_id is distinct from f.purchase_id or l.creator_id is distinct from r.creator_id or
      l.stripe_invoice_id is distinct from a.invoice_id or l.stripe_payment_intent_id is distinct from a.payment_intent_id or
      l.stripe_charge_id is distinct from receipt.charge_id or l.gross_amount_cents is distinct from p.amount_cents or
      l.platform_fee_cents is distinct from platform or l.processing_fee_cents is distinct from processing or
      l.creator_net_cents is distinct from net or l.earnings_credited_at is null then raise exception 'Existing buyer later accounting differs'; end if;
    return jsonb_build_object('recorded',false,'reservationId',r.id,'purchaseId',f.purchase_id,'ledgerId',receipt.ledger_id,'paymentNumber',n);
  end if;
  -- New debit holds cannot prevent accounting for a capture already admitted.
  -- Financial observations are deliberately left to lifecycle reconciliation.
  if b.paid_count<>n-1 or p.counted_at is not null or
    exists(select 1 from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number<n and counted_at is null) or
    exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=a.payment_intent_id or stripe_invoice_id=a.invoice_id or stripe_charge_id=p_proof->>'chargeId') or
    exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=a.payment_intent_id and
      (refunded_amount_cents>0 or stripe_charge_id is distinct from p_proof->>'chargeId' or charge_amount_cents<>p.amount_cents)) or
    exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=a.payment_intent_id) or
    exists(select 1 from public.refund_operations where stripe_payment_intent_id=a.payment_intent_id and status not in ('failed','completed')) then
    raise exception 'Buyer later receipt requires financial reconciliation'; end if;
  insert into public.buyer_mentorship_later_receipts_v1(reservation_id,payment_number,invoice_id,payment_intent_id,charge_id,ledger_id,proof)
    values(r.id,n,a.invoice_id,a.payment_intent_id,p_proof->>'chargeId',ledger,p_proof) returning * into receipt;
  insert into public.payment_fee_ledger(id,creator_id,purchase_id,stripe_invoice_id,stripe_payment_intent_id,stripe_charge_id,
    stripe_balance_transaction_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,
    creator_net_cents,actual_stripe_fee_cents,processing_fee_variance_cents,currency,fee_schedule_version,status,earnings_credited_at)
    values(ledger,r.creator_id,f.purchase_id,a.invoice_id,a.payment_intent_id,p_proof->>'chargeId',p_proof->>'balanceTransactionId',
      p.amount_cents,platform,processing,platform+processing,net,(p_proof->>'actualStripeFeeCents')::bigint,
      processing-(p_proof->>'actualStripeFeeCents')::bigint,'usd',p.fee_schedule->>'version','paid',clock_timestamp());
  update public.profiles set total_earnings_cents=coalesce(total_earnings_cents,0)+net where id=r.creator_id;
  if not found then raise exception 'Buyer receipt creator profile missing'; end if;
  update public.buyer_mentorship_collection_periods_v1 set counted_at=receipt.recorded_at where reservation_id=r.id and payment_number=n;
  select due_at into next_due from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=n+1;
  if n<(r.terms->>'paymentCount')::integer and next_due is null then raise exception 'Buyer next period missing'; end if;
  update public.buyer_mentorship_billing_state_v1 set paid_count=n,next_payment_at=next_due,revision=revision+1 where reservation_id=r.id;
  return jsonb_build_object('recorded',true,'reservationId',r.id,'purchaseId',f.purchase_id,'ledgerId',ledger,'paymentNumber',n);
end $$;
commit;
