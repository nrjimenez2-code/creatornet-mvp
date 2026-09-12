-- UNAPPLIED. Locked steps 1/4/5/8: reconnect positively observed original bootstrap results.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regprocedure('public.read_monthly_mentorship_management_v1(uuid,text,jsonb,timestamptz,uuid,integer)') is null then
    raise exception 'Monthly checkout recovery prerequisites differ'; end if;
end; $preflight$;
alter table public.monthly_mentorship_operations_v1 add column recovery_proof jsonb, add column recovered_at timestamptz;
create function public.reconcile_monthly_mentorship_bootstrap_v1(p_operation_id uuid,p_buyer_id uuid,p_context jsonb,p_request jsonb,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype;
  v_agreement uuid; v_id text; v_type text; v_metadata jsonb; v_customer text; v_product text; v_subscription text;
begin
  select agreement_id into v_agreement from public.monthly_mentorship_operations_v1 where id=p_operation_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_agreement for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context then
    raise exception 'Monthly bootstrap recovery owner differs'; end if;
  select * into o from public.monthly_mentorship_operations_v1 where id=p_operation_id for update;
  if o.scope_key<>'initial' or o.kind not in ('customer','product','subscription','hold','checkout') or o.request is distinct from p_request or
    p_proof->>'version' is distinct from 'monthly-bootstrap-recovery-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    p_proof->>'operationId' is distinct from o.id::text or p_proof->>'kind' is distinct from o.kind or
    not coalesce(p_proof->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) or
    jsonb_typeof(p_proof->'metadata') is distinct from 'object' then raise exception 'Monthly bootstrap recovery proof differs'; end if;
  select provider_id into v_customer from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='customer' and scope_key='initial' and status='complete';
  select provider_id into v_product from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='product' and scope_key='initial' and status='complete';
  select provider_id into v_subscription from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='subscription' and scope_key='initial' and status='complete';
  v_id:=p_proof->>'objectId';
  v_type:=case o.kind when 'customer' then 'customer' when 'product' then 'product' when 'checkout' then 'checkout.session' else 'subscription' end;
  v_metadata:=o.request->'params'->'metadata';
  if o.kind='hold' then
    select request->'params'->'metadata' into v_metadata from public.monthly_mentorship_operations_v1
      where agreement_id=a.id and kind='subscription' and scope_key='initial' and status='complete';
  end if;
  if p_proof->>'objectType' is distinct from v_type or p_proof->'metadata' is distinct from v_metadata or
    p_proof->'metadata'->>'creatornet_membership_id' is distinct from a.id::text or
    p_proof->'metadata'->>'creatornet_membership_fingerprint' is distinct from a.fingerprint or
    not coalesce(v_id ~ (case o.kind when 'customer' then '^cus_' when 'product' then '^prod_' when 'checkout' then '^cs_' else '^sub_' end || '[A-Za-z0-9_]+$'),false) then
    raise exception 'Monthly recovered object identity differs'; end if;
  if o.kind='product' and v_customer is null then raise exception 'Monthly recovery predecessor missing'; end if;
  if o.kind in ('subscription','hold','checkout') and (v_customer is null or v_product is null or
    p_proof->>'customerId' is distinct from v_customer or p_proof->>'productId' is distinct from v_product) then
    raise exception 'Monthly recovery predecessor differs'; end if;
  if o.kind='subscription' and (o.request->'params'->>'customer' is distinct from v_customer or
    o.request->'params'->'items'->0->'price_data'->>'product' is distinct from v_product) then
    raise exception 'Monthly recovered subscription request differs'; end if;
  if o.kind in ('hold','checkout') and (v_subscription is null or p_proof->>'subscriptionId' is distinct from v_subscription) then
    raise exception 'Monthly recovered subscription link differs'; end if;
  if o.kind='hold' and (v_id is distinct from v_subscription or o.request->>'path' is distinct from '/v1/subscriptions/'||v_subscription or
    p_proof->>'held' is distinct from 'true') then raise exception 'Monthly recovered hold differs'; end if;
  if o.kind='checkout' and (o.request->'params'->>'customer' is distinct from v_customer or
    o.request->'params'->'metadata'->>'membership_subscription_id' is distinct from v_subscription or not exists(
      select 1 from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='hold' and scope_key='initial' and status='complete' and provider_id=v_subscription)) then
    raise exception 'Monthly recovered checkout link differs'; end if;
  if o.status='complete' then
    if o.provider_id is distinct from v_id then raise exception 'Monthly recovered result changed'; end if;
    return false;
  end if;
  -- Positive evidence only. Never reset dispatch age, acceptance, revision or
  -- original idempotency identity; this function never permits another debit.
  update public.monthly_mentorship_operations_v1 set status='complete',provider_id=v_id,provider_request_id=p_proof->>'requestId',
    completed_at=clock_timestamp(),recovery_proof=p_proof,recovered_at=clock_timestamp() where id=o.id;
  return true;
end;
$$;
create function public.publish_monthly_mentorship_recovery_v1(p_id uuid,p_buyer_id uuid,p_context jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_customer text; v_subscription text; v_session text;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context then
    raise exception 'Monthly recovery publication owner differs'; end if;
  select provider_id into v_customer from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='customer' and scope_key='initial' and status='complete';
  select provider_id into v_subscription from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='subscription' and scope_key='initial' and status='complete';
  select provider_id into v_session from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='checkout' and scope_key='initial' and status='complete';
  if v_customer is null or v_subscription is null or v_session is null or not exists(select 1 from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind='hold' and scope_key='initial' and status='complete' and provider_id=v_subscription) then
    raise exception 'Monthly recovery publication needs original completed operations'; end if;
  if a.stripe_subscription_id is not null then
    if a.stripe_customer_id is distinct from v_customer or a.stripe_subscription_id is distinct from v_subscription or
      a.stripe_checkout_session_id is distinct from v_session then raise exception 'Monthly recovery publication changed'; end if;
    return false;
  end if;
  if a.covered_months<>0 then raise exception 'Monthly unbound receipt state differs'; end if;
  -- Publication is evidence, not authorization. A stop/refund/review racing
  -- the original provider result must not prevent actual captured-money recovery.
  update public.monthly_mentorship_agreements_v1 set stripe_customer_id=v_customer,stripe_subscription_id=v_subscription,
    stripe_checkout_session_id=v_session,revision=revision+1 where id=a.id;
  update public.purchases set subscription_id=v_subscription,session_id=v_session where id=a.purchase_id;
  return true;
end;
$$;
revoke all on function public.reconcile_monthly_mentorship_bootstrap_v1(uuid,uuid,jsonb,jsonb,jsonb),
  public.publish_monthly_mentorship_recovery_v1(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_monthly_mentorship_bootstrap_v1(uuid,uuid,jsonb,jsonb,jsonb),
  public.publish_monthly_mentorship_recovery_v1(uuid,uuid,jsonb) to service_role;
commit;
