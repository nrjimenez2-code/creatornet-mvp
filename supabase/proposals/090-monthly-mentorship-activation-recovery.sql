-- UNAPPLIED. Locked steps 1/5/8: positive recovery of an ORIGINAL activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regprocedure('public.complete_monthly_initial_abandonment_v1(uuid,uuid,jsonb,jsonb)') is null then
    raise exception 'Activation recovery prerequisites differ'; end if;
end; $preflight$;
create function public.reconcile_monthly_mentorship_activation_v1(p_operation_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype;
  v_id uuid; v_first jsonb; v_params jsonb;
begin
  select agreement_id into v_id from public.monthly_mentorship_operations_v1 where id=p_operation_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Activation recovery owner differs'; end if;
  select * into o from public.monthly_mentorship_operations_v1 where id=p_operation_id for update;
  select provider_proof into v_first from public.monthly_mentorship_receipts_v1 where agreement_id=a.id and month_number=1;
  v_params:=o.request->'params';
  if o.kind<>'activate' or o.scope_key<>'initial' or o.dispatched_at is null or a.anchor_at is null or a.covered_months<1 or
    o.request->>'method' is distinct from 'POST' or o.request->>'path' is distinct from '/v1/subscriptions/'||a.stripe_subscription_id or
    v_first->>'paidAt' is distinct from a.anchor_at::text or v_first->>'paymentMethodId' is distinct from v_params->>'default_payment_method' or
    v_params->>'trial_end' is distinct from public.monthly_mentorship_boundary_v1(a.anchor_at,1)::text or
    p_proof->>'version' is distinct from 'monthly-activation-recovery-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    not coalesce(p_proof->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) or p_proof->>'objectType' is distinct from 'subscription' or
    p_proof->>'objectId' is distinct from a.stripe_subscription_id or p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or not coalesce(p_proof->>'status' in ('trialing','active'),false) or
    p_proof->'metadata' is distinct from v_params->'metadata' or p_proof->>'trialEnd' is distinct from v_params->>'trial_end' or
    p_proof->>'billingCycleAnchor' is distinct from v_params->>'trial_end' or
    p_proof->>'cancelAt' is distinct from nullif(v_params->>'cancel_at','') or
    p_proof->>'paymentMethodId' is distinct from v_first->>'paymentMethodId' or
    p_proof->>'pauseBehavior' is distinct from 'keep_as_draft' or p_proof->'resumesAt' is distinct from 'null'::jsonb then
    raise exception 'Activation recovery lacks original held schedule evidence'; end if;
  if o.status='complete' then
    if o.provider_id is distinct from a.stripe_subscription_id then raise exception 'Activation result changed'; end if;
    return false;
  end if;
  if o.status not in ('dispatched','review_required') then raise exception 'Activation recovery operation state differs'; end if;
  update public.monthly_mentorship_operations_v1 set status='complete',provider_id=a.stripe_subscription_id,
    provider_request_id=p_proof->>'requestId',completed_at=clock_timestamp(),recovery_proof=p_proof,recovered_at=clock_timestamp() where id=o.id;
  -- Keep original dispatch age, operation ID, agreement revision/consent and
  -- every billing/financial stop. This only records an already observed result.
  return true;
end;
$$;
revoke all on function public.reconcile_monthly_mentorship_activation_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_monthly_mentorship_activation_v1(uuid,uuid,jsonb,jsonb) to service_role;
commit;
