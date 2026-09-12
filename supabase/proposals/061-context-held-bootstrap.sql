-- UNAPPLIED. Completes only the no-card product/subscription/hold preparation.
-- No Checkout, collection, financial rows, access or reservation activation.
-- Permanent claims: response loss never authorizes another provider send.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Held bootstrap requires reviewed owner and READ COMMITTED'; end if;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role'))<>3 or
    exists(select 1 from pg_roles where rolname in ('anon','authenticated','service_role') and (rolsuper or rolcreaterole or rolcreatedb)) or
    exists(select 1 from pg_auth_members where member in (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))) then
    raise exception 'Held bootstrap role baseline differs'; end if;
  if to_regprocedure('public.read_exact_customer_dispatch_v2(uuid,uuid,jsonb)') is null or
    to_regprocedure('public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)') is null or
    not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.exact_context_customer_bindings_v2')
      and tgname='customer_binding_v2_immutable' and tgenabled='O' and not tgisinternal) then
    raise exception 'Held bootstrap requires 058-060 prerequisites'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and (c.relname like 'exact_context_held_steps_v2%' or c.relname like 'exact_context_held_results_v2%')) or
    exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('read_exact_held_step_v2','claim_exact_held_step_v2','bind_exact_held_step_v2')) then
    raise exception 'Held bootstrap object collision; no adoption'; end if;
end;
$preflight$;

create table public.exact_context_held_steps_v2 (
  id uuid primary key,
  reservation_id uuid not null references public.exact_installment_context_reservations_v2(id) on delete restrict,
  stage text not null check(stage in ('product','subscription','hold')),
  anchor_seconds bigint not null check(anchor_seconds>0),
  claimed_at timestamptz not null default clock_timestamp(),
  request jsonb not null check(jsonb_typeof(request)='object'),
  idempotency_key text not null unique,
  unique(reservation_id,stage)
);
create table public.exact_context_held_results_v2 (
  step_id uuid primary key references public.exact_context_held_steps_v2(id) on delete restrict,
  provider_id text not null check(provider_id ~ '^(prod|sub)_[A-Za-z0-9]{1,196}$'),
  request_id text not null check(request_id ~ '^req_[A-Za-z0-9]{1,196}$'),
  bound_at timestamptz not null default clock_timestamp()
);
-- A subscription is intentionally referenced by both creation and hold result;
-- bind RPC forbids reuse across reservations/stages other than that exact pair.
alter table public.exact_context_held_steps_v2 enable row level security;
alter table public.exact_context_held_results_v2 enable row level security;
revoke all on public.exact_context_held_steps_v2,public.exact_context_held_results_v2 from public,anon,authenticated,service_role;
create trigger held_step_v2_immutable before update or delete on public.exact_context_held_steps_v2
  for each row execute function public.guard_exact_customer_plan_v2();
create trigger held_step_v2_no_truncate before truncate on public.exact_context_held_steps_v2
  for each statement execute function public.guard_exact_customer_plan_v2();
create trigger held_result_v2_immutable before update or delete on public.exact_context_held_results_v2
  for each row execute function public.guard_exact_customer_plan_v2();
create trigger held_result_v2_no_truncate before truncate on public.exact_context_held_results_v2
  for each statement execute function public.guard_exact_customer_plan_v2();

create function public.read_exact_held_step_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_stage text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare attempt public.exact_context_held_steps_v2%rowtype; binding public.exact_context_held_results_v2%rowtype;
begin
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  if p_stage is null or p_stage not in ('product','subscription','hold') then raise exception 'Invalid held stage'; end if;
  select * into attempt from public.exact_context_held_steps_v2 where reservation_id=p_reservation_id and stage=p_stage;
  select * into binding from public.exact_context_held_results_v2 where step_id=attempt.id;
  return jsonb_build_object('claimed',false,'attempt',case when attempt.id is null then null else to_jsonb(attempt) end,
    'binding',case when binding.step_id is null then null else to_jsonb(binding) end);
end;
$$;

create function public.claim_exact_held_step_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_stage text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.exact_installment_context_customer_operations_v2%rowtype;
  r public.exact_installment_context_reservations_v2%rowtype;
  customer_id text; product_id text; subscription_id text; anchor bigint; trial_end bigint; cancel_at bigint;
  attempt public.exact_context_held_steps_v2%rowtype;
  params jsonb; request_path text; metadata jsonb; step_id uuid:=gen_random_uuid(); at_time timestamptz;
