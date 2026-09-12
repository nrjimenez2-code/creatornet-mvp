-- LOCAL UNAPPLIED FORWARD PROPOSAL ONLY. Not part of installed 040-057.
-- Persists one metadata-only customer REQUEST PLAN, not an executable journal.
-- No provider call, dispatch claim/lease, attempt, result/customer binding,
-- checkout, payment, obligation, acknowledgement or entitlement is authorized.
-- 058 reservations remain permanently reserved_not_issuable. This adds no
-- capability/provisioning table and no way to make a plan dispatchable.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $customer_v2_preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Customer v2 proposal requires reviewed owner and READ COMMITTED'; end if;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role'))<>3 or
    exists(select 1 from pg_roles where rolname in ('anon','authenticated','service_role') and
      (rolsuper or rolcreaterole or rolcreatedb)) or
    exists(select 1 from pg_auth_members where member in
      (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))) or
    not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls) then
    raise exception 'Customer v2 runtime role baseline differs'; end if;
  if not exists(select 1 from pg_class where oid=to_regclass('public.exact_installment_context_reservations_v2')
      and relkind='r' and relrowsecurity and relowner=(select oid from pg_roles where rolname=current_user)) or
    not exists(select 1 from pg_class where oid=to_regclass('public.exact_installment_context_pin_v2')
      and relkind='r' and relrowsecurity and relowner=(select oid from pg_roles where rolname=current_user)) or
    to_regprocedure('public.reserve_exact_installment_context_v2(uuid,uuid,integer,jsonb,jsonb,jsonb)') is null or
    to_regprocedure('public.read_exact_installment_context_pin_v2()') is null or
    to_regprocedure('public.valid_exact_payment_context_v2(jsonb)') is null or
    not exists(select 1 from pg_constraint where conrelid=to_regclass('public.exact_installment_context_reservations_v2')
      and contype='c' and convalidated and conname='exact_installment_context_reservations_v2_status_check'
      and regexp_replace(pg_get_constraintdef(oid),'\s','','g')='CHECK((status=''reserved_not_issuable''::text))') or
    not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.exact_installment_context_reservations_v2')
      and tgname='context_reservation_v2_immutable' and tgtype=27 and tgenabled='O' and not tgisinternal) or
    not exists(select 1 from pg_trigger where tgrelid='public.booking_payments'::regclass
      and tgname='legacy_payment_context_v2' and tgenabled='O' and not tgisinternal) then
    raise exception 'Customer v2 requires reviewed 058 blocked reservation prerequisites'; end if;
  -- Structural/signature prerequisites only, not a fresh hosted full-body audit.
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and c.relname like 'exact_installment_context_customer_operations_v2%') or
    exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'
      and t.typname in ('exact_installment_context_customer_operations_v2','_exact_installment_context_customer_operations_v2')) or
    exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
      p.proname in ('exact_customer_hex_tuple_hash_v2','guard_exact_customer_plan_v2',
        'plan_exact_customer_operation_v2','read_exact_customer_operation_v2')) then
    raise exception 'Customer v2 prospective object collision; no replay or adoption'; end if;
end;
$customer_v2_preflight$;

-- NEW versioned framing, deliberately unrelated to v1 operationHash and JSON
-- serialization: encode each ordered scalar's UTF-8 bytes as lowercase hex,
-- join atoms with '.', then SHA256 the UTF-8 bytes of that ASCII frame. Period
-- never occurs in an encoded atom, so boundaries are unambiguous. No locale,
-- Unicode normalization, jsonb whitespace or object-key ordering is involved.
create function public.exact_customer_hex_tuple_hash_v2(p_atoms text[])
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare frame text;
begin
  if p_atoms is null or array_ndims(p_atoms) is distinct from 1 or cardinality(p_atoms) not between 1 and 100 or
    exists(select 1 from unnest(p_atoms) atom where atom is null or octet_length(atom)>8192) then
    raise exception 'Invalid customer v2 hash tuple'; end if;
  select string_agg(encode(convert_to(atom,'UTF8'),'hex'),'.' order by ordinal) into frame
    from unnest(p_atoms) with ordinality as parts(atom,ordinal);
  return encode(sha256(convert_to(frame,'UTF8')),'hex');
