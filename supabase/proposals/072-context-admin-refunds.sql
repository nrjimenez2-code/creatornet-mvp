-- UNAPPLIED. #1: bind the existing 021 refund engine and 045 collection hold
-- to an accounted context. No new refund calculation, ledger or policy.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.read_exact_context_stop_v2(uuid,uuid,jsonb)') is null or
    to_regprocedure('public.run_exact_context_admin_refund_v2(uuid,uuid,jsonb,uuid,text,jsonb)') is not null then
    raise exception 'Context refund prerequisites or collision'; end if;
end;
$preflight$;

create function public.run_exact_context_admin_refund_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,
  p_ledger_id uuid,p_phase text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; ledger public.payment_fee_ledger%rowtype; op public.refund_operations%rowtype;
  patched public.refund_operations%rowtype; operation_id uuid; token uuid; result text; patch jsonb;
begin
  -- Reuses the verified administrator/context/accounting check, including the
  -- agreement lock shared with monthly invoice dispatch and financial holds.
  state:=public.read_exact_context_stop_v2(p_reservation_id,p_actor_id,p_context);
  select l.* into ledger from public.payment_fee_ledger l join public.exact_installment_receipts r
    on r.ledger_id=l.id where r.agreement_id=p_reservation_id and r.counted_at is not null and l.id=p_ledger_id;
  if not found or p_phase is null or p_phase not in ('source','create','read','claim','coordinate','update') or
    jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'Context refund source or phase differs'; end if;
  if p_phase='source' then
    if p_payload<>'{}'::jsonb then raise exception 'Unexpected refund source payload'; end if;
    return jsonb_build_object('state',state,'ledger',to_jsonb(ledger),
      'customerTarget',greatest(ledger.refunded_amount_cents,coalesce((select max(cumulative_customer_refund_target_cents)
        from public.refund_operations where payment_fee_ledger_id=ledger.id and status<>'failed'),0)),
      'feeTarget',coalesce((select max(application_fee_refund_target_cents) from public.refund_operations
        where payment_fee_ledger_id=ledger.id and status<>'failed'),0));
  end if;
  if p_phase='create' then
    if (select count(*) from jsonb_object_keys(p_payload))<>13 or not(p_payload ?& array['operationId','paymentFeeLedgerId',
      'requestedRefundAmountCents','reasonCode','responsibility','internalNotes','idempotencyKey','initiatedBy','stripeChargeId',
      'stripeApplicationFeeId','stripeRefundedAmountCents','stripeApplicationFeeRefundedCents','actualStripeProcessingFeeCents']) or
      p_payload->>'paymentFeeLedgerId' is distinct from ledger.id::text or p_payload->>'initiatedBy' is distinct from p_actor_id::text then
      raise exception 'Context refund creation identity differs'; end if;
    op:=jsonb_populate_record(null::public.refund_operations,public.create_refund_operation((p_payload->>'operationId')::uuid,ledger.id,
      (p_payload->>'requestedRefundAmountCents')::bigint,p_payload->>'reasonCode',p_payload->>'responsibility',p_payload->>'internalNotes',
      p_payload->>'idempotencyKey',p_actor_id,p_payload->>'stripeChargeId',p_payload->>'stripeApplicationFeeId',
      (p_payload->>'stripeRefundedAmountCents')::bigint,(p_payload->>'stripeApplicationFeeRefundedCents')::bigint,
      (p_payload->>'actualStripeProcessingFeeCents')::bigint));
  else
    if (select count(*) from jsonb_object_keys(p_payload))<>(case when p_phase='read' then 1 when p_phase='update' then 3 else 2 end) or
      not(p_payload ? 'operationId') or (p_phase<>'read' and not(p_payload ? 'token')) or
      (p_phase='update' and not(p_payload ? 'patch')) then raise exception 'Context refund operation payload differs'; end if;
    operation_id:=(p_payload->>'operationId')::uuid; token:=(p_payload->>'token')::uuid;
    select * into op from public.refund_operations where id=operation_id and payment_fee_ledger_id=ledger.id for update;
    if not found then raise exception 'Context refund operation missing'; end if;
  end if;
  if op.payment_fee_ledger_id is distinct from ledger.id or op.creator_id is distinct from ledger.creator_id or
    op.stripe_payment_intent_id is distinct from ledger.stripe_payment_intent_id or op.currency is distinct from ledger.currency then
    raise exception 'Context refund operation binding differs'; end if;
  if p_phase in ('create','read') then return to_jsonb(op); end if;
  if token is null then raise exception 'Context refund claim token required'; end if;
  if p_phase='claim' then
    result:=public.claim_refund_operation(op.id,token,300); return to_jsonb(result);
  elsif p_phase='coordinate' then
    result:=public.admit_exact_installment_admin_refund(op.id,token);
    if result not in ('held','reconciliation_required') then raise exception 'Context refund hold missing'; end if;
    return to_jsonb(result);
  end if;
  if op.processing_token is distinct from token or op.processing_claimed_at is null or
    op.processing_claimed_at<=now()-interval '5 minutes' then raise exception 'Context refund claim lost'; end if;
  patch:=p_payload->'patch';
  if jsonb_typeof(patch) is distinct from 'object' or exists(select 1 from jsonb_object_keys(patch) k where k not in (
    'stripe_charge_id','stripe_application_fee_id','stripe_refund_id','stripe_application_fee_refund_id',
    'stripe_application_fee_refund_amount_cents','actual_stripe_processing_fee_cents','status','stripe_refund_status',
    'connected_balance_negative','last_error','reconciliation_info','processing_token','processing_claimed_at','updated_at')) or
    (patch ? 'processing_token' and patch->'processing_token'<>'null'::jsonb) or
    (patch ? 'processing_claimed_at' and patch->'processing_claimed_at'<>'null'::jsonb) then
    raise exception 'Context refund update fields differ'; end if;
  patched:=jsonb_populate_record(op,patch);
  if patched.stripe_charge_id is distinct from op.stripe_charge_id or patched.stripe_application_fee_id is distinct from op.stripe_application_fee_id then
    raise exception 'Context refund provider identity immutable'; end if;
  update public.refund_operations set stripe_refund_id=patched.stripe_refund_id,
    stripe_application_fee_refund_id=patched.stripe_application_fee_refund_id,
    stripe_application_fee_refund_amount_cents=patched.stripe_application_fee_refund_amount_cents,
    actual_stripe_processing_fee_cents=patched.actual_stripe_processing_fee_cents,status=patched.status,stripe_refund_status=patched.stripe_refund_status,
    connected_balance_negative=patched.connected_balance_negative,last_error=patched.last_error,reconciliation_info=patched.reconciliation_info,
    processing_token=patched.processing_token,processing_claimed_at=patched.processing_claimed_at,updated_at=now()
    where id=op.id and processing_token=token returning * into op;
  if not found then raise exception 'Context refund update lost claim'; end if;
  return to_jsonb(op);
end;
$$;
revoke all on function public.run_exact_context_admin_refund_v2(uuid,uuid,jsonb,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.run_exact_context_admin_refund_v2(uuid,uuid,jsonb,uuid,text,jsonb) to service_role;
comment on function public.run_exact_context_admin_refund_v2(uuid,uuid,jsonb,uuid,text,jsonb) is
  'Service-only context/administrator binding for the existing refund operation engine; no new economics.';
commit;
