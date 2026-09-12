-- UNAPPLIED forward proposal. Only the metadata-only customer.create operation.
-- No checkout, subscription, collection, accounting, access or reservation activation.
-- A claim is permanent: even a lost claim response cannot authorize another send.
-- 058 reservations and 059 request plans retain their original immutable statuses.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Customer dispatch requires reviewed owner and READ COMMITTED'; end if;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role'))<>3 or
    exists(select 1 from pg_roles where rolname in ('anon','authenticated','service_role') and (rolsuper or rolcreaterole or rolcreatedb)) or
    exists(select 1 from pg_auth_members where member in (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))) then
    raise exception 'Customer dispatch runtime role baseline differs'; end if;
  if to_regprocedure('public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)') is null or
    to_regprocedure('public.read_exact_customer_operation_v2(uuid,uuid,jsonb)') is null or
    not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.exact_installment_context_customer_operations_v2')
      and tgname='context_customer_plan_v2_immutable' and tgenabled='O' and not tgisinternal) then
    raise exception 'Customer dispatch requires reviewed 058/059 prerequisites'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and (c.relname like 'exact_context_customer_attempts_v2%' or c.relname like 'exact_context_customer_bindings_v2%')) or
    exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('claim_exact_customer_dispatch_v2','bind_exact_customer_dispatch_v2','read_exact_customer_dispatch_v2')) then
    raise exception 'Customer dispatch object collision; no replay or adoption'; end if;
end;
$preflight$;

create table public.exact_context_customer_attempts_v2 (
  operation_id uuid primary key references public.exact_installment_context_customer_operations_v2(id) on delete restrict,
  id uuid not null unique default gen_random_uuid(),
  claimed_at timestamptz not null default clock_timestamp()
);
create table public.exact_context_customer_bindings_v2 (
  operation_id uuid primary key references public.exact_context_customer_attempts_v2(operation_id) on delete restrict,
  attempt_id uuid not null unique references public.exact_context_customer_attempts_v2(id) on delete restrict,
  customer_id text not null unique check(customer_id ~ '^cus_[A-Za-z0-9]{1,196}$'),
  request_id text not null check(request_id ~ '^req_[A-Za-z0-9]{1,196}$'),
  customer_created bigint not null check(customer_created>0),
  bound_at timestamptz not null default clock_timestamp()
);
-- The single immutable project/account/mode pin scopes both tables through the
-- parent operation. Customer IDs cannot be rebound even to another reservation.
alter table public.exact_context_customer_attempts_v2 enable row level security;
alter table public.exact_context_customer_bindings_v2 enable row level security;
revoke all on public.exact_context_customer_attempts_v2,public.exact_context_customer_bindings_v2 from public,anon,authenticated,service_role;
create trigger customer_attempt_v2_immutable before update or delete on public.exact_context_customer_attempts_v2
  for each row execute function public.guard_exact_customer_plan_v2();
create trigger customer_attempt_v2_no_truncate before truncate on public.exact_context_customer_attempts_v2
  for each statement execute function public.guard_exact_customer_plan_v2();
create trigger customer_binding_v2_immutable before update or delete on public.exact_context_customer_bindings_v2
  for each row execute function public.guard_exact_customer_plan_v2();
create trigger customer_binding_v2_no_truncate before truncate on public.exact_context_customer_bindings_v2
  for each statement execute function public.guard_exact_customer_plan_v2();

create function public.read_exact_customer_dispatch_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare op public.exact_installment_context_customer_operations_v2%rowtype;
  attempt public.exact_context_customer_attempts_v2%rowtype;
  binding public.exact_context_customer_bindings_v2%rowtype;
begin
  op:=public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into attempt from public.exact_context_customer_attempts_v2 where operation_id=op.id;
  select * into binding from public.exact_context_customer_bindings_v2 where operation_id=op.id;
  return jsonb_build_object('claimed',false,'attempt',case when attempt.id is null then null else to_jsonb(attempt) end,
    'binding',case when binding.operation_id is null then null else to_jsonb(binding) end);
end;
$$;

create function public.claim_exact_customer_dispatch_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.exact_installment_context_customer_operations_v2%rowtype;
  attempt public.exact_context_customer_attempts_v2%rowtype; result jsonb;
begin
  -- Reuses 059's booking -> reservation lock order and complete current quote,
  -- owner, destination and absence-of-financial-evidence admission. Locks last
  -- until this RPC commits. A diagnostic read alone cannot admit a new attempt.
  op:=public.plan_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  insert into public.exact_context_customer_attempts_v2(operation_id) values(op.id)
    on conflict(operation_id) do nothing returning * into attempt;
  result:=public.read_exact_customer_dispatch_v2(p_reservation_id,p_actor_id,p_context);
  return result || jsonb_build_object('claimed',attempt.id is not null);
end;
$$;

