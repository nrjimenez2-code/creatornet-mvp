begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.product_checkout_stop_operations_v1 (
 attempt_id uuid primary key references public.product_checkout_attempts(id),
 buyer_id uuid not null,
 attempt_key uuid not null,
 context jsonb not null,
 request jsonb not null,
 idempotency_key text not null unique,
 started_at timestamptz not null default clock_timestamp(),
 lease_token uuid not null,
 lease_until timestamptz not null
);
alter table public.product_checkout_stop_operations_v1 enable row level security;
revoke all on public.product_checkout_stop_operations_v1 from public,anon,authenticated,service_role;
grant select,insert,update on public.product_checkout_stop_operations_v1 to service_role;

create function public.guard_product_checkout_stop_operation_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.product_checkout_attempts%rowtype;
begin
 if tg_op='DELETE' then raise exception 'Original stop operation cannot be deleted'; end if;
 if tg_op='UPDATE' then
  if (to_jsonb(new)-'lease_token'-'lease_until') is distinct from (to_jsonb(old)-'lease_token'-'lease_until') then
   raise exception 'Original stop request is immutable'; end if;
  return new;
 end if;
 select * into a from public.product_checkout_attempts where id=new.attempt_id and buyer_id=new.buyer_id and attempt_key=new.attempt_key for update;
 if not found or a.original_stop_requested_at is null or a.original_request_context is distinct from new.context or
  a.stripe_checkout_session_id is null or new.idempotency_key is distinct from 'creatornet-product-checkout:'||a.attempt_key||':expire' or
  new.request is distinct from jsonb_build_object('apiVersion','2025-10-29.clover','method','POST',
   'path','/v1/checkout/sessions/'||a.stripe_checkout_session_id||'/expire','params','{}'::jsonb) then
  raise exception 'Original stop operation identity mismatch'; end if;
 return new;
end $$;
create trigger guard_product_checkout_stop_operation_v1 before insert or update or delete on public.product_checkout_stop_operations_v1
 for each row execute function public.guard_product_checkout_stop_operation_v1();

create function public.claim_product_checkout_stop_operation_v1(p_attempt_id uuid,p_buyer_id uuid,p_attempt_key uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.product_checkout_attempts%rowtype; o public.product_checkout_stop_operations_v1%rowtype; now_value timestamptz;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh original stop admission required'; end if;
 select * into a from public.product_checkout_attempts where id=p_attempt_id and buyer_id=p_buyer_id and attempt_key=p_attempt_key for update;
 if not found or a.original_request_protocol is distinct from 'product-checkout-original-v1' or a.original_stop_requested_at is null or
  p_context is null or a.original_request_context is distinct from p_context or a.stripe_checkout_session_id is null then
  raise exception 'Owned original stop unavailable'; end if;
 if a.status is distinct from 'open' then return jsonb_build_object('status','reconciliation_required'); end if;
 select * into o from public.product_checkout_stop_operations_v1 where attempt_id=a.id for update;
 now_value:=clock_timestamp();
 if found then
  if o.context is distinct from p_context or o.buyer_id is distinct from p_buyer_id or o.attempt_key is distinct from p_attempt_key then
   raise exception 'Original stop operation changed'; end if;
  if o.lease_until>now_value then return jsonb_build_object('status','busy'); end if;
  if o.started_at<=now_value-interval '23 hours' then return jsonb_build_object('status','reconciliation_required'); end if;
  update public.product_checkout_stop_operations_v1 set lease_token=gen_random_uuid(),lease_until=now_value+interval '75 seconds'
   where attempt_id=a.id returning * into o;
 else
  insert into public.product_checkout_stop_operations_v1(attempt_id,buyer_id,attempt_key,context,request,idempotency_key,started_at,lease_token,lease_until)
   values(a.id,a.buyer_id,a.attempt_key,p_context,jsonb_build_object('apiVersion','2025-10-29.clover','method','POST',
    'path','/v1/checkout/sessions/'||a.stripe_checkout_session_id||'/expire','params','{}'::jsonb),
    'creatornet-product-checkout:'||a.attempt_key||':expire',now_value,gen_random_uuid(),now_value+interval '75 seconds') returning * into o;
 end if;
 return jsonb_build_object('status','dispatch','operation',to_jsonb(o),'dispatch_before',least(now_value+interval '30 seconds',o.started_at+interval '23 hours'));
end $$;
revoke all on function public.guard_product_checkout_stop_operation_v1(),public.claim_product_checkout_stop_operation_v1(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_product_checkout_stop_operation_v1(uuid,uuid,uuid,jsonb) to service_role;
commit;