end;
$$;

create table public.exact_installment_context_customer_operations_v2 (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.exact_installment_context_reservations_v2(id) on delete restrict,
  context jsonb not null references public.exact_installment_context_pin_v2(context) on update restrict on delete restrict,
  context_hash text not null check(context_hash ~ '^[0-9a-f]{64}$'),
  terms_hash text not null check(terms_hash ~ '^[0-9a-f]{64}$'),
  operation_kind text not null default 'customer.create' check(operation_kind='customer.create'),
  request jsonb not null check((jsonb_typeof(request)='object' and
    request->>'version'='exact-context-customer-request-v1' and request->>'apiVersion'='2025-10-29.clover' and
    request->>'method'='POST' and request->>'path'='/v1/customers' and jsonb_typeof(request->'params'->'metadata')='object') is true),
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique check(idempotency_key ~ '^cn-exact-v2-customer:[0-9a-f]{64}$'),
  status text not null default 'planned_not_dispatchable' check(status='planned_not_dispatchable'),
  created_at timestamptz not null default now(),
  unique(reservation_id,operation_kind)
);
alter table public.exact_installment_context_customer_operations_v2 enable row level security;
revoke all on public.exact_installment_context_customer_operations_v2 from public,anon,authenticated,service_role;
-- Even the service role reads through the ownership-checking RPC; there is no
-- unused direct table SELECT permission exposing every planned customer.

create function public.guard_exact_customer_plan_v2()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'Customer v2 plan is immutable and not dispatchable'; end;
$$;
create trigger context_customer_plan_v2_immutable before update or delete on public.exact_installment_context_customer_operations_v2
  for each row execute function public.guard_exact_customer_plan_v2();
create trigger context_customer_plan_v2_no_truncate before truncate on public.exact_installment_context_customer_operations_v2
  for each statement execute function public.guard_exact_customer_plan_v2();

create function public.plan_exact_customer_operation_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns public.exact_installment_context_customer_operations_v2
language plpgsql security definer set search_path=pg_catalog as $$
declare
  reservation public.exact_installment_context_reservations_v2%rowtype;
  booking public.bookings%rowtype;
  product public.products%rowtype;
  planned public.exact_installment_context_customer_operations_v2%rowtype;
  t jsonb;
  first_fee jsonb;
  renewal_fee jsonb;
  v_context_hash text;
  v_terms_hash text;
  v_request_hash text;
  v_key text;
  v_metadata jsonb;
  v_request jsonb;
  v_booking_id uuid;
