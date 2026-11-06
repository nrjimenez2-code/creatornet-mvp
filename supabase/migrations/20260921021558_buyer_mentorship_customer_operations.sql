-- Unapplied buyer-owned customer operation. No Checkout, charge or entitlement.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_customer_operations_v1 (
  reservation_id uuid primary key references public.buyer_mentorship_installment_reservations_v1(id),
  request jsonb not null,
  api_version text not null default '2025-10-29.clover' check(api_version='2025-10-29.clover'),
  idempotency_key text not null unique default ('cn-buyer-customer-v1:'||gen_random_uuid()::text),
  first_dispatch_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  customer_id text unique check(customer_id ~ '^cus_[A-Za-z0-9]+$'),
  provider_request_id text check(provider_request_id ~ '^req_[A-Za-z0-9]+$'),
  bound_at timestamptz,
  check((customer_id is null and bound_at is null and provider_request_id is null) or
    (customer_id is not null and bound_at is not null and provider_request_id is not null and first_dispatch_at is not null))
);
alter table public.buyer_mentorship_customer_operations_v1 enable row level security;
revoke all on public.buyer_mentorship_customer_operations_v1 from public,anon,authenticated,service_role;
grant select,insert,update on public.buyer_mentorship_customer_operations_v1 to service_role;

create function public.guard_buyer_mentorship_customer_operation_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.reservation_id is distinct from old.reservation_id or new.request is distinct from old.request or
    new.idempotency_key is distinct from old.idempotency_key or new.api_version is distinct from old.api_version or
    (old.first_dispatch_at is not null and new.first_dispatch_at is distinct from old.first_dispatch_at) or
    (old.customer_id is not null and (new.customer_id is distinct from old.customer_id or
      new.provider_request_id is distinct from old.provider_request_id or new.bound_at is distinct from old.bound_at)) then
    raise exception 'Original customer operation is immutable'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_customer_operation_v1 before update on public.buyer_mentorship_customer_operations_v1
  for each row execute function public.guard_buyer_mentorship_customer_operation_v1();
revoke all on function public.guard_buyer_mentorship_customer_operation_v1() from public,anon,authenticated;

create function public.claim_buyer_mentorship_customer_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  o public.buyer_mentorship_customer_operations_v1%rowtype;
  params jsonb; v_now timestamptz:=clock_timestamp();
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned customer reservation unavailable'; end if;
  -- Same buyer/product lock as reservation and full-checkout coordination.
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  perform 1 from public.buyer_mentorship_installment_reservations_v1 where id=r.id and status='reserved' and context=p_context;
  if not found then raise exception 'Customer reservation changed'; end if;
  params:=jsonb_build_object('metadata',jsonb_build_object(
    'creatornet_installment_version','buyer-mentorship-installments-v1',
    'creatornet_installment_reservation_id',r.id::text,'creatornet_installment_request_id',r.request_id::text,
    'buyer_id',r.buyer_id::text,'creator_id',r.creator_id::text,'product_id',r.product_id::text,'post_id',r.post_id::text,
    'terms_fingerprint',r.fingerprint,'operation_kind','customer.create',
    'payment_mode',r.context->>'mode','platform_account_id',r.context->>'platformAccountId',
    'supabase_project_ref',r.context->>'supabaseProjectRef','site_origin',r.context->>'siteOrigin'));
  insert into public.buyer_mentorship_customer_operations_v1(reservation_id,request) values(r.id,params)
    on conflict(reservation_id) do nothing;
  select * into o from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id for update;
  if o.request is distinct from params then raise exception 'Customer request differs from accepted reservation'; end if;
  if o.customer_id is not null then return jsonb_build_object('status','bound','operation',to_jsonb(o)); end if;
  if o.lease_until>v_now then return jsonb_build_object('status','busy','operation',to_jsonb(o)); end if;
  -- Stripe may prune a key after 24h. Stop automatic replay conservatively at 23h.
  if o.first_dispatch_at<=v_now-interval '23 hours' then
    return jsonb_build_object('status','review_required','operation',to_jsonb(o)); end if;
  update public.buyer_mentorship_customer_operations_v1 set first_dispatch_at=coalesce(first_dispatch_at,v_now),
    lease_token=gen_random_uuid(),lease_until=v_now+interval '75 seconds' where reservation_id=r.id returning * into o;
  return jsonb_build_object('status','dispatch','dispatch_before',least(v_now+interval '30 seconds',o.first_dispatch_at+interval '23 hours'),
    'operation',to_jsonb(o));
end $$;

create function public.bind_buyer_mentorship_customer_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,
  p_token uuid,p_customer jsonb,p_provider_request_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  o public.buyer_mentorship_customer_operations_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and
    buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned customer reservation unavailable'; end if;
  -- Same buyer/product lock as reservation and full-checkout coordination.
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  perform 1 from public.buyer_mentorship_installment_reservations_v1 where id=r.id and status='reserved' and context=p_context;
  if not found then raise exception 'Customer reservation changed'; end if;
  select * into o from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id for update;
  if not found or o.first_dispatch_at is null or p_token is null or o.lease_token is distinct from p_token or
    p_customer->>'object' is distinct from 'customer' or coalesce(p_customer->>'id','') !~ '^cus_[A-Za-z0-9]+$' or
    p_customer->'livemode' is distinct from to_jsonb(r.context->>'mode'='live') or
    p_customer->'metadata' is distinct from o.request->'metadata' or p_customer->>'test_clock' is not null or
    p_customer->'deleted'='true'::jsonb or coalesce(p_customer->>'created','') !~ '^[0-9]+$' or
    (p_customer->>'created')::numeric<extract(epoch from o.first_dispatch_at)-5 or
    (p_customer->>'created')::numeric>extract(epoch from clock_timestamp())+5 or
    coalesce(p_provider_request_id,'') !~ '^req_[A-Za-z0-9]+$' then raise exception 'Customer binding requires original provider proof'; end if;
  if o.customer_id is not null then
    if o.customer_id is distinct from p_customer->>'id' then raise exception 'Customer already bound to a different object'; end if;
    return to_jsonb(o);
  end if;
  update public.buyer_mentorship_customer_operations_v1 set customer_id=p_customer->>'id',
    provider_request_id=p_provider_request_id,bound_at=clock_timestamp(),lease_until=null where reservation_id=r.id returning * into o;
  return to_jsonb(o);
end $$;
revoke all on function public.claim_buyer_mentorship_customer_v1(uuid,uuid,jsonb),
  public.bind_buyer_mentorship_customer_v1(uuid,uuid,jsonb,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.claim_buyer_mentorship_customer_v1(uuid,uuid,jsonb),
  public.bind_buyer_mentorship_customer_v1(uuid,uuid,jsonb,uuid,jsonb,text) to service_role;
commit;
