begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
alter table public.full_server_payment_refund_events_v1 add column observation_kind text not null default 'charge.refunded'
  check(observation_kind in ('charge.refunded','dispute_charge_readback'));

-- A charge refund can carry a concurrent dispute signal before the separate
-- dispute event arrives. Preserve a hold without inventing a dispute ID/status.
create function public.hold_full_server_payment_financial_signal_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; r public.full_server_payment_receipts_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  perform public.record_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context,p_proof);
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id for update;
  insert into public.full_server_payment_financial_holds_v1(attempt_id,payment_intent_id)
    values(s.attempt_id,r.payment_intent_id) on conflict(attempt_id) do nothing;
  if not exists(select 1 from public.full_server_payment_financial_holds_v1 where attempt_id=s.attempt_id and payment_intent_id=r.payment_intent_id) then
    raise exception 'Original combined financial hold differs'; end if;
  update public.full_server_payment_financial_holds_v1 set revision=revision+1 where attempt_id=s.attempt_id;
  if r.accounted_at is not null then
    perform public.account_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context);
    update public.purchases set access_granted=false where id=r.purchase_id;
  end if;
  return jsonb_build_object('attemptId',s.attempt_id,'paymentIntentId',r.payment_intent_id,'financialHold',true);
end $$;

create function public.apply_full_server_payment_refund_signal_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_proof jsonb,p_refunded_cents bigint,p_disputed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; r public.full_server_payment_receipts_v1%rowtype; result jsonb;
begin
  if p_disputed is null then raise exception 'Full financial charge signal required'; end if;
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  perform public.record_full_server_payment_receipt_v1(p_attempt_id,p_buyer_id,p_context,p_proof);
  select * into r from public.full_server_payment_receipts_v1 where attempt_id=s.attempt_id for update;
  if p_disputed then
    perform public.hold_full_server_payment_financial_signal_v1(p_attempt_id,p_buyer_id,p_context,p_proof);
  end if;
  result:=public.apply_full_server_payment_refund_v1(p_attempt_id,p_buyer_id,p_context,p_event_id,p_proof,p_refunded_cents);
  if p_disputed and r.accounted_at is not null then update public.purchases set access_granted=false where id=r.purchase_id; end if;
  return result;
end $$;

-- One signed dispute delivery can independently reveal cumulative refunded
-- money on its original charge. Record that as charge readback provenance,
-- never as a fabricated Stripe refund event or a new provider refund request.
create function public.apply_full_server_payment_financial_dispute_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_dispute_id text,p_proof jsonb,p_read jsonb,p_disputed_cents bigint,p_status text,p_event_created bigint,p_refunded_cents bigint)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare result text; applied jsonb;
begin
  if p_refunded_cents is null or p_refunded_cents<0 or p_refunded_cents>(p_proof->>'amountCents')::bigint then
    raise exception 'Original cumulative refund signal differs'; end if;
  result:=public.apply_full_server_payment_dispute_v1(p_attempt_id,p_buyer_id,p_context,p_event_id,p_dispute_id,
    p_proof,p_read,p_disputed_cents,p_status,p_event_created);
  if result='reconciliation_required' then return result; end if;
  if p_refunded_cents>0 then
    if exists(select 1 from public.full_server_payment_refund_events_v1 where event_id=p_event_id and observation_kind<>'dispute_charge_readback') then
      raise exception 'Original combined event provenance differs'; end if;
    applied:=public.apply_full_server_payment_refund_signal_v1(p_attempt_id,p_buyer_id,p_context,p_event_id,p_proof,p_refunded_cents,true);
    if applied->>'status' not in ('original_refund_applied','refund_recorded_accounting_review') then
      raise exception 'Combined refund observation incomplete'; end if;
    update public.full_server_payment_refund_events_v1 set observation_kind='dispute_charge_readback' where event_id=p_event_id;
  end if;
  return result;
end $$;
revoke all on function public.hold_full_server_payment_financial_signal_v1(uuid,uuid,jsonb,jsonb),
  public.apply_full_server_payment_refund_signal_v1(uuid,uuid,jsonb,text,jsonb,bigint,boolean),
  public.apply_full_server_payment_financial_dispute_v1(uuid,uuid,jsonb,text,text,jsonb,jsonb,bigint,text,bigint,bigint) from public,anon,authenticated;
grant execute on function public.hold_full_server_payment_financial_signal_v1(uuid,uuid,jsonb,jsonb),
  public.apply_full_server_payment_refund_signal_v1(uuid,uuid,jsonb,text,jsonb,bigint,boolean),
  public.apply_full_server_payment_financial_dispute_v1(uuid,uuid,jsonb,text,text,jsonb,jsonb,bigint,text,bigint,bigint) to service_role;
commit;
