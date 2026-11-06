begin;

-- Buyer-owned bootstrap only. These records confer no receipt, entitlement or
-- publication authority. The server verifies provider state before every bind.
create table public.buyer_mentorship_bootstraps_v1 (
  reservation_id uuid primary key references public.buyer_mentorship_installment_reservations_v1(id),
  customer_id text not null unique check(customer_id ~ '^cus_[A-Za-z0-9]+$'),
  anchor_seconds bigint not null check(anchor_seconds > 0)
);
create table public.buyer_mentorship_bootstrap_operations_v1 (
  reservation_id uuid not null references public.buyer_mentorship_bootstraps_v1(reservation_id),
  step text not null check(step in ('product.create','subscription.create','subscription.hold','checkout.create')),
  request jsonb not null check(jsonb_typeof(request)='object'),
  idempotency_key text not null unique default ('cn-buyer-bootstrap-v1:'||gen_random_uuid()::text),
  first_dispatch_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  result_id text,
  provider_request_id text check(provider_request_id ~ '^req_[A-Za-z0-9]+$'),
  bound_at timestamptz,
  primary key(reservation_id,step),
  unique(step,result_id),
  check((result_id is null and provider_request_id is null and bound_at is null) or
    (result_id is not null and provider_request_id is not null and bound_at is not null and first_dispatch_at is not null))
);
alter table public.buyer_mentorship_bootstraps_v1 enable row level security;
alter table public.buyer_mentorship_bootstrap_operations_v1 enable row level security;
revoke all on public.buyer_mentorship_bootstraps_v1,public.buyer_mentorship_bootstrap_operations_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_bootstraps_v1 to service_role;
grant select,insert,update on public.buyer_mentorship_bootstrap_operations_v1 to service_role;

create function public.guard_buyer_mentorship_bootstrap_operation_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.reservation_id is distinct from old.reservation_id or new.step is distinct from old.step or
    new.request is distinct from old.request or new.idempotency_key is distinct from old.idempotency_key or
    (old.first_dispatch_at is not null and new.first_dispatch_at is distinct from old.first_dispatch_at) or
    (old.result_id is not null and (new.result_id is distinct from old.result_id or
      new.provider_request_id is distinct from old.provider_request_id or new.bound_at is distinct from old.bound_at)) then
    raise exception 'Original bootstrap operation is immutable'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_bootstrap_operation_v1 before update on public.buyer_mentorship_bootstrap_operations_v1
  for each row execute function public.guard_buyer_mentorship_bootstrap_operation_v1();
revoke all on function public.guard_buyer_mentorship_bootstrap_operation_v1() from public,anon,authenticated;

create function public.begin_buyer_mentorship_bootstrap_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  b public.buyer_mentorship_bootstraps_v1%rowtype; v_customer text;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned bootstrap reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  perform 1 from public.buyer_mentorship_installment_reservations_v1 where id=r.id and status='reserved' and context=p_context;
  if not found then raise exception 'Bootstrap reservation changed'; end if;
  select customer_id into v_customer from public.buyer_mentorship_customer_operations_v1
    where reservation_id=r.id and bound_at is not null;
  if v_customer is null then raise exception 'Original customer must be bound first'; end if;
  insert into public.buyer_mentorship_bootstraps_v1 values(r.id,v_customer,floor(extract(epoch from clock_timestamp()))::bigint)
    on conflict(reservation_id) do nothing;
  select * into b from public.buyer_mentorship_bootstraps_v1 where reservation_id=r.id;
  if b.customer_id is distinct from v_customer then raise exception 'Bootstrap customer changed'; end if;
  return to_jsonb(b);
end $$;

create function public.claim_buyer_mentorship_bootstrap_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_step text,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare b jsonb; r public.buyer_mentorship_installment_reservations_v1%rowtype;
  o public.buyer_mentorship_bootstrap_operations_v1%rowtype;
  v_now timestamptz; v_end timestamptz; v_product text; v_subscription text; v_hold text; m jsonb;
