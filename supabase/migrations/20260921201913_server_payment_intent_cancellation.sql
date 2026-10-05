begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.server_payment_intent_cancellations_v1 (
  attempt_id uuid primary key references public.server_payment_protocols_v1(attempt_id),
  payment_intent_id text not null unique check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  request jsonb not null,
  idempotency_key text not null unique default ('cn-server-intent-cancel-v1:'||gen_random_uuid()::text),
  first_dispatch_at timestamptz not null default clock_timestamp(),
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default clock_timestamp()+interval '75 seconds',
  dispatch_before timestamptz not null
);
create table public.server_payment_intent_terminal_v1 (
  attempt_id uuid primary key references public.server_payment_protocols_v1(attempt_id),
  proof jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.server_payment_intent_cancellations_v1 enable row level security;
alter table public.server_payment_intent_terminal_v1 enable row level security;
revoke all on public.server_payment_intent_cancellations_v1,public.server_payment_intent_terminal_v1 from public,anon,authenticated,service_role;
grant select on public.server_payment_intent_cancellations_v1,public.server_payment_intent_terminal_v1 to service_role;

-- After expiry/stop, read the exact original without reauthorizing a payment.
-- Unbound creates stay unresolved; neither absence nor lease expiry proves that
-- no intent was created. Only its independently bound original can be canceled.
create function public.read_server_payment_cancellation_source_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; a public.product_checkout_attempts%rowtype;
  original public.server_payment_intent_operations_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if not exists(select 1 from public.server_payment_stops_v1 where attempt_id=p_attempt_id) then
    raise exception 'Original stop must be persisted first'; end if;
  select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and product_id=s.product_id;
  if not found or a.status<>'creating' or a.stripe_checkout_session_id is not null or a.original_request is not null or
    exists(select 1 from public.purchases where buyer_id=p_buyer_id and (product_id=s.product_id or (a.post_id is not null and post_id=a.post_id))) or
    (s.kind='first_installment' and (exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=s.reservation_id) or
      exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=s.reservation_id))) then
    raise exception 'Original payment requires financial reconciliation'; end if;
  select * into original from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id;
  if not found or original.bound_at is null then return null; end if;
  return to_jsonb(original);
end $$;

create function public.claim_server_payment_cancellation_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare original jsonb; op public.server_payment_intent_cancellations_v1%rowtype;
begin
  original:=public.read_server_payment_cancellation_source_v1(p_attempt_id,p_buyer_id,p_context);
  if original is null then return jsonb_build_object('status','reconciliation_required','operation',null); end if;
  select * into op from public.server_payment_intent_cancellations_v1 where attempt_id=p_attempt_id;
  if exists(select 1 from public.server_payment_intent_terminal_v1 where attempt_id=p_attempt_id) then
    return jsonb_build_object('status','terminal','operation',case when op.attempt_id is null then null else to_jsonb(op) end); end if;
  if found then
    if op.payment_intent_id is distinct from original->>'payment_intent_id' then raise exception 'Original cancellation binding differs'; end if;
    if op.first_dispatch_at<=clock_timestamp()-interval '23 hours' then
      return jsonb_build_object('status','reconciliation_required','operation',to_jsonb(op)); end if;
    if op.lease_until>clock_timestamp() then return jsonb_build_object('status','busy','operation',to_jsonb(op)); end if;
    update public.server_payment_intent_cancellations_v1 set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '75 seconds',
      dispatch_before=least(clock_timestamp()+interval '30 seconds',first_dispatch_at+interval '23 hours')
      where attempt_id=p_attempt_id returning * into op;
  else
    insert into public.server_payment_intent_cancellations_v1(attempt_id,payment_intent_id,request,dispatch_before)
      values(p_attempt_id,original->>'payment_intent_id',jsonb_build_object('apiVersion','2025-10-29.clover','method','POST',
        'path','/v1/payment_intents/'||(original->>'payment_intent_id')||'/cancel','params',jsonb_build_object('cancellation_reason','requested_by_customer')),
        clock_timestamp()+interval '30 seconds') returning * into op;
  end if;
  return jsonb_build_object('status','dispatch','operation',to_jsonb(op));
end $$;

