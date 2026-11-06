begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_activation_operations_v1 (
  reservation_id uuid primary key references public.buyer_mentorship_first_receipts_v1(reservation_id),
  item_id text not null check(item_id ~ '^si_[A-Za-z0-9]+$'),
  request jsonb not null check(jsonb_typeof(request)='object'),
  idempotency_key text not null unique default ('cn-buyer-activate-v1:'||gen_random_uuid()::text),
  first_dispatch_at timestamptz not null default clock_timestamp(),
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default clock_timestamp()+interval '75 seconds',
  completed_at timestamptz,
  provider_request_id text check(provider_request_id ~ '^req_[A-Za-z0-9]+$'),
  check((completed_at is null)=(provider_request_id is null))
);
alter table public.buyer_mentorship_activation_operations_v1 enable row level security;
revoke all on public.buyer_mentorship_activation_operations_v1 from public,anon,authenticated,service_role;
grant select,insert,update on public.buyer_mentorship_activation_operations_v1 to service_role;
create function public.guard_buyer_mentorship_activation_operation_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.reservation_id is distinct from old.reservation_id or new.item_id is distinct from old.item_id or
    new.request is distinct from old.request or new.idempotency_key is distinct from old.idempotency_key or
    new.first_dispatch_at is distinct from old.first_dispatch_at or
    (old.completed_at is not null and new is distinct from old) then raise exception 'Original buyer activation is immutable'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_activation_operation_v1 before update on public.buyer_mentorship_activation_operations_v1
  for each row execute function public.guard_buyer_mentorship_activation_operation_v1();
revoke all on function public.guard_buyer_mentorship_activation_operation_v1() from public,anon,authenticated;

create function public.claim_buyer_mentorship_activation_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_item_id text,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  b public.buyer_mentorship_billing_state_v1%rowtype; a public.buyer_mentorship_activation_operations_v1%rowtype;
  expected jsonb; renewal bigint; ending bigint; anchor bigint;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer activation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  if not found then raise exception 'Buyer activation requires captured receipt'; end if;
  perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id,73591));
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  if b.reservation_id is null or b.paid_count<>1 or b.financial_hold_at is not null or b.debit_revoked_at is not null or
    (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb then
    raise exception 'Buyer activation financial state requires review'; end if;
  if coalesce(p_item_id,'') !~ '^si_[A-Za-z0-9]+$' then raise exception 'Buyer activation item differs'; end if;
  renewal:=public.fixed_service_end_v1(b.first_paid_at,1);
  ending:=public.fixed_service_end_v1(renewal,(r.terms->>'paymentCount')::integer-1);
  expected:=jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/subscriptions/'||(f.proof->>'subscriptionId'),
    'params',jsonb_build_object('trial_end',renewal,'cancel_at',ending,'proration_behavior','none',
      'default_payment_method',f.proof->>'paymentMethodId','pause_collection',jsonb_build_object('behavior','keep_as_draft'),
      'payment_settings',jsonb_build_object('payment_method_types',jsonb_build_array('card'),'save_default_payment_method','off'),
      'metadata',jsonb_build_object('installment_activation_version','buyer-first-paid-v1')));
  if p_request is distinct from expected then raise exception 'Buyer activation request differs from captured terms'; end if;
  select * into a from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id;
  if found then
    if a.item_id<>p_item_id or a.request is distinct from expected then raise exception 'Original buyer activation differs'; end if;
    if a.completed_at is not null then return jsonb_build_object('status','complete','operation',to_jsonb(a)); end if;
  end if;
  select anchor_seconds into anchor from public.buyer_mentorship_bootstraps_v1 where reservation_id=r.id;
  if anchor is null or clock_timestamp()>=to_timestamp(anchor+48*3600-60) or clock_timestamp()>=to_timestamp(renewal-60) or
    (a.reservation_id is not null and a.first_dispatch_at<=clock_timestamp()-interval '23 hours') then
    return jsonb_build_object('status','review_required'); end if;
  if a.reservation_id is not null and a.lease_until>clock_timestamp() then return jsonb_build_object('status','busy'); end if;
  if a.reservation_id is null then
    insert into public.buyer_mentorship_activation_operations_v1(reservation_id,item_id,request) values(r.id,p_item_id,expected) returning * into a;
  else
    update public.buyer_mentorship_activation_operations_v1 set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '75 seconds'
      where reservation_id=r.id returning * into a;
  end if;
  return jsonb_build_object('status','dispatch','dispatchBefore',clock_timestamp()+interval '30 seconds','operation',to_jsonb(a));
end $$;
revoke all on function public.claim_buyer_mentorship_activation_v1(uuid,uuid,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.claim_buyer_mentorship_activation_v1(uuid,uuid,jsonb,text,jsonb) to service_role;

create function public.complete_buyer_mentorship_activation_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_token uuid,p_subscription jsonb,p_provider_request_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  a public.buyer_mentorship_activation_operations_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype; params jsonb;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer activation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id,73591));
  select * into a from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  params:=a.request->'params';
  if a.reservation_id is null or a.lease_token is distinct from p_token or
    b.financial_hold_at is not null or b.debit_revoked_at is not null or b.paid_count<>1 or
    (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb or
    coalesce(p_provider_request_id,'') !~ '^req_[A-Za-z0-9]+$' or
    p_subscription->>'object' is distinct from 'subscription' or p_subscription->>'id' is distinct from f.proof->>'subscriptionId' or
    p_subscription->>'customer' is distinct from f.proof->>'customerId' or p_subscription->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    coalesce(p_subscription->>'status','') not in ('trialing','active') or p_subscription->'cancel_at_period_end' is distinct from 'false'::jsonb or
    p_subscription->>'ended_at' is not null or p_subscription#>'{automatic_tax,enabled}' is distinct from 'false'::jsonb or
    p_subscription->'trial_end' is distinct from params->'trial_end' or p_subscription->'billing_cycle_anchor' is distinct from params->'trial_end' or
    p_subscription->'cancel_at' is distinct from params->'cancel_at' or
    p_subscription->'default_payment_method' is distinct from params->'default_payment_method' or
    p_subscription->'pause_collection' is distinct from params->'pause_collection' or
    p_subscription#>>'{metadata,installment_activation_version}' is distinct from 'buyer-first-paid-v1' or
    p_subscription#>>'{items,data,0,id}' is distinct from a.item_id then raise exception 'Buyer activation completion requires original provider proof'; end if;
  if a.completed_at is null then
    update public.buyer_mentorship_activation_operations_v1 set completed_at=clock_timestamp(),provider_request_id=p_provider_request_id
      where reservation_id=r.id returning * into a;
  end if;
  -- Completion never releases collection_hold_at or the provider hold.
  return jsonb_build_object('status','complete','operation',to_jsonb(a));
end $$;
revoke all on function public.complete_buyer_mentorship_activation_v1(uuid,uuid,jsonb,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_buyer_mentorship_activation_v1(uuid,uuid,jsonb,uuid,jsonb,text) to service_role;
commit;