begin
  if p_reservation_id is null or p_actor_id is null or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Invalid customer v2 planning admission'; end if;
  if not public.valid_exact_payment_context_v2(p_context) or not exists(select 1 from public.exact_installment_context_pin_v2
    where singleton and context=p_context) then raise exception 'Explicit owner-provisioned context pin required'; end if;
  select * into reservation from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  if not found or reservation.context is distinct from p_context or reservation.status is distinct from 'reserved_not_issuable' or
    reservation.terms->>'creatorId' is distinct from p_actor_id::text then raise exception 'Owned blocked v2 reservation required'; end if;
  v_booking_id:=reservation.booking_id;
  -- Match 058's admission order: read the immutable booking identity, lock the
  -- booking, then lock/re-read the reservation and revalidate its exact binding.
  -- Recheck ALL admission facts before returning even an existing plan.
  select * into booking from public.bookings where id=v_booking_id for update;
  if not found then raise exception 'Current owned unpaid booking required'; end if;
  select * into reservation from public.exact_installment_context_reservations_v2 where id=p_reservation_id for update;
  if not found or reservation.booking_id is distinct from booking.id or reservation.context is distinct from p_context or
    reservation.status is distinct from 'reserved_not_issuable' or reservation.terms->>'creatorId' is distinct from p_actor_id::text then
    raise exception 'Owned blocked v2 reservation changed'; end if;
  t:=reservation.terms;
  if not found or booking.status is distinct from 'booked' or booking.creator_id is distinct from p_actor_id or
    t->>'bookingId' is distinct from booking.id::text or t->>'buyerId' is distinct from booking.buyer_id::text or
    t->>'postId' is distinct from booking.post_id::text or booking.buyer_id is null or booking.buyer_id=booking.creator_id then
    raise exception 'Current owned unpaid booking required'; end if;
  select p.* into product from public.products p join public.posts post on post.id=booking.post_id and post.product_id=p.id
    and post.creator_id=booking.creator_id where p.creator_id=booking.creator_id for share of p,post;
  if not found or product.id::text is distinct from t->>'productId' or product.is_active is distinct from true or
    product.type not in ('video','course','mentorship') or lower(trim(product.currency)) is distinct from 'usd' or
    t->>'currency' is distinct from 'usd' or t->>'version' is distinct from 'exact-cents-context-v2' or
    product.amount_cents is distinct from (t->>'totalCents')::numeric or trim(product.title) is distinct from t->>'title' then
    raise exception 'Current product no longer matches reservation'; end if;
  perform 1 from public.profiles where id=booking.creator_id and stripe_onboarding_complete=true and
    stripe_account_id=t->>'destinationId' for share;
  if not found then raise exception 'Current creator destination differs'; end if;
  if exists(select 1 from public.booking_payments where booking_id=booking.id) or
    exists(select 1 from public.exact_installment_agreements a where a.terms->>'bookingId'=booking.id::text) or
    exists(select 1 from public.purchases where buyer_id=booking.buyer_id and (post_id=booking.post_id or product_id=product.id)) then
    raise exception 'Existing financial evidence cannot be adopted'; end if;
  first_fee:=t->'firstPaymentFeeSchedule'; renewal_fee:=t->'renewalFeeSchedule';
  -- 058 constructs these scalar types. Check integers before decimal framing so
  -- an owner-inserted malformed snapshot cannot silently round into a hash.
  if jsonb_typeof(t) is distinct from 'object' or (select count(*) from jsonb_object_keys(t))<>13 or
    not(t ?& array['version','currency','bookingId','productId','postId','buyerId','creatorId','destinationId','title',
      'totalCents','paymentCount','firstPaymentFeeSchedule','renewalFeeSchedule']) or
    jsonb_typeof(t->'totalCents') is distinct from 'number' or jsonb_typeof(t->'paymentCount') is distinct from 'number' or
    (t->>'totalCents')::numeric<>trunc((t->>'totalCents')::numeric) or
    (t->>'paymentCount')::numeric<>trunc((t->>'paymentCount')::numeric) or
    (t->>'paymentCount')::numeric not between 2 and 24 or
    (t->>'totalCents')::numeric/(t->>'paymentCount')::numeric<50 then raise exception 'Invalid customer v2 terms snapshot'; end if;
  foreach v_metadata in array array[first_fee,renewal_fee] loop
    if jsonb_typeof(v_metadata) is distinct from 'object' or (select count(*) from jsonb_object_keys(v_metadata))<>4 or
      not(v_metadata ?& array['enabled','basisPoints','fixedCents','version']) or
      jsonb_typeof(v_metadata->'enabled') is distinct from 'boolean' or
      jsonb_typeof(v_metadata->'basisPoints') is distinct from 'number' or jsonb_typeof(v_metadata->'fixedCents') is distinct from 'number' or
      jsonb_typeof(v_metadata->'version') is distinct from 'string' or
      (v_metadata->>'basisPoints')::numeric<>trunc((v_metadata->>'basisPoints')::numeric) or
      (v_metadata->>'fixedCents')::numeric<>trunc((v_metadata->>'fixedCents')::numeric) or
      (v_metadata->>'basisPoints')::numeric not between 0 and 10000 or (v_metadata->>'fixedCents')::numeric not between 0 and 99999999 or
      coalesce(length(trim(v_metadata->>'version')),0) not between 1 and 200 or
      v_metadata->>'version' is distinct from trim(v_metadata->>'version') then
      raise exception 'Invalid customer v2 fee snapshot'; end if;
  end loop;
  v_context_hash:=public.exact_customer_hex_tuple_hash_v2(array['cn-exact-v2-context-v1',p_context->>'version',p_context->>'mode',
    p_context->>'platformAccountId',p_context->>'supabaseProjectRef',p_context->>'siteOrigin']);
  v_terms_hash:=public.exact_customer_hex_tuple_hash_v2(array['cn-exact-v2-terms-v1',t->>'version',t->>'currency',
    t->>'bookingId',t->>'productId',t->>'postId',t->>'buyerId',t->>'creatorId',t->>'destinationId',t->>'title',
    (t->>'totalCents')::numeric::bigint::text,(t->>'paymentCount')::numeric::integer::text,
    first_fee->>'enabled',(first_fee->>'basisPoints')::numeric::integer::text,(first_fee->>'fixedCents')::numeric::bigint::text,first_fee->>'version',
    renewal_fee->>'enabled',(renewal_fee->>'basisPoints')::numeric::integer::text,(renewal_fee->>'fixedCents')::numeric::bigint::text,renewal_fee->>'version']);
  v_metadata:=jsonb_build_object('installment_collection_version','exact-cents-context-v2','installment_plan_id',reservation.id,
    'booking_id',booking.id,'buyer_id',booking.buyer_id,'creator_id',booking.creator_id,
    'context_hash',v_context_hash,'terms_hash',v_terms_hash,'operation_kind','customer.create');
  v_request:=jsonb_build_object('version','exact-context-customer-request-v1','apiVersion','2025-10-29.clover',
    'method','POST','path','/v1/customers','params',jsonb_build_object('metadata',v_metadata));
  v_request_hash:=public.exact_customer_hex_tuple_hash_v2(array['cn-exact-v2-customer-request-v1',
    'exact-context-customer-request-v1','2025-10-29.clover','POST','/v1/customers',
    'installment_collection_version',v_metadata->>'installment_collection_version','installment_plan_id',v_metadata->>'installment_plan_id',
    'booking_id',v_metadata->>'booking_id','buyer_id',v_metadata->>'buyer_id','creator_id',v_metadata->>'creator_id',
    'context_hash',v_context_hash,'terms_hash',v_terms_hash,'operation_kind','customer.create']);
  v_key:='cn-exact-v2-customer:'||public.exact_customer_hex_tuple_hash_v2(array['cn-exact-v2-customer-key-v1',
    'exact_installment_context_reservations_v2','exact_installment_context_customer_operations_v2',reservation.id::text,
    v_context_hash,v_terms_hash,v_request_hash]);
  select * into planned from public.exact_installment_context_customer_operations_v2
    where reservation_id=reservation.id and operation_kind='customer.create';
  if found then
    if planned.context is distinct from p_context or planned.context_hash is distinct from v_context_hash or
      planned.terms_hash is distinct from v_terms_hash or planned.request is distinct from v_request or
      planned.request_hash is distinct from v_request_hash or planned.idempotency_key is distinct from v_key or
      planned.status is distinct from 'planned_not_dispatchable' then raise exception 'Existing customer v2 plan differs'; end if;
    return planned;
  end if;
  insert into public.exact_installment_context_customer_operations_v2(reservation_id,context,context_hash,terms_hash,
    operation_kind,request,request_hash,idempotency_key)
    values(reservation.id,p_context,v_context_hash,v_terms_hash,'customer.create',v_request,v_request_hash,v_key) returning * into planned;
  return planned;
