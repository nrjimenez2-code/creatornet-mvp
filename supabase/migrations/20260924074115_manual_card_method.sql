begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Add Card Element PaymentMethod phases without changing any saved operation,
-- confirmation key, token request, receipt, consent or stop rule.
create unique index server_payment_confirmation_method_v1
 on public.server_payment_confirmations_v1((basis#>>'{method,paymentMethodId}'))
 where basis->>'kind' in ('card','card_replacement');
create or replace function public.claim_server_confirmation_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_basis jsonb,p_intent jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare original public.server_payment_intent_operations_v1%rowtype; latest public.server_payment_confirmations_v1%rowtype;
  previous_id uuid; next_phase integer:=1; params jsonb; token jsonb; now_at timestamptz; deadline timestamptz; replay boolean:=false; card_method boolean; replacing boolean;
begin
  perform public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into original from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id;
  if not found or original.bound_at is null then raise exception 'Bound original required for confirmation'; end if;
  now_at:=clock_timestamp();
  select * into latest from public.server_payment_confirmations_v1 where attempt_id=p_attempt_id order by phase desc limit 1;
  if found and latest.basis=p_basis then
    replay:=true;
    if latest.latest_observation ? 'failure' or latest.latest_observation->>'status' in ('succeeded','processing','canceled','requires_action') then
      return jsonb_build_object('status','observe_only','operation',to_jsonb(latest)); end if;
    if latest.first_dispatch_at<=now_at-interval '23 hours' or (original.contract->>'expiresAt')::bigint<=floor(extract(epoch from now_at)) then
      return jsonb_build_object('status','reconciliation_required','operation',to_jsonb(latest)); end if;
    if latest.lease_until>now_at then return jsonb_build_object('status','busy','operation',to_jsonb(latest)); end if;
  end if;
  perform public.validate_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context,original.contract,original.request);
  original:=public.validate_server_confirmation_intent_v1(p_attempt_id,p_buyer_id,p_context,p_intent);
  if jsonb_typeof(p_basis) is distinct from 'object' then raise exception 'Confirmation basis required'; end if;
  card_method:=p_basis->>'kind' in ('card','card_replacement');
  replacing:=p_basis->>'kind' in ('replacement','card_replacement');
  if p_basis->>'kind' in ('token','replacement','card','card_replacement') then
    token:=case when card_method then p_basis->'method' else p_basis->'token' end;
    if p_basis-(case when replacing then array['kind',case when card_method then 'method' else 'token' end,'previousOperationId','failure'] else array['kind',case when card_method then 'method' else 'token' end] end)<>'{}'::jsonb or jsonb_typeof(token) is distinct from 'object' or
      token-array[case when card_method then 'paymentMethodId' else 'tokenId' end,'createdAt','expiresAt','previewHash','country']<>'{}'::jsonb or
      (case when card_method then coalesce(token->>'paymentMethodId','')!~'^pm_[A-Za-z0-9]+$' else coalesce(token->>'tokenId','')!~'^ctoken_[A-Za-z0-9]+$' end) or token->>'country' is distinct from 'US' or
      coalesce(token->>'previewHash','')!~'^[a-f0-9]{64}$' or coalesce(token->>'createdAt','')!~'^[0-9]{1,12}$' or
      coalesce(token->>'expiresAt','')!~'^[0-9]{1,12}$' or (token->>'createdAt')::bigint<(original.contract->>'acceptedAt')::bigint or
      (token->>'createdAt')::bigint>floor(extract(epoch from now_at)) or (token->>'expiresAt')::bigint<=floor(extract(epoch from now_at))+30 or
      p_intent->>'status' is distinct from 'requires_payment_method' then
      raise exception 'Only the original unused US token phase is admitted'; end if;
    if card_method and (token->>'expiresAt')::bigint is distinct from least((original.contract->>'expiresAt')::bigint,(token->>'createdAt')::bigint+43200) then raise exception 'Card method admission window differs'; end if;
    if not replacing then
      if (latest.operation_id is not null and not replay) or p_intent->>'payment_method' is not null or
        p_intent->>'latest_charge' is not null or p_intent->>'last_payment_error' is not null then
        raise exception 'Initial confirmation must be untouched'; end if;
    else
      if coalesce(p_basis->>'previousOperationId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' or
        jsonb_typeof(p_basis->'failure') is distinct from 'object' then raise exception 'Replacement failure predecessor required'; end if;
      previous_id:=(p_basis->>'previousOperationId')::uuid;
      if (not replay and latest.operation_id is distinct from previous_id) or
        (replay and latest.previous_operation_id is distinct from previous_id) or
        not exists(select 1 from public.server_payment_confirmations_v1 prior where prior.operation_id=previous_id and
          prior.attempt_id=p_attempt_id and prior.payment_intent_id=original.payment_intent_id and
          prior.latest_observation->>'status'='requires_payment_method' and prior.latest_observation->'failure'=p_basis->'failure' and
          prior.latest_observation->>'chargeId'=p_basis#>>'{failure,chargeId}' and
          prior.lease_until<=now_at and
          exists(select 1 from public.server_payment_confirmation_observations_v1 seen where seen.operation_id=prior.operation_id and
            seen.observation->'failure'=p_basis->'failure' and (seen.observation->>'observedAt')::bigint<=(token->>'createdAt')::bigint)) or
        p_intent->>'latest_charge' is distinct from p_basis#>>'{failure,chargeId}' or
        p_intent#>>'{last_payment_error,charge}' is distinct from p_basis#>>'{failure,chargeId}' or
        p_intent#>>'{last_payment_error,payment_method,id}' is distinct from p_basis#>>'{failure,paymentMethodId}' or
        p_intent#>>'{last_payment_error,code}' is distinct from p_basis#>>'{failure,code}' or
        (p_intent->>'payment_method' is not null and p_intent->>'payment_method' is distinct from p_basis#>>'{failure,paymentMethodId}') then
        raise exception 'Replacement requires the current independently proved failure'; end if;
      if not replay then next_phase:=latest.phase+1; end if;
    end if;
  elsif p_basis->>'kind'='after_authentication' then
    if p_basis-array['kind','paymentMethodId','previousOperationId']<>'{}'::jsonb or
      coalesce(p_basis->>'paymentMethodId','')!~'^pm_[A-Za-z0-9]+$' or
      coalesce(p_basis->>'previousOperationId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' or
      p_intent->>'last_payment_error' is not null or p_intent->>'status' is distinct from 'requires_confirmation' or
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
  if card_method then params:=params||jsonb_build_object('payment_method',token->>'paymentMethodId');
  elsif p_basis->>'kind' in ('token','replacement') then params:=params||jsonb_build_object('confirmation_token',token->>'tokenId'); end if;
  deadline:=least(now_at+interval '30 seconds',to_timestamp((original.contract->>'expiresAt')::bigint),
    case when replay then latest.first_dispatch_at+interval '23 hours' else now_at+interval '23 hours' end);
  if p_basis->>'kind' in ('token','replacement','card','card_replacement') then deadline:=least(deadline,to_timestamp((token->>'expiresAt')::bigint)-interval '1 second'); end if;
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
create or replace function public.record_server_confirmation_observation_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_operation_id uuid,p_lease_token uuid,p_observation jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.server_payment_confirmations_v1%rowtype; prior jsonb; status text;
begin
  perform public.assert_server_confirmation_v1(p_attempt_id,p_buyer_id,p_context,p_operation_id,p_lease_token,false);
  select * into op from public.server_payment_confirmations_v1 where operation_id=p_operation_id;
  if op.lease_token is distinct from p_lease_token or exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=p_attempt_id and phase>op.phase) then
    raise exception 'Read the current original confirmation phase'; end if;
  prior:=op.latest_observation;status:=p_observation->>'status';
  if jsonb_typeof(p_observation) is distinct from 'object' or
    p_observation-array['paymentIntentId','status','paymentMethodId','chargeId','observedAt','nextActionHash','failure']<>'{}'::jsonb or
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
    (p_observation ? 'failure' and (
      status<>'requires_payment_method' or jsonb_typeof(p_observation->'failure') is distinct from 'object' or
      (p_observation->'failure')-array['chargeId','paymentMethodId','code']<>'{}'::jsonb or
      coalesce(p_observation#>>'{failure,chargeId}','')!~'^ch_[A-Za-z0-9]+$' or
      coalesce(p_observation#>>'{failure,paymentMethodId}','')!~'^pm_[A-Za-z0-9]+$' or
      coalesce(p_observation#>>'{failure,code}','')!~'^[a-z0-9_]{1,100}$' or
      p_observation#>>'{failure,chargeId}' is distinct from p_observation->>'chargeId' or
      (p_observation->>'paymentMethodId' is not null and p_observation->>'paymentMethodId' is distinct from p_observation#>>'{failure,paymentMethodId}') or
      (op.basis->>'kind'='after_authentication' and p_observation#>>'{failure,paymentMethodId}' is distinct from op.basis->>'paymentMethodId') or
      (op.basis->>'kind' in ('replacement','card_replacement') and p_observation#>>'{failure,chargeId}'=op.basis#>>'{failure,chargeId}'))) or
    (op.basis->>'kind' in ('card','card_replacement') and status not in ('canceled','requires_payment_method') and
      p_observation->>'paymentMethodId' is distinct from op.basis#>>'{method,paymentMethodId}') or
    (op.basis->>'kind' in ('card','card_replacement') and p_observation ? 'failure' and
      p_observation#>>'{failure,paymentMethodId}' is distinct from op.basis#>>'{method,paymentMethodId}') or
    (prior ? 'failure' and status<>'canceled' and (prior-'observedAt') is distinct from (p_observation-'observedAt')) or
    (prior is not null and (p_observation->>'observedAt')::bigint<(prior->>'observedAt')::bigint) or
    (prior->>'status' in ('succeeded','canceled') and (prior-'observedAt') is distinct from (p_observation-'observedAt')) then
    raise exception 'Original confirmation observation differs'; end if;
  insert into public.server_payment_confirmation_observations_v1(operation_id,observation) values(op.operation_id,p_observation) on conflict do nothing;
  -- A recorded outcome ends this lease, but the original operation/key remain.
  -- requires_payment_method without proved failure may be an unknown reply; only same-key retry
  -- is possible, and it retains the original lease wait to avoid a hot loop.
  update public.server_payment_confirmations_v1 set latest_observation=p_observation,
    lease_until=case when status='requires_payment_method' and not (p_observation ? 'failure') then lease_until else least(lease_until,clock_timestamp()) end,
    dispatch_before=case when status='requires_payment_method' and not (p_observation ? 'failure') then dispatch_before else least(dispatch_before,clock_timestamp()) end
    where operation_id=op.operation_id;
  return p_observation;
end $$;

commit;
