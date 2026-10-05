begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.server_payment_confirmations_v1 (
  operation_id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.server_payment_intent_operations_v1(attempt_id),
  phase integer not null check(phase>0),
  previous_operation_id uuid unique references public.server_payment_confirmations_v1(operation_id),
  payment_intent_id text not null check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  basis jsonb not null,
  request jsonb not null,
  first_dispatch_at timestamptz not null default clock_timestamp(),
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default clock_timestamp()+interval '75 seconds',
  dispatch_before timestamptz not null,
  latest_observation jsonb,
  unique(attempt_id,phase),
  check((phase=1)=(previous_operation_id is null))
);
create unique index server_payment_confirmation_token_v1 on public.server_payment_confirmations_v1((basis#>>'{token,tokenId}'))
  where basis->>'kind'='token';
create table public.server_payment_confirmation_observations_v1 (
  operation_id uuid not null references public.server_payment_confirmations_v1(operation_id),
  observation jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(operation_id,observation)
);
alter table public.server_payment_confirmations_v1 enable row level security;
alter table public.server_payment_confirmation_observations_v1 enable row level security;
revoke all on public.server_payment_confirmations_v1,public.server_payment_confirmation_observations_v1 from public,anon,authenticated,service_role;
grant select on public.server_payment_confirmations_v1,public.server_payment_confirmation_observations_v1 to service_role;

-- Validate an independently retrieved original before admitting a confirmation.
-- The service caller remains responsible for actually retrieving this evidence.
create function public.validate_server_confirmation_intent_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_intent jsonb)
returns public.server_payment_intent_operations_v1 language plpgsql security definer set search_path=pg_catalog as $$
declare op public.server_payment_intent_operations_v1%rowtype; params jsonb;
begin
  perform public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into op from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id;
  if not found or op.bound_at is null then raise exception 'Original manual intent is not bound'; end if;
  params:=op.request->'params';
  if p_intent->>'id' is distinct from op.payment_intent_id or p_intent->>'object' is distinct from 'payment_intent' or
    p_intent->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or p_intent->>'customer' is distinct from params->>'customer' or
    p_intent->'amount' is distinct from params->'amount' or p_intent->>'currency' is distinct from 'usd' or
    p_intent->>'confirmation_method' is distinct from 'manual' or p_intent->>'capture_method' is distinct from 'automatic_async' or
    p_intent->'metadata' is distinct from params->'metadata' or p_intent->'application_fee_amount' is distinct from params->'application_fee_amount' or
    p_intent->'transfer_data' is distinct from params->'transfer_data' or p_intent->>'setup_future_usage' is distinct from params->>'setup_future_usage' or
    p_intent->'payment_method_types' is distinct from '["card"]'::jsonb or p_intent#>'{automatic_payment_methods,enabled}'='true'::jsonb or
    p_intent->'amount_received' is distinct from '0'::jsonb or p_intent->'amount_capturable' is distinct from '0'::jsonb or
    p_intent->>'on_behalf_of' is not null or p_intent->>'shipping' is not null or p_intent->>'transfer_group' is not null or
    p_intent->>'last_payment_error' is not null or p_intent->>'next_action' is not null or
    coalesce(p_intent->>'created','')!~'^[0-9]{1,12}$' or
    (p_intent->>'created')::bigint<floor(extract(epoch from op.first_dispatch_at))-5 or
    (p_intent->>'created')::bigint>floor(extract(epoch from clock_timestamp())) or
    (p_intent->>'created')::bigint>=(op.contract->>'expiresAt')::bigint then raise exception 'Original manual confirmation evidence differs'; end if;
  return op;
end $$;
revoke all on function public.validate_server_confirmation_intent_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.validate_server_confirmation_intent_v1(uuid,uuid,jsonb,jsonb) to service_role;

create function public.read_latest_server_confirmation_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.server_payment_confirmations_v1%rowtype;
begin
  perform public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into op from public.server_payment_confirmations_v1 where attempt_id=p_attempt_id order by phase desc limit 1;
  if not found then return null; end if;
  return to_jsonb(op);
end $$;
revoke all on function public.read_latest_server_confirmation_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_latest_server_confirmation_v1(uuid,uuid,jsonb) to service_role;

create function public.claim_server_confirmation_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_basis jsonb,p_intent jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare original public.server_payment_intent_operations_v1%rowtype; latest public.server_payment_confirmations_v1%rowtype;
  previous_id uuid; next_phase integer:=1; params jsonb; token jsonb; now_at timestamptz; deadline timestamptz; replay boolean:=false;
begin
  perform public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into original from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id;
  if not found or original.bound_at is null then raise exception 'Bound original required for confirmation'; end if;
  now_at:=clock_timestamp();
  select * into latest from public.server_payment_confirmations_v1 where attempt_id=p_attempt_id order by phase desc limit 1;
  if found and latest.basis=p_basis then
    replay:=true;
    if latest.latest_observation->>'status' in ('succeeded','processing','canceled','requires_action') then
      return jsonb_build_object('status','observe_only','operation',to_jsonb(latest)); end if;
    if latest.first_dispatch_at<=now_at-interval '23 hours' or (original.contract->>'expiresAt')::bigint<=floor(extract(epoch from now_at)) then
      return jsonb_build_object('status','reconciliation_required','operation',to_jsonb(latest)); end if;
    if latest.lease_until>now_at then return jsonb_build_object('status','busy','operation',to_jsonb(latest)); end if;
  end if;
  perform public.validate_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context,original.contract,original.request);
  original:=public.validate_server_confirmation_intent_v1(p_attempt_id,p_buyer_id,p_context,p_intent);
  if jsonb_typeof(p_basis) is distinct from 'object' then raise exception 'Confirmation basis required'; end if;
  if p_basis->>'kind'='token' then
    token:=p_basis->'token';
    if p_basis-array['kind','token']<>'{}'::jsonb or jsonb_typeof(token) is distinct from 'object' or
      token-array['tokenId','createdAt','expiresAt','previewHash','country']<>'{}'::jsonb or
      coalesce(token->>'tokenId','')!~'^ctoken_[A-Za-z0-9]+$' or token->>'country' is distinct from 'US' or
      coalesce(token->>'previewHash','')!~'^[a-f0-9]{64}$' or coalesce(token->>'createdAt','')!~'^[0-9]{1,12}$' or
      coalesce(token->>'expiresAt','')!~'^[0-9]{1,12}$' or (token->>'createdAt')::bigint<(original.contract->>'acceptedAt')::bigint or
      (token->>'createdAt')::bigint>floor(extract(epoch from now_at)) or (token->>'expiresAt')::bigint<=floor(extract(epoch from now_at))+30 or
      (latest.operation_id is not null and not replay) or p_intent->>'status' is distinct from 'requires_payment_method' or
      p_intent->>'payment_method' is not null or p_intent->>'latest_charge' is not null then
      raise exception 'Only the original unused US token phase is admitted'; end if;
  elsif p_basis->>'kind'='after_authentication' then
    if p_basis-array['kind','paymentMethodId','previousOperationId']<>'{}'::jsonb or
      coalesce(p_basis->>'paymentMethodId','')!~'^pm_[A-Za-z0-9]+$' or
      coalesce(p_basis->>'previousOperationId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' or
      p_intent->>'status' is distinct from 'requires_confirmation' or
      p_intent->>'payment_method' is distinct from p_basis->>'paymentMethodId' then raise exception 'Original authenticated card differs'; end if;
    previous_id:=(p_basis->>'previousOperationId')::uuid;
    if (not replay and latest.operation_id is distinct from previous_id) or
      (replay and latest.previous_operation_id is distinct from previous_id) or
      not exists(select 1 from public.server_payment_confirmations_v1 prior where prior.operation_id=previous_id and prior.attempt_id=p_attempt_id and
        prior.payment_intent_id=original.payment_intent_id and prior.latest_observation->>'status' in ('requires_action','requires_confirmation') and
        prior.latest_observation->>'paymentMethodId'=p_basis->>'paymentMethodId' and
        (prior.latest_observation->>'chargeId' is null or prior.latest_observation->>'chargeId'=p_intent->>'latest_charge') and
        exists(select 1 from public.server_payment_confirmation_observations_v1 seen where seen.operation_id=prior.operation_id and
          seen.observation->>'status'='requires_action' and seen.observation->>'paymentMethodId'=p_basis->>'paymentMethodId' and
          seen.observation->>'nextActionHash' is not null)) or
      (not replay and latest.lease_until>now_at) then raise exception 'Bank authentication needs its completed original predecessor'; end if;
    if not replay then next_phase:=latest.phase+1; end if;
  else raise exception 'Unsupported confirmation phase'; end if;
  params:=jsonb_build_object('return_url',(original.contract#>>'{context,siteOrigin}')||'/purchase/payment/return?attempt='||p_attempt_id::text,'use_stripe_sdk',true);
  if p_basis->>'kind'='token' then params:=params||jsonb_build_object('confirmation_token',token->>'tokenId'); end if;
  deadline:=least(now_at+interval '30 seconds',to_timestamp((original.contract->>'expiresAt')::bigint),
    case when replay then latest.first_dispatch_at+interval '23 hours' else now_at+interval '23 hours' end);
  if p_basis->>'kind'='token' then deadline:=least(deadline,to_timestamp((token->>'expiresAt')::bigint)-interval '1 second'); end if;
  if replay then
    update public.server_payment_confirmations_v1 set lease_token=gen_random_uuid(),lease_until=now_at+interval '75 seconds',dispatch_before=deadline
      where operation_id=latest.operation_id returning * into latest;
  else
    insert into public.server_payment_confirmations_v1(attempt_id,phase,previous_operation_id,payment_intent_id,basis,request,dispatch_before)
      values(p_attempt_id,next_phase,previous_id,original.payment_intent_id,p_basis,
        jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/payment_intents/'||original.payment_intent_id||'/confirm','params',params),deadline)
      returning * into latest;
  end if;
  return jsonb_build_object('status','dispatch','operation',to_jsonb(latest));
end $$;
revoke all on function public.claim_server_confirmation_v1(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.claim_server_confirmation_v1(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

create function public.assert_server_confirmation_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_operation_id uuid,p_lease_token uuid,p_for_dispatch boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.server_payment_confirmations_v1%rowtype; original public.server_payment_intent_operations_v1%rowtype;
begin
  perform public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,p_for_dispatch);
  select * into op from public.server_payment_confirmations_v1 where operation_id=p_operation_id and attempt_id=p_attempt_id;
  if not found then raise exception 'Original confirmation phase unavailable'; end if;
  select * into original from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id;
  if original.bound_at is null or op.payment_intent_id is distinct from original.payment_intent_id then raise exception 'Original confirmation binding differs'; end if;
  if p_for_dispatch then
    if op.lease_token is distinct from p_lease_token or op.lease_until<=clock_timestamp() or op.dispatch_before<=clock_timestamp() or
      op.first_dispatch_at<=clock_timestamp()-interval '23 hours' or
      exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=p_attempt_id and phase>op.phase) or
      op.latest_observation->>'status' in ('succeeded','processing','canceled','requires_action') then
      raise exception 'Confirmation dispatch no longer admitted'; end if;
    perform public.validate_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context,original.contract,original.request);
  end if;
  return to_jsonb(op);
end $$;
revoke all on function public.assert_server_confirmation_v1(uuid,uuid,jsonb,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.assert_server_confirmation_v1(uuid,uuid,jsonb,uuid,uuid,boolean) to service_role;

create function public.record_server_confirmation_observation_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_operation_id uuid,p_lease_token uuid,p_observation jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.server_payment_confirmations_v1%rowtype; prior jsonb; status text;
begin
  perform public.assert_server_confirmation_v1(p_attempt_id,p_buyer_id,p_context,p_operation_id,p_lease_token,false);
  select * into op from public.server_payment_confirmations_v1 where operation_id=p_operation_id;
  if op.lease_token is distinct from p_lease_token or exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=p_attempt_id and phase>op.phase) then
    raise exception 'Read the current original confirmation phase'; end if;
  prior:=op.latest_observation;status:=p_observation->>'status';
  if jsonb_typeof(p_observation) is distinct from 'object' or
    p_observation-array['paymentIntentId','status','paymentMethodId','chargeId','observedAt','nextActionHash']<>'{}'::jsonb or
    p_observation->>'paymentIntentId' is distinct from op.payment_intent_id or
    coalesce(status,'') not in ('requires_payment_method','requires_confirmation','requires_action','processing','succeeded','canceled') or
    coalesce(p_observation->>'observedAt','')!~'^[0-9]{1,12}$' or
    (p_observation->>'observedAt')::bigint<floor(extract(epoch from op.first_dispatch_at)) or
    (p_observation->>'observedAt')::bigint>floor(extract(epoch from clock_timestamp())) or
    (p_observation->>'paymentMethodId' is not null and p_observation->>'paymentMethodId'!~'^pm_[A-Za-z0-9]+$') or
    (p_observation->>'chargeId' is not null and p_observation->>'chargeId'!~'^ch_[A-Za-z0-9]+$') or
    (p_observation->>'nextActionHash' is not null and p_observation->>'nextActionHash'!~'^[a-f0-9]{64}$') or
    (status in ('requires_action','requires_confirmation','processing','succeeded') and p_observation->>'paymentMethodId' is null) or
    (status='succeeded' and p_observation->>'chargeId' is null) or
    ((status='requires_action') is distinct from (p_observation->>'nextActionHash' is not null)) or
    (op.basis->>'kind'='after_authentication' and status not in ('canceled','requires_payment_method') and
      p_observation->>'paymentMethodId' is distinct from op.basis->>'paymentMethodId') or
    (prior is not null and (p_observation->>'observedAt')::bigint<(prior->>'observedAt')::bigint) or
    (prior->>'status' in ('succeeded','canceled') and (prior-'observedAt') is distinct from (p_observation-'observedAt')) then
    raise exception 'Original confirmation observation differs'; end if;
  insert into public.server_payment_confirmation_observations_v1(operation_id,observation) values(op.operation_id,p_observation) on conflict do nothing;
  -- A recorded outcome ends this lease, but the original operation/key remain.
  -- requires_payment_method may still be an unknown reply; only same-key retry
  -- is possible, and it retains the original lease wait to avoid a hot loop.
  update public.server_payment_confirmations_v1 set latest_observation=p_observation,
    lease_until=case when status='requires_payment_method' then lease_until else least(lease_until,clock_timestamp()) end,
    dispatch_before=case when status='requires_payment_method' then dispatch_before else least(dispatch_before,clock_timestamp()) end
    where operation_id=op.operation_id;
  return p_observation;
end $$;
revoke all on function public.record_server_confirmation_observation_v1(uuid,uuid,jsonb,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_server_confirmation_observation_v1(uuid,uuid,jsonb,uuid,uuid,jsonb) to service_role;
commit;
