begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- A bound original subscription with no Checkout admission. Unknown creates
-- remain locked. An unresolved pause operation may be retained after its
-- dispatch lease ends: it can only pause this same subscription, never charge
-- or resurrect the independently observed canceled original.
create function public.buyer_mentorship_partial_subscription_v1(p_reservation_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare c public.buyer_mentorship_customer_operations_v1%rowtype;
  b public.buyer_mentorship_bootstraps_v1%rowtype;
  p public.buyer_mentorship_bootstrap_operations_v1%rowtype;
  sub public.buyer_mentorship_bootstrap_operations_v1%rowtype;
  h public.buyer_mentorship_bootstrap_operations_v1%rowtype;
begin
  if exists(select 1 from public.buyer_mentorship_bootstrap_operations_v1
    where reservation_id=p_reservation_id and step='checkout.create') or
    exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=p_reservation_id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=p_reservation_id) then return null; end if;
  select * into c from public.buyer_mentorship_customer_operations_v1 where reservation_id=p_reservation_id;
  select * into b from public.buyer_mentorship_bootstraps_v1 where reservation_id=p_reservation_id;
  select * into p from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=p_reservation_id and step='product.create';
  select * into sub from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=p_reservation_id and step='subscription.create';
  if c.bound_at is null or c.customer_id is null or c.provider_request_id is null or c.lease_until is not null or
    b.customer_id is distinct from c.customer_id or b.reservation_id is null or
    p.bound_at is null or p.result_id is null or p.provider_request_id is null or p.lease_until is not null or
    sub.bound_at is null or sub.result_id is null or sub.provider_request_id is null or sub.lease_until is not null then return null; end if;
  select * into h from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=p_reservation_id and step='subscription.hold';
  if found and (h.lease_until>clock_timestamp() or h.request is distinct from jsonb_build_object(
    'apiVersion','2025-10-29.clover','method','POST','path','/v1/subscriptions/'||sub.result_id,
    'params',jsonb_build_object('pause_collection',jsonb_build_object('behavior','keep_as_draft'))) or
    h.result_id is not null and h.result_id is distinct from sub.result_id) then return null; end if;
  return jsonb_build_object('reservationId',p_reservation_id,'customer',to_jsonb(c),'bootstrap',to_jsonb(b),
    'product',to_jsonb(p),'subscription',to_jsonb(sub),'hold',case when h.reservation_id is null then null else to_jsonb(h) end);
end $$;
revoke all on function public.buyer_mentorship_partial_subscription_v1(uuid) from public,anon,authenticated;
grant execute on function public.buyer_mentorship_partial_subscription_v1(uuid) to service_role;

create function public.read_buyer_mentorship_partial_stop_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh partial stop context required'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned partial stop unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  return public.buyer_mentorship_partial_subscription_v1(r.id);
end $$;
revoke all on function public.read_buyer_mentorship_partial_stop_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_partial_stop_v1(uuid,uuid,jsonb) to service_role;
create or replace function public.guard_buyer_mentorship_abandonment_hold_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=new.reservation_id;
  if not found or r.status<>'reserved' then raise exception 'Owned unpaid reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  if exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id) then
    raise exception 'Captured purchase requires payment reconciliation'; end if;
  if not exists(select 1 from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id) and
    not exists(select 1 from public.buyer_mentorship_bootstraps_v1 where reservation_id=r.id) and
    not exists(select 1 from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id) then return new; end if;
  if public.buyer_mentorship_nonpayable_preparation_v1(r.id) is not null or
    public.buyer_mentorship_partial_subscription_v1(r.id) is not null then return new; end if;
  if not exists(select 1 from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id and bound_at is not null) or
    (select count(*) from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and bound_at is not null)<>4 then
    raise exception 'Original preparation must be reconciled before stopping'; end if;
  return new;
