begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.full_server_payment_receipts_v1
  add column purchase_id uuid unique references public.purchases(id),
  add column ledger_id uuid unique references public.payment_fee_ledger(id),
  add column accounted_at timestamptz,
  add constraint full_server_receipt_accounting_v1 check(
    (purchase_id is null and ledger_id is null and accounted_at is null) or
    (purchase_id is not null and ledger_id is not null and accounted_at is not null));

create function public.account_full_server_payment_receipt_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; r public.full_server_payment_receipts_v1%rowtype;
  o public.orders%rowtype; p public.purchases%rowtype; l public.payment_fee_ledger%rowtype;
  consent public.product_purchase_consents_v1%rowtype; proof jsonb; fees jsonb;
  purchase uuid:=gen_random_uuid(); ledger uuid:=gen_random_uuid();
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id for update;
  if s.kind<>'full' or r.attempt_id is null then raise exception 'Original full receipt required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.payment_intent_id,73591));
  proof:=r.proof;fees:=proof->'fees';
  -- Revalidate the immutable original even on recovery; do not reauthorize a
  -- charge or require that new-sales gates or the dispatch window remain open.
  perform public.record_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context,proof);
  if r.accounted_at is not null then
    select * into p from public.purchases where id=r.purchase_id for update;
    select * into l from public.payment_fee_ledger where id=r.ledger_id for update;
    if p.id is null or l.id is null or p.buyer_id is distinct from s.buyer_id or p.product_id is distinct from s.product_id or
      p.payment_intent_id is distinct from r.payment_intent_id or p.session_id is not null or p.subscription_id is not null or
      p.buyer_user_id is distinct from s.buyer_id or p.creator_id::text is distinct from proof->>'creatorId' or
      p.post_id::text is distinct from proof->>'postId' or p.currency is distinct from 'usd' or
      p.paid_at is distinct from to_timestamp((proof->>'paidAt')::bigint) or
      p.order_id::text is distinct from proof->>'orderId' or p.amount_cents::text is distinct from proof->>'amountCents' or
      l.purchase_id is distinct from p.id or l.stripe_payment_intent_id is distinct from r.payment_intent_id or
      l.stripe_charge_id is distinct from r.charge_id or l.creator_id is distinct from p.creator_id or
      l.order_id is distinct from p.order_id or l.stripe_balance_transaction_id is distinct from proof->>'balanceTransactionId' or
      l.currency is distinct from 'usd' or l.fee_schedule_version is distinct from fees->>'feeScheduleVersion' or
      l.platform_fee_cents::text is distinct from fees->>'platformFeeCents' or l.processing_fee_cents::text is distinct from fees->>'processingFeeCents' or
      l.total_creator_deduction_cents::text is distinct from fees->>'totalCreatorDeductionCents' or
      l.actual_stripe_fee_cents::text is distinct from proof->>'actualStripeFeeCents' or
      l.gross_amount_cents::text is distinct from proof->>'amountCents' or l.creator_net_cents::text is distinct from fees->>'creatorNetCents' then
      raise exception 'Original full receipt accounting differs'; end if;
    if proof->>'serviceEndsAt' is not null and not exists(select 1 from public.fixed_purchase_service_contracts_v1 where
      purchase_id=p.id and consent_id::text=proof->>'purchaseConsentId' and payment_intent_id=r.payment_intent_id and charge_id=r.charge_id and
      service_start_at::text=proof->>'paidAt' and service_end_at::text=proof->>'serviceEndsAt') then
      raise exception 'Original full receipt service binding differs'; end if;
    -- A refund can clear the old earnings claim. Never use that as authority
    -- to credit again or restore access on a repeated succeeded event.
    return jsonb_build_object('accounted',false,'attemptId',s.attempt_id,'purchaseId',p.id,'ledgerId',l.id,'purchaseStatus',p.status);
  end if;
  if exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=r.payment_intent_id and
      (stripe_charge_id is distinct from r.charge_id or charge_amount_cents::text is distinct from proof->>'amountCents' or refunded_amount_cents>0)) or
    exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=r.payment_intent_id) or
    exists(select 1 from public.refund_operations where stripe_payment_intent_id=r.payment_intent_id and status<>'failed') then
    raise exception 'Full receipt requires financial reconciliation'; end if;
  select * into o from public.orders where id::text=proof->>'orderId' for update;
  select * into consent from public.product_purchase_consents_v1 where id::text=proof->>'purchaseConsentId';
  if o.id is null or consent.id is null or o.buyer_id is distinct from s.buyer_id or o.creator_id::text is distinct from proof->>'creatorId' or
    o.post_id::text is distinct from proof->>'postId' or o.status is distinct from 'created' or o.currency is distinct from 'usd' or
    o.amount_cents::text is distinct from proof->>'amountCents' or o.gross_amount::text is distinct from proof->>'amountCents' or
    o.platform_fee::text is distinct from fees->>'platformFeeCents' or o.processing_fee::text is distinct from fees->>'processingFeeCents' or
    o.total_creator_deduction::text is distinct from fees->>'totalCreatorDeductionCents' or o.creator_amount::text is distinct from fees->>'creatorNetCents' or
    o.fee_schedule_version is distinct from fees->>'feeScheduleVersion' or o.stripe_checkout_session_id is not null or
    (o.stripe_payment_intent_id is not null and o.stripe_payment_intent_id<>r.payment_intent_id) or
    not exists(select 1 from public.profiles where id=o.creator_id) then raise exception 'Original full order requires reconciliation'; end if;
  if exists(select 1 from public.purchases where payment_intent_id=r.payment_intent_id or order_id=o.id or
      (buyer_id=s.buyer_id and (product_id=s.product_id or (o.post_id is not null and post_id=o.post_id)))) or
    exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=r.payment_intent_id or stripe_charge_id=r.charge_id or order_id=o.id) then
    raise exception 'Full receipt cannot adopt unrelated accounting'; end if;
  insert into public.purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,order_id,amount_cents,currency,status,title,
    session_id,subscription_id,payment_intent_id,paid_at,access_granted)
    values(purchase,s.buyer_id,s.buyer_id,o.creator_id,s.product_id,o.post_id,o.id,o.amount_cents,'usd','paid',consent.terms->>'title',
      null,null,r.payment_intent_id,to_timestamp((proof->>'paidAt')::bigint),false);
  insert into public.payment_fee_ledger(id,creator_id,purchase_id,order_id,stripe_payment_intent_id,stripe_charge_id,
    stripe_balance_transaction_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,total_creator_deduction_cents,
    creator_net_cents,actual_stripe_fee_cents,processing_fee_variance_cents,currency,fee_schedule_version,status)
    values(ledger,o.creator_id,purchase,o.id,r.payment_intent_id,r.charge_id,proof->>'balanceTransactionId',o.amount_cents,
      o.platform_fee,o.processing_fee,o.total_creator_deduction,o.creator_amount,(proof->>'actualStripeFeeCents')::bigint,
      o.processing_fee-(proof->>'actualStripeFeeCents')::bigint,'usd',o.fee_schedule_version,'paid');
  if not public.credit_purchase_earnings(purchase,o.creator_amount::integer) then raise exception 'Full receipt earnings were not credited'; end if;
  if consent.terms ? 'serviceMonths' then
    if not public.bind_fixed_service_one_time_v1(purchase,consent.id,(s.source->>'attempt_key')::uuid,r.payment_intent_id,
      r.charge_id,(proof->>'paidAt')::bigint,o.amount_cents,'usd') then raise exception 'Full receipt service binding failed'; end if;
  else
    update public.purchases set access_granted=true where id=purchase;
  end if;
  update public.orders set status='paid',stripe_payment_intent_id=r.payment_intent_id,stripe_payment_id=r.payment_intent_id,
    stripe_charge_id=r.charge_id,stripe_balance_transaction_id=proof->>'balanceTransactionId',
    actual_stripe_fee=(proof->>'actualStripeFeeCents')::bigint,
    processing_fee_variance=processing_fee-(proof->>'actualStripeFeeCents')::bigint,updated_at=clock_timestamp() where id=o.id;
  update public.full_server_payment_receipts_v1 set purchase_id=purchase,ledger_id=ledger,accounted_at=clock_timestamp() where attempt_id=s.attempt_id;
  return jsonb_build_object('accounted',true,'attemptId',s.attempt_id,'purchaseId',purchase,'ledgerId',ledger,'purchaseStatus','paid');
end $$;
revoke all on function public.account_full_server_payment_receipt_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.account_full_server_payment_receipt_v1(uuid,uuid,jsonb) to service_role;

create function public.read_full_server_payment_receipt_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; r public.full_server_payment_receipts_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if s.kind<>'full' then raise exception 'Original full selection required'; end if;
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id;
  return case when r.attempt_id is null then null else to_jsonb(r) end;
end $$;
revoke all on function public.read_full_server_payment_receipt_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_full_server_payment_receipt_v1(uuid,uuid,jsonb) to service_role;

do $patch$
declare source text; needle text;
begin
  source:=pg_get_functiondef('public.record_full_server_payment_receipt_v1(uuid,uuid,jsonb,jsonb)'::regprocedure);
  needle:=$old$'recorded',false,'attemptId',s.attempt_id,'paymentIntentId',op.payment_intent_id,'accountingRequired',true$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Full receipt result shape differs'; end if;
  execute replace(source,needle,$new$'recorded',false,'attemptId',s.attempt_id,'paymentIntentId',op.payment_intent_id,'accountingRequired',saved.accounted_at is null$new$);
end $patch$;
commit;