-- Called only by the private server runtime after validating the actual fresh
-- Stripe create response. SQL cannot independently contact/attest Stripe.
-- No caller-provided JSON, metadata match or customer ID is payment authority.
create function public.bind_exact_customer_dispatch_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,
  p_attempt_id uuid,p_customer_id text,p_request_id text,p_customer_created bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.exact_installment_context_customer_operations_v2%rowtype;
  attempt public.exact_context_customer_attempts_v2%rowtype;
  binding public.exact_context_customer_bindings_v2%rowtype;
begin
  op:=public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into attempt from public.exact_context_customer_attempts_v2 where operation_id=op.id for update;
  if not found or p_attempt_id is distinct from attempt.id or
    p_customer_id is null or p_customer_id !~ '^cus_[A-Za-z0-9]{1,196}$' or
    p_request_id is null or p_request_id !~ '^req_[A-Za-z0-9]{1,196}$' or p_customer_created is null or
    p_customer_created<floor(extract(epoch from attempt.claimed_at)) or
    p_customer_created>floor(extract(epoch from attempt.claimed_at))+60 then
    raise exception 'Owned customer create attempt/result required'; end if;
  select * into binding from public.exact_context_customer_bindings_v2 where operation_id=op.id;
  if found then
    if binding.attempt_id is distinct from p_attempt_id or binding.customer_id is distinct from p_customer_id or
      binding.request_id is distinct from p_request_id or binding.customer_created is distinct from p_customer_created then
      raise exception 'Customer create result already bound differently'; end if;
  else
    -- Late responses remain uncertain for review, never a fresh send. The
    -- response's provider time cannot manufacture a new binding window.
    if clock_timestamp()<attempt.claimed_at or clock_timestamp()>attempt.claimed_at+interval '60 seconds' then
      raise exception 'Customer create binding window expired'; end if;
    insert into public.exact_context_customer_bindings_v2(operation_id,attempt_id,customer_id,request_id,customer_created)
      values(op.id,p_attempt_id,p_customer_id,p_request_id,p_customer_created);
  end if;
  return public.read_exact_customer_dispatch_v2(p_reservation_id,p_actor_id,p_context);
end;
$$;
revoke all on function public.read_exact_customer_dispatch_v2(uuid,uuid,jsonb),
  public.claim_exact_customer_dispatch_v2(uuid,uuid,jsonb),
  public.bind_exact_customer_dispatch_v2(uuid,uuid,jsonb,uuid,text,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.read_exact_customer_dispatch_v2(uuid,uuid,jsonb),
  public.claim_exact_customer_dispatch_v2(uuid,uuid,jsonb),
  public.bind_exact_customer_dispatch_v2(uuid,uuid,jsonb,uuid,text,text,bigint) to service_role;

do $postflight$
declare relation_oid oid; role_name text; privilege_name text; proc_oid oid;
begin
  foreach relation_oid in array array['public.exact_context_customer_attempts_v2'::regclass::oid,
    'public.exact_context_customer_bindings_v2'::regclass::oid] loop
    if not exists(select 1 from pg_class where oid=relation_oid and relrowsecurity and
      relowner=(select oid from pg_roles where rolname=current_user)) or exists(select 1 from pg_policy where polrelid=relation_oid) then
      raise exception 'Customer dispatch table ownership/RLS differs'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
        if has_table_privilege(role_name,relation_oid,privilege_name) then raise exception 'Customer dispatch table ACL differs'; end if;
      end loop;
      if exists(select 1 from pg_attribute where attrelid=relation_oid and attnum>0 and not attisdropped and
        (has_column_privilege(role_name,relation_oid,attnum,'SELECT') or has_column_privilege(role_name,relation_oid,attnum,'INSERT') or
         has_column_privilege(role_name,relation_oid,attnum,'UPDATE') or has_column_privilege(role_name,relation_oid,attnum,'REFERENCES'))) then
        raise exception 'Customer dispatch column ACL differs'; end if;
    end loop;
  end loop;
  foreach proc_oid in array array['public.read_exact_customer_dispatch_v2(uuid,uuid,jsonb)'::regprocedure::oid,
    'public.claim_exact_customer_dispatch_v2(uuid,uuid,jsonb)'::regprocedure::oid,
    'public.bind_exact_customer_dispatch_v2(uuid,uuid,jsonb,uuid,text,text,bigint)'::regprocedure::oid] loop
    if exists(select 1 from pg_proc where oid=proc_oid and (not prosecdef or
      proowner<>(select oid from pg_roles where rolname=current_user) or proconfig is distinct from array['search_path=pg_catalog'])) or
      has_function_privilege('anon',proc_oid,'EXECUTE') or has_function_privilege('authenticated',proc_oid,'EXECUTE') or
      not has_function_privilege('service_role',proc_oid,'EXECUTE') then raise exception 'Customer dispatch function ACL/config differs'; end if;
  end loop;
  if exists(select 1 from public.exact_context_customer_attempts_v2) or exists(select 1 from public.exact_context_customer_bindings_v2) then
    raise exception 'Customer dispatch tables must install empty'; end if;
end;
$postflight$;
commit;
