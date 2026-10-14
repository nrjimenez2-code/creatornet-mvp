begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- One original accounting engine, with a private financial admission branch.
-- Public clean accounting retains every financial guard. No hold is removed
-- and no observation is hidden, even temporarily, to admit initial accounting.
do $patch$
declare source text; needle text; original_guard text; start_at integer; end_at integer;
begin
  source:=pg_get_functiondef('public.account_full_server_payment_receipt_v1(uuid,uuid,jsonb)'::regprocedure);
  needle:='public.account_full_server_payment_receipt_v1(p_attempt_id uuid, p_buyer_id uuid, p_context jsonb)';
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Full accounting signature differs'; end if;
  source:=replace(source,needle,'public.account_full_server_payment_receipt_core_v1(p_attempt_id uuid, p_buyer_id uuid, p_context jsonb, p_financial boolean)');
  start_at:=strpos(source,'  if exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=s.attempt_id) or');
  end_at:=strpos(source,'  select * into o from public.orders where id::text=proof->>');
  if start_at=0 or end_at<=start_at then raise exception 'Full financial accounting guard differs'; end if;
  original_guard:=substring(source from start_at for end_at-start_at);
  source:=replace(source,original_guard,'  if p_financial is not true then'||E'\n'||original_guard||'  end if;'||E'\n');
  needle:=$old$  else
    update public.purchases set access_granted=true where id=purchase;
  end if;$old$;
  if (length(source)-length(replace(source,needle,'')))/length(needle)<>1 then raise exception 'Full initial access branch differs'; end if;
  source:=replace(source,needle,$new$  elsif p_financial is not true then
    update public.purchases set access_granted=true where id=purchase;
  end if;
  if p_financial then
    update public.purchases set access_granted=false where id=purchase;
  end if;$new$);
  execute source;
end $patch$;
revoke all on function public.account_full_server_payment_receipt_core_v1(uuid,uuid,jsonb,boolean) from public,anon,authenticated,service_role;

create or replace function public.account_full_server_payment_receipt_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language sql security definer set search_path=pg_catalog as $$
  select public.account_full_server_payment_receipt_core_v1(p_attempt_id,p_buyer_id,p_context,false)
$$;
revoke all on function public.account_full_server_payment_receipt_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.account_full_server_payment_receipt_v1(uuid,uuid,jsonb) to service_role;