end;
$$;

-- Owned diagnostic read only. A plan remains non-dispatchable even if its source
-- quote later changes; this read must not be interpreted as current admission.
-- The planning RPC always revalidates current quote facts before exact-repeat.
-- Reservation identity remains known after a lost plan response. The unique
-- reservation/operation pair retrieves the existing ID without creating a row.
create function public.read_exact_customer_operation_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns public.exact_installment_context_customer_operations_v2
language plpgsql stable security definer set search_path=pg_catalog as $$
declare planned public.exact_installment_context_customer_operations_v2%rowtype;
begin
  if p_reservation_id is null or p_actor_id is null or not public.valid_exact_payment_context_v2(p_context) or
    not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Invalid customer v2 read admission'; end if;
  select op.* into planned from public.exact_installment_context_customer_operations_v2 op
    join public.exact_installment_context_reservations_v2 r on r.id=op.reservation_id
    join public.bookings b on b.id=r.booking_id
    where op.reservation_id=p_reservation_id and op.operation_kind='customer.create' and op.context=p_context and r.context=p_context and
      r.terms->>'creatorId'=p_actor_id::text and b.creator_id=p_actor_id and
      r.status='reserved_not_issuable' and op.status='planned_not_dispatchable';
  if not found then raise exception 'Owned customer v2 plan required'; end if;
  return planned;