end $$;
create or replace function public.record_buyer_mentorship_abandonment_proof_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  saved public.buyer_mentorship_abandonment_proofs_v1%rowtype;
  subscription_id text; session_id text; current_seconds bigint;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh stop proof required'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1
    where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned stop reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  if not exists(select 1 from public.buyer_mentorship_abandonment_holds_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id) then
    raise exception 'Unpaid stop state requires reconciliation'; end if;
  if p_proof->>'version'='buyer-nonpayable-preparation-stop-v1' then
    if public.buyer_mentorship_nonpayable_preparation_v1(r.id) is null or
      p_proof-'observedAt' is distinct from public.buyer_mentorship_nonpayable_preparation_v1(r.id) or
      jsonb_typeof(p_proof->'observedAt') is distinct from 'number' or coalesce(p_proof->>'observedAt','')!~'^[0-9]{1,12}$' then
      raise exception 'Nonpayable preparation proof differs'; end if;
    current_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
    if (p_proof->>'observedAt')::bigint<current_seconds-30 or (p_proof->>'observedAt')::bigint>current_seconds+5 then
      raise exception 'Nonpayable preparation proof is stale'; end if;
  elsif p_proof->>'version'='buyer-partial-subscription-stop-v1' then
    if public.buyer_mentorship_partial_subscription_v1(r.id) is null or
      p_proof-'observedAt'-'canceledAt' is distinct from jsonb_build_object('version','buyer-partial-subscription-stop-v1',
        'preparation',public.buyer_mentorship_partial_subscription_v1(r.id),
        'subscriptionId',public.buyer_mentorship_partial_subscription_v1(r.id)#>>'{subscription,result_id}',
        'sessionId',null,'checkoutStatus','not_created','firstPaymentIntentId',null) or
      jsonb_typeof(p_proof->'observedAt') is distinct from 'number' or
      jsonb_typeof(p_proof->'canceledAt') is distinct from 'number' or
      coalesce(p_proof->>'observedAt','')!~'^[0-9]{1,12}$' or coalesce(p_proof->>'canceledAt','')!~'^[0-9]{1,12}$' then
      raise exception 'Partial subscription terminal proof differs'; end if;
    current_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
    if (p_proof->>'canceledAt')::bigint<=0 or (p_proof->>'canceledAt')::bigint>(p_proof->>'observedAt')::bigint or
      (p_proof->>'observedAt')::bigint<current_seconds-30 or (p_proof->>'observedAt')::bigint>current_seconds+5 then
      raise exception 'Partial subscription terminal proof is stale'; end if;
  elsif p_proof->>'version'='buyer-undispatched-stop-v1' then
    if p_proof - array['version','observedAt']<>'{}'::jsonb or
      jsonb_typeof(p_proof->'observedAt') is distinct from 'number' or coalesce(p_proof->>'observedAt','')!~'^[0-9]{1,12}$' or
      exists(select 1 from public.buyer_mentorship_customer_operations_v1 where reservation_id=r.id) or
      exists(select 1 from public.buyer_mentorship_bootstraps_v1 where reservation_id=r.id) or
      exists(select 1 from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id) then
      raise exception 'Unprepared release requires absence of every original operation'; end if;
    current_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
    if (p_proof->>'observedAt')::bigint<current_seconds-30 or (p_proof->>'observedAt')::bigint>current_seconds+5 then
      raise exception 'Unprepared release proof is stale'; end if;
  else
  select result_id into subscription_id from public.buyer_mentorship_bootstrap_operations_v1
    where reservation_id=r.id and step='subscription.create' and bound_at is not null;
  select result_id into session_id from public.buyer_mentorship_bootstrap_operations_v1
    where reservation_id=r.id and step='checkout.create' and bound_at is not null;
  current_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;
  if subscription_id is null or session_id is null or jsonb_typeof(p_proof) is distinct from 'object' or
    p_proof - array['version','subscriptionId','sessionId','canceledAt','checkoutStatus','firstPaymentIntentId','observedAt']<>'{}'::jsonb or
    p_proof->>'version' is distinct from 'buyer-unpaid-stop-v1' or
    p_proof->>'subscriptionId' is distinct from subscription_id or p_proof->>'sessionId' is distinct from session_id or
    p_proof->>'checkoutStatus' is distinct from 'expired' or p_proof->'firstPaymentIntentId' is distinct from 'null'::jsonb or
    jsonb_typeof(p_proof->'canceledAt') is distinct from 'number' or
    jsonb_typeof(p_proof->'observedAt') is distinct from 'number' or
    coalesce(p_proof->>'canceledAt','')!~'^[0-9]{1,12}$' or coalesce(p_proof->>'observedAt','')!~'^[0-9]{1,12}$' then
    raise exception 'Terminal stop proof differs'; end if;
  if (p_proof->>'canceledAt')::bigint<=0 or (p_proof->>'canceledAt')::bigint>(p_proof->>'observedAt')::bigint or
    (p_proof->>'observedAt')::bigint<current_seconds-30 or (p_proof->>'observedAt')::bigint>current_seconds+5 then
    raise exception 'Terminal stop proof is stale'; end if;
  end if;
  select * into saved from public.buyer_mentorship_abandonment_proofs_v1 where reservation_id=r.id;
  if found then
    if saved.proof-'observedAt' is distinct from p_proof-'observedAt' then raise exception 'Original terminal proof changed'; end if;
    return to_jsonb(saved);
  end if;
  insert into public.buyer_mentorship_abandonment_proofs_v1(reservation_id,proof) values(r.id,p_proof) returning * into saved;
  return to_jsonb(saved);
end $$;

commit;
