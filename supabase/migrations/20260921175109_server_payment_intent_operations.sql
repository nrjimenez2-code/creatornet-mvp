begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.server_payment_stops_v1 (
  attempt_id uuid primary key references public.server_payment_protocols_v1(attempt_id),
  requested_at timestamptz not null default clock_timestamp()
);
create table public.server_payment_intent_operations_v1 (
  attempt_id uuid primary key references public.server_payment_protocols_v1(attempt_id),
  contract jsonb not null,
  request jsonb not null,
  idempotency_key text not null unique default ('cn-server-intent-v1:'||gen_random_uuid()::text),
  first_dispatch_at timestamptz not null default clock_timestamp(),
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default clock_timestamp()+interval '75 seconds',
  payment_intent_id text unique check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  provider_request_id text check(provider_request_id ~ '^req_[A-Za-z0-9]+$'),
  bound_at timestamptz,
  check((payment_intent_id is null and provider_request_id is null and bound_at is null) or
    (payment_intent_id is not null and provider_request_id is not null and bound_at is not null))
);
alter table public.server_payment_stops_v1 enable row level security;
alter table public.server_payment_intent_operations_v1 enable row level security;
revoke all on public.server_payment_stops_v1,public.server_payment_intent_operations_v1 from public,anon,authenticated,service_role;
grant select on public.server_payment_stops_v1,public.server_payment_intent_operations_v1 to service_role;

-- A source read serializes with existing buyer/product checkout coordination.
-- Read recovery deliberately survives a stop, receipt or expired dispatch.
create function public.read_server_payment_source_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_for_dispatch boolean)
returns public.server_payment_protocols_v1 language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; a public.product_checkout_attempts%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_for_dispatch is null then raise exception 'Fresh server payment source required'; end if;
  select * into s from public.server_payment_protocols_v1 where attempt_id=p_attempt_id and buyer_id=p_buyer_id and context=p_context;
  if not found then raise exception 'Owned server payment source unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.buyer_id::text||':'||s.product_id::text,72913));
  if p_for_dispatch then
    select * into a from public.product_checkout_attempts where id=s.attempt_id and buyer_id=s.buyer_id and product_id=s.product_id;
    if not found or a.status<>'creating' or a.stripe_checkout_session_id is not null or a.original_request is not null or
      exists(select 1 from public.server_payment_stops_v1 where attempt_id=s.attempt_id) or
      exists(select 1 from public.purchases where buyer_id=s.buyer_id and (product_id=s.product_id or (a.post_id is not null and post_id=a.post_id))) or
      not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
      raise exception 'Server payment dispatch is stopped or accounted'; end if;
    if s.kind='first_installment' and (not exists(select 1 from public.buyer_mentorship_installment_reservations_v1
        where id=s.reservation_id and attempt_id=s.attempt_id and released_at is null and status='reserved') or
      exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=s.reservation_id) or
      exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=s.reservation_id) or
      exists(select 1 from public.buyer_mentorship_abandonment_holds_v1 where reservation_id=s.reservation_id)) then
      raise exception 'Original installment no longer authorizes a first payment'; end if;
  end if;
  return s;