end;
$$;
revoke all on function public.exact_customer_hex_tuple_hash_v2(text[]),public.guard_exact_customer_plan_v2(),
  public.plan_exact_customer_operation_v2(uuid,uuid,jsonb),public.read_exact_customer_operation_v2(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.plan_exact_customer_operation_v2(uuid,uuid,jsonb),public.read_exact_customer_operation_v2(uuid,uuid,jsonb)
  to service_role;

-- Final fail-closed assertions before the only commit. No provisioning or data
-- migration is performed; inherited/default/independent column grants must not
-- expose a dispatch path or let a runtime role rewrite the stored plan.
do $customer_v2_postflight$
declare role_name text; privilege_name text; relation_oid oid:='public.exact_installment_context_customer_operations_v2'::regclass;
begin
  if not exists(select 1 from pg_class where oid=relation_oid and relrowsecurity and
    relowner=(select oid from pg_roles where rolname=current_user)) or exists(select 1 from pg_policy where polrelid=relation_oid) then
    raise exception 'Customer v2 RLS/owner differs'; end if;
  foreach role_name in array array['anon','authenticated','service_role'] loop
    foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if has_table_privilege(role_name,relation_oid,privilege_name) then raise exception 'Customer v2 effective table ACL differs'; end if;
    end loop;
    if exists(select 1 from pg_attribute where attrelid=relation_oid and attnum>0 and not attisdropped and
      (has_column_privilege(role_name,relation_oid,attnum,'SELECT') or
       has_column_privilege(role_name,relation_oid,attnum,'INSERT') or has_column_privilege(role_name,relation_oid,attnum,'UPDATE') or
       has_column_privilege(role_name,relation_oid,attnum,'REFERENCES'))) then raise exception 'Customer v2 effective column ACL differs'; end if;
  end loop;
  if exists(select 1 from pg_proc p where p.oid in ('public.exact_customer_hex_tuple_hash_v2(text[])'::regprocedure,
    'public.guard_exact_customer_plan_v2()'::regprocedure,'public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)'::regprocedure,
    'public.read_exact_customer_operation_v2(uuid,uuid,jsonb)'::regprocedure) and
      (p.proowner<>(select oid from pg_roles where rolname=current_user) or p.proconfig is distinct from array['search_path=pg_catalog'] or
       has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or
       has_function_privilege('service_role',p.oid,'EXECUTE') is distinct from
         (p.oid in ('public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)'::regprocedure,
           'public.read_exact_customer_operation_v2(uuid,uuid,jsonb)'::regprocedure)))) then
    raise exception 'Customer v2 function configuration/ACL differs'; end if;
  if exists(select 1 from public.exact_installment_context_customer_operations_v2) then
    raise exception 'Customer v2 must install empty and non-dispatchable'; end if;
end;
$customer_v2_postflight$;
commit;