create function public.assert_server_payment_cancellation_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare original jsonb; op public.server_payment_intent_cancellations_v1%rowtype;
begin
  original:=public.read_server_payment_cancellation_source_v1(p_attempt_id,p_buyer_id,p_context);
  select * into op from public.server_payment_intent_cancellations_v1 where attempt_id=p_attempt_id;
  if not found or original is null or op.payment_intent_id is distinct from original->>'payment_intent_id' or
    op.lease_token is distinct from p_lease_token or op.lease_until<=clock_timestamp() or op.dispatch_before<=clock_timestamp() or
    op.first_dispatch_at<=clock_timestamp()-interval '23 hours' or
    exists(select 1 from public.server_payment_intent_terminal_v1 where attempt_id=p_attempt_id) then
    raise exception 'Original cancellation dispatch no longer admitted'; end if;
  return to_jsonb(op);
end $$;

-- Minimal terminal proof, not release authority. No charge/refund/transfer or
-- subscription accounting is changed. Provider provenance is checked by the
-- internal runtime; SQL enforces exact source, zero money and immutable proof.
create function public.record_server_payment_terminal_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare original jsonb; saved public.server_payment_intent_terminal_v1%rowtype; t bigint:=floor(extract(epoch from clock_timestamp()));
begin
  original:=public.read_server_payment_cancellation_source_v1(p_attempt_id,p_buyer_id,p_context);
  if original is null or jsonb_typeof(p_proof) is distinct from 'object' or
    p_proof-array['version','paymentIntentId','status','amountReceived','amountCapturable','canceledAt','chargeIds','observedAt']<>'{}'::jsonb or
    p_proof->>'version' is distinct from 'server-payment-intent-terminal-v1' or
    p_proof->>'paymentIntentId' is distinct from original->>'payment_intent_id' or p_proof->>'status' is distinct from 'canceled' or
    p_proof->'amountReceived' is distinct from '0'::jsonb or p_proof->'amountCapturable' is distinct from '0'::jsonb or
    coalesce(p_proof->>'canceledAt','')!~'^[0-9]{1,12}$' or coalesce(p_proof->>'observedAt','')!~'^[0-9]{1,12}$' or
    (p_proof->>'canceledAt')::bigint<floor(extract(epoch from (original->>'first_dispatch_at')::timestamptz))-5 or
    (p_proof->>'canceledAt')::bigint>(p_proof->>'observedAt')::bigint or
    (p_proof->>'observedAt')::bigint<t-30 or (p_proof->>'observedAt')::bigint>t or
    jsonb_typeof(p_proof->'chargeIds') is distinct from 'array' or jsonb_array_length(p_proof->'chargeIds')>10000 or
    exists(select 1 from jsonb_array_elements(p_proof->'chargeIds') x where jsonb_typeof(x)<>'string' or (x#>>'{}')!~'^ch_[A-Za-z0-9]+$') or
    (select count(*) from jsonb_array_elements(p_proof->'chargeIds'))<>(select count(distinct x) from jsonb_array_elements(p_proof->'chargeIds') x) then
    raise exception 'Original unpaid terminal evidence differs'; end if;
  select * into saved from public.server_payment_intent_terminal_v1 where attempt_id=p_attempt_id;
  if found then
    if (saved.proof-'observedAt') is distinct from (p_proof-'observedAt') then raise exception 'Original terminal proof cannot change'; end if;
    return saved.proof;
  end if;
  insert into public.server_payment_intent_terminal_v1(attempt_id,proof) values(p_attempt_id,p_proof);
  return p_proof;
end $$;

revoke all on function public.read_server_payment_cancellation_source_v1(uuid,uuid,jsonb),
  public.claim_server_payment_cancellation_v1(uuid,uuid,jsonb),public.assert_server_payment_cancellation_v1(uuid,uuid,jsonb,uuid),
  public.record_server_payment_terminal_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.read_server_payment_cancellation_source_v1(uuid,uuid,jsonb),
  public.claim_server_payment_cancellation_v1(uuid,uuid,jsonb),public.assert_server_payment_cancellation_v1(uuid,uuid,jsonb,uuid),
  public.record_server_payment_terminal_v1(uuid,uuid,jsonb,jsonb) to service_role;
commit;