begin
  if p_stage is null or p_stage not in ('product','subscription','hold') then raise exception 'Invalid held stage'; end if;
  -- Reuse current admission and booking->reservation locks. Serializes all
  -- stages for this reservation and rejects changed price/owner/destination.
  op:=public.plan_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into attempt from public.exact_context_held_steps_v2 where reservation_id=r.id and stage=p_stage;
  if found then return public.read_exact_held_step_v2(r.id,p_actor_id,p_context,p_stage); end if;
  select b.customer_id into customer_id from public.exact_context_customer_bindings_v2 b where operation_id=op.id;
  if customer_id is null then raise exception 'Bound owned customer required'; end if;
  at_time:=clock_timestamp();
  if p_stage='product' then anchor:=floor(extract(epoch from at_time));
  else
    select s.anchor_seconds,b.provider_id into anchor,product_id from public.exact_context_held_steps_v2 s
      join public.exact_context_held_results_v2 b on b.step_id=s.id where s.reservation_id=r.id and s.stage='product';
    if product_id is null then raise exception 'Bound owned product required'; end if;
  end if;
  if at_time<to_timestamp(anchor) or at_time>=to_timestamp(anchor)+interval '24 hours'-interval '31 minutes' then
    raise exception 'Held bootstrap window expired'; end if;
  metadata:=jsonb_set(op.request->'params'->'metadata','{operation_kind}',to_jsonb(p_stage||'.create'));
  if p_stage='product' then
    request_path:='/v1/products'; params:=jsonb_build_object('name',(r.terms->>'title')||' installments','metadata',metadata);
  elsif p_stage='subscription' then
    trial_end:=anchor+48*3600;
    cancel_at:=floor(extract(epoch from ((to_timestamp(trial_end) at time zone 'UTC' +
      make_interval(months=>(r.terms->>'paymentCount')::integer-1)) at time zone 'UTC')));
    request_path:='/v1/subscriptions';
    params:=jsonb_build_object('customer',customer_id,'items',jsonb_build_array(jsonb_build_object('quantity',1,
      'price_data',jsonb_build_object('currency','usd','product',product_id,
        'unit_amount',(r.terms->>'totalCents')::bigint/(r.terms->>'paymentCount')::integer,
        'recurring',jsonb_build_object('interval','month')))),
      'trial_end',trial_end,'cancel_at',cancel_at,'proration_behavior','none','billing_mode',jsonb_build_object('type','classic'),
      'collection_method','charge_automatically','transfer_data',jsonb_build_object('destination',r.terms->>'destinationId'),
      'payment_settings',jsonb_build_object('payment_method_types',jsonb_build_array('card'),'save_default_payment_method','off'),
      'trial_settings',jsonb_build_object('end_behavior',jsonb_build_object('missing_payment_method','create_invoice')),'metadata',metadata);
  else
    select b.provider_id into subscription_id from public.exact_context_held_steps_v2 s
      join public.exact_context_held_results_v2 b on b.step_id=s.id where s.reservation_id=r.id and s.stage='subscription';
    if subscription_id is null then raise exception 'Bound owned subscription required'; end if;
    request_path:='/v1/subscriptions/'||subscription_id;
    params:=jsonb_build_object('pause_collection',jsonb_build_object('behavior','keep_as_draft'));
  end if;
  insert into public.exact_context_held_steps_v2(id,reservation_id,stage,anchor_seconds,claimed_at,request,idempotency_key)
    values(step_id,r.id,p_stage,anchor,at_time,
      jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path',request_path,'params',params),
      'cn-exact-v2-held:'||step_id::text||':'||op.context_hash||':'||op.terms_hash);
  return public.read_exact_held_step_v2(r.id,p_actor_id,p_context,p_stage)||jsonb_build_object('claimed',true);
end;
$$;

create function public.bind_exact_held_step_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_stage text,
  p_step_id uuid,p_provider_id text,p_request_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare attempt public.exact_context_held_steps_v2%rowtype; binding public.exact_context_held_results_v2%rowtype;
  expected_subscription text;