begin
  b:=public.begin_buyer_mentorship_bootstrap_v1(p_request_id,p_buyer_id,p_context);
  v_now:=clock_timestamp();
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=(b->>'reservation_id')::uuid;
  select result_id into v_product from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='product.create';
  select result_id into v_subscription from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='subscription.create';
  select result_id into v_hold from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='subscription.hold';
  if p_step is null or p_step not in ('product.create','subscription.create','subscription.hold','checkout.create') or
    p_request->>'apiVersion' is distinct from '2025-10-29.clover' or p_request->>'method' is distinct from 'POST' or
    jsonb_typeof(p_request->'params') is distinct from 'object' or
    p_request - array['apiVersion','method','path','params'] <> '{}'::jsonb then raise exception 'Invalid bootstrap request'; end if;
  m:=jsonb_set((select request->'metadata' from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id),
    '{operation_kind}',to_jsonb(case when p_step='subscription.hold' then 'subscription.create' else p_step end));
  if p_step<>'subscription.hold' and (p_request#>'{params,metadata}') @> m is distinct from true then
    raise exception 'Bootstrap request differs from owned acceptance'; end if;
  if (p_step='product.create' and p_request->>'path' is distinct from '/v1/products') or
    (p_step='subscription.create' and (v_product is null or p_request->>'path' is distinct from '/v1/subscriptions' or
      p_request#>>'{params,customer}' is distinct from b->>'customer_id' or
      p_request#>>'{params,items,0,price_data,product}' is distinct from v_product)) or
    (p_step='subscription.hold' and (v_subscription is null or p_request->>'path' is distinct from '/v1/subscriptions/'||v_subscription or
      p_request->'params' is distinct from '{"pause_collection":{"behavior":"keep_as_draft"}}'::jsonb)) or
    (p_step='checkout.create' and (v_subscription is null or v_hold is distinct from v_subscription or
      p_request->>'path' is distinct from '/v1/checkout/sessions' or p_request#>>'{params,customer}' is distinct from b->>'customer_id' or
      p_request#>>'{params,metadata,installment_subscription_id}' is distinct from v_subscription or
      p_request#>>'{params,expires_at}' is distinct from ((b->>'anchor_seconds')::bigint+86400)::text)) then
    raise exception 'Bootstrap dependencies are not bound'; end if;
  insert into public.buyer_mentorship_bootstrap_operations_v1(reservation_id,step,request) values(r.id,p_step,p_request)
    on conflict(reservation_id,step) do nothing;
  select * into o from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step=p_step for update;
  if o.request is distinct from p_request then raise exception 'Original bootstrap request changed'; end if;
  if o.result_id is not null then return jsonb_build_object('status','bound','operation',to_jsonb(o)); end if;
  if o.lease_until>v_now then return jsonb_build_object('status','busy','operation',to_jsonb(o)); end if;
  v_end:=to_timestamp((b->>'anchor_seconds')::bigint+86400-1860);
  if v_now>=v_end or o.first_dispatch_at<=v_now-interval '23 hours' then
    return jsonb_build_object('status','review_required','operation',to_jsonb(o)); end if;
  update public.buyer_mentorship_bootstrap_operations_v1 set first_dispatch_at=coalesce(first_dispatch_at,v_now),
    lease_token=gen_random_uuid(),lease_until=v_now+interval '75 seconds' where reservation_id=r.id and step=p_step returning * into o;
  return jsonb_build_object('status','dispatch','dispatch_before',least(v_now+interval '30 seconds',v_end,o.first_dispatch_at+interval '23 hours'),
    'operation',to_jsonb(o));
end $$;

create function public.bind_buyer_mentorship_bootstrap_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_step text,
  p_token uuid,p_object jsonb,p_provider_request_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare b jsonb; o public.buyer_mentorship_bootstrap_operations_v1%rowtype; v_kind text; v_prefix text; m jsonb;
begin
  b:=public.begin_buyer_mentorship_bootstrap_v1(p_request_id,p_buyer_id,p_context);
  select * into o from public.buyer_mentorship_bootstrap_operations_v1
    where reservation_id=(b->>'reservation_id')::uuid and step=p_step for update;
  if not found then raise exception 'Original bootstrap operation unavailable'; end if;
  v_kind:=case p_step when 'product.create' then 'product' when 'checkout.create' then 'checkout.session' else 'subscription' end;
  v_prefix:=case p_step when 'product.create' then '^prod_' when 'checkout.create' then '^cs_(test_|live_)?' else '^sub_' end;
  m:=o.request#>'{params,metadata}';
  if p_step='subscription.hold' then
    select request#>'{params,metadata}' into m from public.buyer_mentorship_bootstrap_operations_v1
      where reservation_id=o.reservation_id and step='subscription.create';
  end if;
  if p_token is null or o.lease_token is distinct from p_token or o.first_dispatch_at is null or
    p_object->>'object' is distinct from v_kind or coalesce(p_object->>'id','') !~ (v_prefix||'[A-Za-z0-9]+$') or
    p_object->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or p_object->'metadata' is distinct from m or
    coalesce(p_provider_request_id,'') !~ '^req_[A-Za-z0-9]+$' or
    (p_step='subscription.hold' and (o.request->>'path' is distinct from '/v1/subscriptions/'||(p_object->>'id') or
      p_object#>>'{pause_collection,behavior}' is distinct from 'keep_as_draft' or p_object#>>'{pause_collection,resumes_at}' is not null)) then
    raise exception 'Bootstrap binding requires original provider proof'; end if;
  if o.result_id is not null then
    if o.result_id is distinct from p_object->>'id' then raise exception 'Bootstrap result already bound'; end if;
    return to_jsonb(o);
  end if;
  update public.buyer_mentorship_bootstrap_operations_v1 set result_id=p_object->>'id',provider_request_id=p_provider_request_id,
    bound_at=clock_timestamp(),lease_until=null where reservation_id=o.reservation_id and step=p_step returning * into o;
  return to_jsonb(o);
end $$;
revoke all on function public.begin_buyer_mentorship_bootstrap_v1(uuid,uuid,jsonb),
  public.claim_buyer_mentorship_bootstrap_v1(uuid,uuid,jsonb,text,jsonb),
  public.bind_buyer_mentorship_bootstrap_v1(uuid,uuid,jsonb,text,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.begin_buyer_mentorship_bootstrap_v1(uuid,uuid,jsonb),
  public.claim_buyer_mentorship_bootstrap_v1(uuid,uuid,jsonb,text,jsonb),
  public.bind_buyer_mentorship_bootstrap_v1(uuid,uuid,jsonb,text,uuid,jsonb,text) to service_role;
commit;
