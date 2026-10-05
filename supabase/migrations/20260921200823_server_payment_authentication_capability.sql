begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Internal service-only admission to disclose the original MANUAL challenge.
-- This is neither a confirmation lease nor permission to count money. The
-- subsequent server confirmation must separately recheck any intervening stop.
create function public.assert_server_payment_authentication_v1(
  p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_operation_id uuid,p_observation jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare op public.server_payment_confirmations_v1%rowtype;
  original public.server_payment_intent_operations_v1%rowtype;
begin
  perform public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,true);
  select * into op from public.server_payment_confirmations_v1
    where attempt_id=p_attempt_id order by phase desc limit 1;
  if not found or op.operation_id is distinct from p_operation_id or
    op.latest_observation is distinct from p_observation or
    p_observation->>'status' is distinct from 'requires_action' or
    p_observation->>'paymentIntentId' is distinct from op.payment_intent_id or
    coalesce(p_observation->>'paymentMethodId','')!~'^pm_[A-Za-z0-9]+$' or
    coalesce(p_observation->>'nextActionHash','')!~'^[a-f0-9]{64}$' or
    coalesce(p_observation->>'observedAt','')!~'^[0-9]{1,12}$' or
    (p_observation->>'observedAt')::bigint<floor(extract(epoch from clock_timestamp()))-30 or
    (p_observation->>'observedAt')::bigint>floor(extract(epoch from clock_timestamp())) or
    op.lease_until>clock_timestamp() then
    raise exception 'Current original bank challenge required';
  end if;
  select * into original from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id;
  if not found or original.bound_at is null or original.payment_intent_id is distinct from op.payment_intent_id then
    raise exception 'Original challenge binding differs';
  end if;
  perform public.validate_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context,original.contract,original.request);
  return to_jsonb(op);
end $$;
revoke all on function public.assert_server_payment_authentication_v1(uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.assert_server_payment_authentication_v1(uuid,uuid,jsonb,uuid,jsonb) to service_role;
commit;