create function public.account_full_server_financial_receipt_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_event_id text,p_event_kind text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; r public.full_server_payment_receipts_v1%rowtype;
  refund public.payment_refund_state%rowtype; dispute public.payment_dispute_state%rowtype;
  refund_event public.full_server_payment_refund_events_v1%rowtype; dispute_event public.full_server_payment_dispute_events_v1%rowtype;
  result jsonb; applied jsonb;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id for update;
  if s.kind<>'full' or r.attempt_id is null or coalesce(p_event_kind,'') not in ('refund','dispute') then
    raise exception 'Original observed financial receipt required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.payment_intent_id,73591));
  -- Validate the immutable capture again before inspecting saved financial evidence.
  perform public.record_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context,r.proof);
  if p_event_kind='refund' then
    select * into refund_event from public.full_server_payment_refund_events_v1 where event_id=p_event_id and attempt_id=s.attempt_id;
    if refund_event.event_id is null or refund_event.payment_intent_id is distinct from r.payment_intent_id or
      refund_event.charge_id is distinct from r.charge_id then raise exception 'Original refund observation required'; end if;
  else
    select * into dispute_event from public.full_server_payment_dispute_events_v1 where event_id=p_event_id and attempt_id=s.attempt_id;
    if dispute_event.event_id is null or dispute_event.applied_at is null or dispute_event.charge_id is distinct from r.charge_id then
      raise exception 'Applied original dispute observation required'; end if;
  end if;
  select * into refund from public.payment_refund_state where stripe_payment_intent_id=r.payment_intent_id;
  if found and (refund.stripe_charge_id is distinct from r.charge_id or refund.charge_amount_cents::text is distinct from r.proof->>'amountCents' or
      refund.refunded_amount_cents is null or refund.refunded_amount_cents<0 or refund.refunded_amount_cents>refund.charge_amount_cents) then
    raise exception 'Original financial refund state differs'; end if;
  if p_event_kind='refund' and (refund.stripe_payment_intent_id is null or refund.refunded_amount_cents<refund_event.observed_refunded_cents) then
    raise exception 'Original cumulative refund missing'; end if;
  if exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=r.payment_intent_id and
    (stripe_charge_id is distinct from r.charge_id or currency is distinct from 'usd' or
     disputed_amount_cents is null or disputed_amount_cents not between 1 and (r.proof->>'amountCents')::bigint or
     status is null or status not in ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented')))
    then raise exception 'Original financial dispute state differs'; end if;
  if p_event_kind='dispute' and not exists(select 1 from public.payment_dispute_state where stripe_dispute_id=dispute_event.dispute_id and
    stripe_payment_intent_id=r.payment_intent_id and stripe_charge_id=r.charge_id) then raise exception 'Original dispute state missing'; end if;
  -- Retain a financial hold for early financial accounting. Original money is
  -- credited and its recorded refund reversed within this one transaction;
  -- no intermediate net earnings or access can become externally visible.
  insert into public.full_server_payment_financial_holds_v1(attempt_id,payment_intent_id)
    values(s.attempt_id,r.payment_intent_id) on conflict(attempt_id) do nothing;
  if not exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=s.attempt_id and payment_intent_id=r.payment_intent_id) then
    raise exception 'Original financial hold differs'; end if;
  result:=public.account_full_server_payment_receipt_core_v1(p_attempt_id,p_buyer_id,p_context,true);
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id;
  if coalesce(refund.refunded_amount_cents,0)>0 then
    -- A refund observation must exist; never synthesize one from a dispute event.
    select * into refund_event from public.full_server_payment_refund_events_v1 where attempt_id=s.attempt_id
      and payment_intent_id=r.payment_intent_id and charge_id=r.charge_id order by recorded_at,event_id limit 1;
    if refund_event.event_id is null then raise exception 'Owned refund event required for financial accounting'; end if;
    applied:=public.apply_full_server_payment_refund_v1(p_attempt_id,p_buyer_id,p_context,refund_event.event_id,r.proof,refund.refunded_amount_cents);
    if applied->>'status' is distinct from 'original_refund_applied' then raise exception 'Original refund application incomplete'; end if;
    update public.full_server_payment_refund_events_v1 set applied_at=coalesce(applied_at,clock_timestamp()) where attempt_id=s.attempt_id and
      payment_intent_id=r.payment_intent_id and charge_id=r.charge_id and observed_refunded_cents<=refund.refunded_amount_cents;
  end if;
  select * into dispute from public.payment_dispute_state where stripe_payment_intent_id=r.payment_intent_id
    order by (status not in ('won','warning_closed','prevented')) desc,stripe_event_created desc,stripe_dispute_id limit 1;
  if found then
    update public.payment_fee_ledger set stripe_dispute_id=dispute.stripe_dispute_id,disputed_amount_cents=dispute.disputed_amount_cents,
      dispute_status=dispute.status,updated_at=clock_timestamp() where id=r.ledger_id;
  end if;
  update public.purchases set access_granted=false where id=r.purchase_id;
  update public.full_server_payment_financial_holds_v1 set revision=revision+1 where attempt_id=s.attempt_id;
  return jsonb_build_object('status','original_financial_capture_accounted','attemptId',s.attempt_id,'paymentIntentId',r.payment_intent_id,
    'purchaseId',r.purchase_id,'ledgerId',r.ledger_id,'accounted',result->'accounted','refundedCents',coalesce(refund.refunded_amount_cents,0),
    'disputeDisposition',dispute_event.disposition);
end $$;
revoke all on function public.account_full_server_financial_receipt_v1(uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.account_full_server_financial_receipt_v1(uuid,uuid,jsonb,text,text) to service_role;
commit;