end $$;
revoke all on function public.read_server_payment_source_v1(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.read_server_payment_source_v1(uuid,uuid,jsonb,boolean) to service_role;

create function public.request_server_payment_stop_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; h public.server_payment_stops_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  insert into public.server_payment_stops_v1(attempt_id) values(s.attempt_id) on conflict do nothing;
  select * into h from public.server_payment_stops_v1 where attempt_id=s.attempt_id;
  return jsonb_build_object('attemptId',s.attempt_id,'requestedAt',h.requested_at,'releaseAllowed',false);
end $$;
revoke all on function public.request_server_payment_stop_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.request_server_payment_stop_v1(uuid,uuid,jsonb) to service_role;

-- Freeze/validate original economics against the existing acceptance and order
-- or installment terms. This repeats integrity checks, not ledger accounting.
create function public.validate_server_payment_contract_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_contract jsonb,p_request jsonb)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; a public.product_checkout_attempts%rowtype;
  r public.buyer_mentorship_installment_reservations_v1%rowtype; o public.orders%rowtype;
  consent public.product_purchase_consents_v1%rowtype; b public.buyer_mentorship_bootstraps_v1%rowtype;
  sub public.buyer_mentorship_bootstrap_operations_v1%rowtype; hold public.buyer_mentorship_bootstrap_operations_v1%rowtype;
  amount bigint; platform bigint; processing bigint; fee bigint; schedule jsonb; metadata jsonb; params jsonb;
  accepted bigint; expiry bigint; customer text; destination text;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,true);
  select * into a from public.product_checkout_attempts where id=s.attempt_id;
  if jsonb_typeof(p_contract) is distinct from 'object' or p_contract-array['protocol','attemptId','buyerId','creatorId','productId','termsFingerprint',
    'context','customerId','destinationId','amountCents','processingFees','kind','sourceMetadata','acceptedAt','expiresAt']<>'{}'::jsonb or
    p_contract->>'protocol' is distinct from s.protocol or p_contract->>'attemptId' is distinct from s.attempt_id::text or
    p_contract->>'buyerId' is distinct from s.buyer_id::text or p_contract->>'creatorId' is distinct from a.creator_id::text or
    p_contract->>'productId' is distinct from s.product_id::text or p_contract->>'termsFingerprint' is distinct from a.terms_fingerprint or
    p_contract->'context' is distinct from p_context or p_contract->>'kind' is distinct from s.kind then
    raise exception 'Server payment contract identity differs'; end if;
  schedule:=p_contract->'processingFees';metadata:=p_contract->'sourceMetadata';
  if jsonb_typeof(schedule) is distinct from 'object' or schedule-array['enabled','basisPoints','fixedCents','version']<>'{}'::jsonb or
    jsonb_typeof(schedule->'enabled') is distinct from 'boolean' or coalesce(schedule->>'basisPoints','')!~'^[0-9]{1,5}$' or
    (schedule->>'basisPoints')::bigint>10000 or coalesce(schedule->>'fixedCents','')!~'^[0-9]{1,8}$' or
    length(coalesce(schedule->>'version','')) not between 1 and 200 or jsonb_typeof(metadata) is distinct from 'object' or
    (select count(*) from jsonb_object_keys(metadata))>45 or exists(select 1 from jsonb_each(metadata) e where
      length(e.key) not between 1 and 40 or jsonb_typeof(e.value)<>'string' or length(e.value#>>'{}')>500 or e.key like 'server_payment_%') then
    raise exception 'Server payment fee or metadata shape differs'; end if;
  if s.kind='full' then
    select * into consent from public.product_purchase_consents_v1 where id=a.purchase_consent_id;
    select * into o from public.orders where id=a.order_id;
    if consent.id is null or o.id is null or o.status<>'created' or o.buyer_id is distinct from a.buyer_id or o.creator_id is distinct from a.creator_id or
      o.post_id is distinct from a.post_id or o.currency is distinct from 'usd' or
      consent.terms->>'amountCents' is distinct from o.amount_cents::text or consent.terms->>'kind' is distinct from 'one_time' or
      consent.terms->>'buyerId' is distinct from a.buyer_id::text or consent.terms->>'creatorId' is distinct from a.creator_id::text or
      consent.terms->>'productId' is distinct from a.product_id::text or consent.terms->>'postId' is distinct from a.post_id::text then
      raise exception 'Original accepted full-payment order differs'; end if;
    amount:=o.amount_cents;accepted:=floor(extract(epoch from consent.accepted_at));expiry:=floor(extract(epoch from s.created_at))+86400;
    customer:=null;select stripe_account_id into destination from public.profiles where id=a.creator_id and stripe_onboarding_complete;
    if metadata->>'order_id' is distinct from a.order_id::text or metadata->>'checkout_attempt_key' is distinct from a.attempt_key::text or
      metadata->>'checkout_terms_fingerprint' is distinct from a.terms_fingerprint then raise exception 'Original full-payment metadata differs'; end if;
  else
    select * into r from public.buyer_mentorship_installment_reservations_v1 where id=s.reservation_id;
    select * into b from public.buyer_mentorship_bootstraps_v1 where reservation_id=r.id;
    select * into sub from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='subscription.create';
    select * into hold from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='subscription.hold';
    if b.reservation_id is null or sub.bound_at is null or hold.bound_at is null or sub.lease_until is not null or hold.lease_until is not null or
      sub.result_id is distinct from hold.result_id or b.customer_id is distinct from sub.request#>>'{params,customer}' or
      exists(select 1 from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='checkout.create') or
      schedule is distinct from r.terms->'firstPaymentFeeSchedule' then raise exception 'Original held installment preparation differs'; end if;
    amount:=(r.terms#>>'{payments,0,amountCents}')::bigint;accepted:=floor(extract(epoch from r.accepted_at));expiry:=b.anchor_seconds+86400-1860;
    customer:=b.customer_id;destination:=r.destination_id;
    if metadata->>'creatornet_installment_reservation_id' is distinct from r.id::text or
      metadata->>'creatornet_installment_request_id' is distinct from r.request_id::text or
      metadata->>'terms_fingerprint' is distinct from r.fingerprint or metadata->>'installment_subscription_id' is distinct from sub.result_id or
      metadata->>'installment_number' is distinct from '1' or metadata->>'plan_type' is distinct from 'installment' then
      raise exception 'Original installment payment metadata differs'; end if;
  end if;
  if amount is null or amount not between 50 and 99999999 or destination is null or destination!~'^acct_[A-Za-z0-9]+$' or
    p_contract->'amountCents' is distinct from to_jsonb(amount) or p_contract->'acceptedAt' is distinct from to_jsonb(accepted) or
    p_contract->'expiresAt' is distinct from to_jsonb(expiry) or expiry<=floor(extract(epoch from clock_timestamp())) or
    p_contract->'customerId' is distinct from coalesce(to_jsonb(customer),'null'::jsonb) or p_contract->>'destinationId' is distinct from destination or
    metadata->>'buyer_id' is distinct from a.buyer_id::text or metadata->>'creator_id' is distinct from a.creator_id::text or
    metadata->>'product_id' is distinct from a.product_id::text then raise exception 'Original server payment amounts or identities differ'; end if;
  platform:=round(amount::numeric*1200/10000)::bigint;
  processing:=case when (schedule->>'enabled')::boolean then round(amount::numeric*(schedule->>'basisPoints')::bigint/10000)::bigint+(schedule->>'fixedCents')::bigint else 0 end;
  fee:=platform+processing;
  if fee>amount or metadata->>'fee_gross_cents' is distinct from amount::text or metadata->>'platform_fee_cents' is distinct from platform::text or
    metadata->>'processing_fee_cents' is distinct from processing::text or metadata->>'total_creator_deduction_cents' is distinct from fee::text or
    metadata->>'creator_net_cents' is distinct from (amount-fee)::text or metadata->>'processing_fee_enabled' is distinct from schedule->>'enabled' or
    metadata->>'processing_fee_bps' is distinct from (case when (schedule->>'enabled')::boolean then schedule->>'basisPoints' else '0' end) or
    metadata->>'processing_fee_fixed_cents' is distinct from (case when (schedule->>'enabled')::boolean then schedule->>'fixedCents' else '0' end) or
    metadata->>'fee_schedule_version' is distinct from schedule->>'version' then raise exception 'Original server payment fees differ'; end if;
  if s.kind='full' and (o.gross_amount is distinct from amount or o.platform_fee is distinct from platform or o.processing_fee is distinct from processing or
    o.total_creator_deduction is distinct from fee or o.creator_amount is distinct from amount-fee or o.fee_schedule_version is distinct from schedule->>'version') then
    raise exception 'Original full-payment fee snapshot differs'; end if;
  params:=jsonb_build_object('amount',amount,'currency','usd','confirm',false,'confirmation_method','manual','capture_method','automatic_async',
    'automatic_payment_methods',jsonb_build_object('enabled',false),'application_fee_amount',fee,'transfer_data',jsonb_build_object('destination',destination),
    'metadata',metadata||jsonb_build_object('server_payment_protocol',s.protocol,'server_payment_attempt_id',s.attempt_id,'server_payment_terms',a.terms_fingerprint));
  if customer is not null then params:=params||jsonb_build_object('customer',customer); end if;
  if s.kind='first_installment' then params:=params||jsonb_build_object('setup_future_usage','off_session'); end if;
  if p_request is distinct from jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/payment_intents','params',params) then
    raise exception 'Only the original unconfirmed manual intent is authorized'; end if;
end $$;
revoke all on function public.validate_server_payment_contract_v1(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.validate_server_payment_contract_v1(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

create function public.claim_server_payment_intent_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_contract jsonb,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; op public.server_payment_intent_operations_v1%rowtype; now_at timestamptz:=clock_timestamp();
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into op from public.server_payment_intent_operations_v1 where attempt_id=s.attempt_id;
  if found then
    if op.contract is distinct from p_contract or op.request is distinct from p_request then raise exception 'Original manual intent request changed'; end if;
    if op.bound_at is not null then return jsonb_build_object('status','bound','operation',to_jsonb(op)); end if;
    if op.first_dispatch_at<=now_at-interval '23 hours' or (op.contract->>'expiresAt')::bigint<=floor(extract(epoch from now_at)) then
      return jsonb_build_object('status','reconciliation_required','operation',to_jsonb(op)); end if;
    if op.lease_until>now_at then return jsonb_build_object('status','busy','operation',to_jsonb(op)); end if;
  end if;
  perform public.validate_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context,p_contract,p_request);
  if op.attempt_id is null then
    insert into public.server_payment_intent_operations_v1(attempt_id,contract,request) values(s.attempt_id,p_contract,p_request) returning * into op;
  else
    update public.server_payment_intent_operations_v1 set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '75 seconds'
      where attempt_id=s.attempt_id returning * into op;
  end if;
  return jsonb_build_object('status','dispatch','operation',to_jsonb(op),'dispatchBefore',
    floor(extract(epoch from least(clock_timestamp()+interval '30 seconds',op.first_dispatch_at+interval '23 hours',to_timestamp((op.contract->>'expiresAt')::bigint))))::bigint);
end $$;
revoke all on function public.claim_server_payment_intent_v1(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.claim_server_payment_intent_v1(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

create function public.read_server_payment_intent_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; op public.server_payment_intent_operations_v1%rowtype;
begin
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into op from public.server_payment_intent_operations_v1 where attempt_id=s.attempt_id;
  if not found then return null; end if;
  return to_jsonb(op);
end $$;
revoke all on function public.read_server_payment_intent_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_server_payment_intent_v1(uuid,uuid,jsonb) to service_role;

create function public.assert_server_payment_intent_dispatch_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.server_payment_intent_operations_v1%rowtype;
begin
  perform public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,true);
  select * into op from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id;
  if not found or op.bound_at is not null or op.lease_token is distinct from p_lease_token or op.lease_until<=clock_timestamp() or
    op.first_dispatch_at<=clock_timestamp()-interval '23 hours' then raise exception 'Original manual intent dispatch no longer admitted'; end if;
  perform public.validate_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context,op.contract,op.request);
  return to_jsonb(op);
end $$;
revoke all on function public.assert_server_payment_intent_dispatch_v1(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.assert_server_payment_intent_dispatch_v1(uuid,uuid,jsonb,uuid) to service_role;

create function public.bind_server_payment_intent_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_lease_token uuid,p_object jsonb,p_provider_request_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.server_payment_intent_operations_v1%rowtype; params jsonb;
begin
  perform public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  select * into op from public.server_payment_intent_operations_v1 where attempt_id=p_attempt_id;
  if not found or p_lease_token is null or op.lease_token is distinct from p_lease_token then raise exception 'Original manual intent binding differs'; end if;
  params:=op.request->'params';
  if p_object->>'object' is distinct from 'payment_intent' or coalesce(p_object->>'id','')!~'^pi_[A-Za-z0-9]+$' or
    p_object->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or p_object->>'customer' is distinct from params->>'customer' or
    p_object->'amount' is distinct from params->'amount' or p_object->>'currency' is distinct from 'usd' or
    p_object->>'confirmation_method' is distinct from 'manual' or p_object->>'capture_method' is distinct from 'automatic_async' or
    p_object->'metadata' is distinct from params->'metadata' or p_object->'application_fee_amount' is distinct from params->'application_fee_amount' or
    p_object->'transfer_data' is distinct from params->'transfer_data' or p_object->>'setup_future_usage' is distinct from params->>'setup_future_usage' or
    p_object->'payment_method_types' is distinct from '["card"]'::jsonb or p_object#>'{automatic_payment_methods,enabled}'='true'::jsonb or
    coalesce(p_object->>'status','') not in ('requires_payment_method','canceled') or p_object->'amount_received' is distinct from '0'::jsonb or
    p_object->'amount_capturable' is distinct from '0'::jsonb or p_object->>'payment_method' is not null or p_object->>'latest_charge' is not null or
    p_object->>'last_payment_error' is not null or
    p_object->>'on_behalf_of' is not null or p_object->>'shipping' is not null or p_object->>'transfer_group' is not null or
    coalesce(p_object->>'created','')!~'^[0-9]{1,12}$' or
    (p_object->>'created')::bigint<floor(extract(epoch from op.first_dispatch_at))-5 or
    (p_object->>'created')::bigint>floor(extract(epoch from clock_timestamp())) or
    (p_object->>'created')::bigint>=(op.contract->>'expiresAt')::bigint or
    coalesce(p_provider_request_id,'')!~'^req_[A-Za-z0-9]+$' then raise exception 'Original unconfirmed provider evidence differs'; end if;
  if op.bound_at is not null then
    if op.payment_intent_id is distinct from p_object->>'id' then raise exception 'Original manual intent cannot be replaced'; end if;
    return to_jsonb(op);
  end if;
  update public.server_payment_intent_operations_v1 set payment_intent_id=p_object->>'id',provider_request_id=p_provider_request_id,bound_at=clock_timestamp()
    where attempt_id=p_attempt_id returning * into op;
  return to_jsonb(op);
end $$;
revoke all on function public.bind_server_payment_intent_v1(uuid,uuid,jsonb,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.bind_server_payment_intent_v1(uuid,uuid,jsonb,uuid,jsonb,text) to service_role;
commit;