begin
  -- Cross-reservation provider identity checks run after the advisory lock and
  -- must see the preceding lock holder's committed binding, not an old snapshot.
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Held result binding requires READ COMMITTED'; end if;
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into attempt from public.exact_context_held_steps_v2
    where reservation_id=p_reservation_id and stage=p_stage for update;
  if not found or p_step_id is distinct from attempt.id or p_request_id is null or
    p_request_id !~ '^req_[A-Za-z0-9]{1,196}$' or p_provider_id is null or
    p_provider_id !~ (case when p_stage='product' then '^prod_' else '^sub_' end||'[A-Za-z0-9]{1,196}$') then
    raise exception 'Owned held attempt/result required'; end if;
  if p_stage='hold' then
    select b.provider_id into expected_subscription from public.exact_context_held_steps_v2 s
      join public.exact_context_held_results_v2 b on b.step_id=s.id where s.reservation_id=p_reservation_id and s.stage='subscription';
    if p_provider_id is distinct from expected_subscription then raise exception 'Hold subscription differs'; end if;
  end if;
  -- Global lock on the provider identity prevents simultaneous cross-reservation
  -- reuse; only the exact subscription creation/hold pair may share its ID.
  perform pg_advisory_xact_lock(hashtextextended('cn-held-result:'||p_provider_id,0));
  if exists(select 1 from public.exact_context_held_results_v2 b join public.exact_context_held_steps_v2 s on s.id=b.step_id
    where b.provider_id=p_provider_id and (s.reservation_id<>p_reservation_id or
      (s.stage<>p_stage and not (s.stage in ('subscription','hold') and p_stage in ('subscription','hold'))))) then
    raise exception 'Held provider identity already bound'; end if;
  select * into binding from public.exact_context_held_results_v2 where step_id=attempt.id;
  if found then
    if binding.provider_id is distinct from p_provider_id or binding.request_id is distinct from p_request_id then
      raise exception 'Held result already bound differently'; end if;
  else
    if clock_timestamp()<attempt.claimed_at or clock_timestamp()>attempt.claimed_at+interval '60 seconds' then
      raise exception 'Held binding window expired'; end if;
    insert into public.exact_context_held_results_v2(step_id,provider_id,request_id) values(attempt.id,p_provider_id,p_request_id);
  end if;
  return public.read_exact_held_step_v2(p_reservation_id,p_actor_id,p_context,p_stage);
end;
$$;
revoke all on function public.read_exact_held_step_v2(uuid,uuid,jsonb,text),
  public.claim_exact_held_step_v2(uuid,uuid,jsonb,text),public.bind_exact_held_step_v2(uuid,uuid,jsonb,text,uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.read_exact_held_step_v2(uuid,uuid,jsonb,text),
  public.claim_exact_held_step_v2(uuid,uuid,jsonb,text),public.bind_exact_held_step_v2(uuid,uuid,jsonb,text,uuid,text,text) to service_role;

do $postflight$
declare relation_oid oid; role_name text; privilege_name text; proc_oid oid;
begin
  foreach relation_oid in array array['public.exact_context_held_steps_v2'::regclass::oid,'public.exact_context_held_results_v2'::regclass::oid] loop
    if not exists(select 1 from pg_class where oid=relation_oid and relrowsecurity and
      relowner=(select oid from pg_roles where rolname=current_user)) or exists(select 1 from pg_policy where polrelid=relation_oid) then
      raise exception 'Held table ownership/RLS differs'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
        if has_table_privilege(role_name,relation_oid,privilege_name) then raise exception 'Held table ACL differs'; end if;
      end loop;
      if exists(select 1 from pg_attribute where attrelid=relation_oid and attnum>0 and not attisdropped and
        (has_column_privilege(role_name,relation_oid,attnum,'SELECT') or has_column_privilege(role_name,relation_oid,attnum,'INSERT') or
         has_column_privilege(role_name,relation_oid,attnum,'UPDATE') or has_column_privilege(role_name,relation_oid,attnum,'REFERENCES'))) then
        raise exception 'Held column ACL differs'; end if;
    end loop;
  end loop;
  foreach proc_oid in array array['public.read_exact_held_step_v2(uuid,uuid,jsonb,text)'::regprocedure::oid,
    'public.claim_exact_held_step_v2(uuid,uuid,jsonb,text)'::regprocedure::oid,
    'public.bind_exact_held_step_v2(uuid,uuid,jsonb,text,uuid,text,text)'::regprocedure::oid] loop
    if exists(select 1 from pg_proc where oid=proc_oid and (not prosecdef or
      proowner<>(select oid from pg_roles where rolname=current_user) or proconfig is distinct from array['search_path=pg_catalog'])) or
      has_function_privilege('anon',proc_oid,'EXECUTE') or has_function_privilege('authenticated',proc_oid,'EXECUTE') or
      not has_function_privilege('service_role',proc_oid,'EXECUTE') then raise exception 'Held function ACL/config differs'; end if;
  end loop;
  if exists(select 1 from public.exact_context_held_steps_v2) or exists(select 1 from public.exact_context_held_results_v2) then
    raise exception 'Held bootstrap must install empty'; end if;
end;
$postflight$;
commit;
