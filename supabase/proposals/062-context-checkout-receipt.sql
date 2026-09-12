-- UNAPPLIED. Owned Checkout attempt/result and first captured-payment evidence.
-- No publication, credit, purchase access, subscription activation or collection.
-- Installed financial schemas and previously paid agreements remain unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Context Checkout requires reviewed owner and READ COMMITTED'; end if;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role'))<>3 or
    exists(select 1 from pg_roles where rolname in ('anon','authenticated','service_role') and (rolsuper or rolcreaterole or rolcreatedb)) or
    exists(select 1 from pg_auth_members where member in (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))) then
    raise exception 'Context Checkout role baseline differs'; end if;
  if to_regprocedure('public.read_exact_held_step_v2(uuid,uuid,jsonb,text)') is null or
    to_regprocedure('public.plan_exact_customer_operation_v2(uuid,uuid,jsonb)') is null then
    raise exception 'Context Checkout requires 058-061'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and
    (c.relname like 'exact_context_checkout_attempts_v2%' or c.relname like 'exact_context_checkout_results_v2%' or
     c.relname like 'exact_context_first_receipts_v2%')) or
    exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
      p.proname in ('read_exact_context_checkout_v2','claim_exact_context_checkout_v2','bind_exact_context_checkout_v2',
        'record_exact_context_first_receipt_v2','read_exact_context_first_receipt_v2')) then
    raise exception 'Context Checkout collision; no adoption'; end if;
end;
$preflight$;
create table public.exact_context_checkout_attempts_v2 (
  id uuid primary key,
  reservation_id uuid not null unique references public.exact_installment_context_reservations_v2(id) on delete restrict,
  claimed_at timestamptz not null default clock_timestamp(),
  request jsonb not null check(jsonb_typeof(request)='object'),
  idempotency_key text not null unique
);
create table public.exact_context_checkout_results_v2 (
  attempt_id uuid primary key references public.exact_context_checkout_attempts_v2(id) on delete restrict,
  session_id text not null unique check(session_id ~ '^cs_[A-Za-z0-9_]{1,197}$'),
  request_id text not null check(request_id ~ '^req_[A-Za-z0-9]{1,196}$'),
  bound_at timestamptz not null default clock_timestamp()
);
create table public.exact_context_first_receipts_v2 (
  reservation_id uuid primary key references public.exact_installment_context_reservations_v2(id) on delete restrict,
  session_id text not null unique references public.exact_context_checkout_results_v2(session_id) on delete restrict,
  payment_intent_id text not null unique check(payment_intent_id ~ '^pi_[A-Za-z0-9]{1,197}$'),
  charge_id text not null unique check(charge_id ~ '^ch_[A-Za-z0-9]{1,197}$'),
  balance_transaction_id text not null unique check(balance_transaction_id ~ '^txn_[A-Za-z0-9]{1,196}$'),
  payment_method_id text not null check(payment_method_id ~ '^pm_[A-Za-z0-9]{1,197}$'),
  amount_cents bigint not null check(amount_cents between 50 and 99999999),
  application_fee_cents bigint not null check(application_fee_cents between 0 and amount_cents),
  actual_stripe_fee_cents bigint not null check(actual_stripe_fee_cents between 0 and 99999999),
  paid_at bigint not null check(paid_at>0),
  recorded_at timestamptz not null default clock_timestamp()
);
do $tables$
declare tab text;
begin
  foreach tab in array array['exact_context_checkout_attempts_v2','exact_context_checkout_results_v2','exact_context_first_receipts_v2'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',tab);
    execute format('create trigger immutable before update or delete on public.%I for each row execute function public.guard_exact_customer_plan_v2()',tab);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function public.guard_exact_customer_plan_v2()',tab);
  end loop;
end;
$tables$;

create function public.read_exact_context_checkout_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare a public.exact_context_checkout_attempts_v2%rowtype; b public.exact_context_checkout_results_v2%rowtype;
begin
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into a from public.exact_context_checkout_attempts_v2 where reservation_id=p_reservation_id;
  select * into b from public.exact_context_checkout_results_v2 where attempt_id=a.id;
  return jsonb_build_object('claimed',false,'attempt',case when a.id is null then null else to_jsonb(a) end,
    'binding',case when b.attempt_id is null then null else to_jsonb(b) end);
end;
$$;

create function public.claim_exact_context_checkout_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare op public.exact_installment_context_customer_operations_v2%rowtype;
  r public.exact_installment_context_reservations_v2%rowtype; a public.exact_context_checkout_attempts_v2%rowtype;
  customer_id text; subscription_id text; hold_id text; anchor bigint; count_payments integer; total bigint; gross bigint;
  platform bigint; processing bigint; schedule jsonb; meta jsonb; params jsonb; at_time timestamptz;
  step_id uuid:=gen_random_uuid(); description text; remaining text; total_text text; first_text text;
begin
  op:=public.plan_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into a from public.exact_context_checkout_attempts_v2 where reservation_id=r.id;
  if found then return public.read_exact_context_checkout_v2(r.id,p_actor_id,p_context); end if;
  select b.customer_id into customer_id from public.exact_context_customer_bindings_v2 b where operation_id=op.id;
  select s.anchor_seconds into anchor from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
    where s.reservation_id=r.id and s.stage='product';
  select b.provider_id into subscription_id from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
    where s.reservation_id=r.id and s.stage='subscription' and s.anchor_seconds=anchor;
  select b.provider_id into hold_id from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
    where s.reservation_id=r.id and s.stage='hold' and s.anchor_seconds=anchor;
  if customer_id is null or anchor is null or subscription_id is null or hold_id is distinct from subscription_id then
    raise exception 'Bound customer and held subscription required'; end if;
  at_time:=clock_timestamp();
  if at_time<to_timestamp(anchor) or at_time>=to_timestamp(anchor)+interval '24 hours'-interval '31 minutes' then
    raise exception 'Checkout preparation window expired'; end if;
  count_payments:=(r.terms->>'paymentCount')::integer; total:=(r.terms->>'totalCents')::bigint;
  gross:=total/count_payments; schedule:=r.terms->'firstPaymentFeeSchedule';
  platform:=(gross*1200+5000)/10000;
  processing:=case when (schedule->>'enabled')::boolean then
    (gross*(schedule->>'basisPoints')::bigint+5000)/10000+(schedule->>'fixedCents')::bigint else 0 end;
  if platform+processing>gross then raise exception 'Invalid Checkout fee'; end if;
  -- Same exact-cent disclosure as the existing shared TypeScript payload.
  select string_agg('$'||(amount/100)::text||'.'||lpad((amount%100)::text,2,'0'),', ' order by n) into remaining
    from (select n,gross+case when n=count_payments then total%count_payments else 0 end amount from generate_series(2,count_payments) n) x;
  first_text:='$'||(gross/100)::text||'.'||lpad((gross%100)::text,2,'0');
  total_text:='$'||(total/100)::text||'.'||lpad((total%100)::text,2,'0');
  description:=first_text||' today, then '||remaining||' in monthly payments. '||count_payments::text||' payments total: '||
    total_text||' USD. No automatic renewal after the final payment.';
  meta:=jsonb_set(op.request->'params'->'metadata','{operation_kind}','"checkout.create"'::jsonb)||jsonb_build_object(
    'installment_number','1','installment_subscription_id',subscription_id,'post_id',r.terms->>'postId','product_id',r.terms->>'productId',
    'creator_stripe_account_id',r.terms->>'destinationId','plan_type','installment','plan_months',count_payments::text,
    'installment_total_cents',total::text,'fee_gross_cents',gross::text,'platform_fee_cents',platform::text,
    'processing_fee_cents',processing::text,'total_creator_deduction_cents',(platform+processing)::text,'creator_net_cents',(gross-platform-processing)::text,
    'processing_fee_enabled',schedule->>'enabled','processing_fee_bps',case when (schedule->>'enabled')::boolean then schedule->>'basisPoints' else '0' end,
    'processing_fee_fixed_cents',case when (schedule->>'enabled')::boolean then schedule->>'fixedCents' else '0' end,'fee_schedule_version',schedule->>'version');
  params:=jsonb_build_object('mode','payment','adaptive_pricing',jsonb_build_object('enabled',false),'automatic_tax',jsonb_build_object('enabled',false),
    'allow_promotion_codes',false,'invoice_creation',jsonb_build_object('enabled',false),'customer',customer_id,'payment_method_types',jsonb_build_array('card'),
    'line_items',jsonb_build_array(jsonb_build_object('quantity',1,'price_data',jsonb_build_object('currency','usd','unit_amount',gross,
      'product_data',jsonb_build_object('name',r.terms->>'title','description',description)))),
    'payment_intent_data',jsonb_build_object('application_fee_amount',platform+processing,'transfer_data',jsonb_build_object('destination',r.terms->>'destinationId'),
      'setup_future_usage','off_session','metadata',meta),'metadata',meta,
    'consent_collection',jsonb_build_object('payment_method_reuse_agreement',jsonb_build_object('position','auto')),
    'custom_text',jsonb_build_object('submit',jsonb_build_object('message',description||
      ' By paying, you authorize use of this card for these scheduled installments, subject to the applicable cancellation and refund terms.')),
    'success_url',(r.context->>'siteOrigin')||'/success?session_id={CHECKOUT_SESSION_ID}','cancel_url',(r.context->>'siteOrigin')||'/dashboard','expires_at',anchor+86400);
  insert into public.exact_context_checkout_attempts_v2(id,reservation_id,claimed_at,request,idempotency_key)
    values(step_id,r.id,at_time,jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/checkout/sessions','params',params),
      'cn-exact-v2-checkout:'||step_id::text||':'||op.context_hash||':'||op.terms_hash);
  return public.read_exact_context_checkout_v2(r.id,p_actor_id,p_context)||jsonb_build_object('claimed',true);
end;
$$;

create function public.bind_exact_context_checkout_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,
  p_attempt_id uuid,p_session_id text,p_request_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.exact_context_checkout_attempts_v2%rowtype; b public.exact_context_checkout_results_v2%rowtype;
begin
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into a from public.exact_context_checkout_attempts_v2 where reservation_id=p_reservation_id for update;
  if not found or p_attempt_id is distinct from a.id or p_session_id is null or p_session_id !~ '^cs_[A-Za-z0-9_]{1,197}$' or
    p_request_id is null or p_request_id !~ '^req_[A-Za-z0-9]{1,196}$' then raise exception 'Owned Checkout result required'; end if;
  if exists(select 1 from public.exact_installment_agreements where stripe_checkout_session_id=p_session_id) or
    exists(select 1 from public.purchases where session_id=p_session_id) or
    exists(select 1 from public.booking_payments where stripe_checkout_session_id=p_session_id) then
    raise exception 'Existing financial Checkout cannot be adopted'; end if;
  select * into b from public.exact_context_checkout_results_v2 where attempt_id=a.id;
  if found then
    if b.session_id is distinct from p_session_id or b.request_id is distinct from p_request_id then raise exception 'Checkout already bound differently'; end if;
  else
    if clock_timestamp()<a.claimed_at or clock_timestamp()>a.claimed_at+interval '60 seconds' then raise exception 'Checkout binding window expired'; end if;
    insert into public.exact_context_checkout_results_v2(attempt_id,session_id,request_id) values(a.id,p_session_id,p_request_id);
  end if;
  return public.read_exact_context_checkout_v2(p_reservation_id,p_actor_id,p_context);
end;
$$;

create function public.read_exact_context_first_receipt_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare receipt public.exact_context_first_receipts_v2%rowtype;
begin
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into receipt from public.exact_context_first_receipts_v2 where reservation_id=p_reservation_id;
  return case when receipt.reservation_id is null then null else to_jsonb(receipt) end;
end;
$$;

create function public.record_exact_context_first_receipt_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.exact_context_checkout_attempts_v2%rowtype; b public.exact_context_checkout_results_v2%rowtype;
  saved public.exact_context_first_receipts_v2%rowtype;
begin
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into a from public.exact_context_checkout_attempts_v2 where reservation_id=p_reservation_id for update;
  select * into b from public.exact_context_checkout_results_v2 where attempt_id=a.id;
  if b.attempt_id is null or jsonb_typeof(p_receipt) is distinct from 'object' then raise exception 'Bound Checkout receipt required'; end if;
  if (select count(*) from jsonb_object_keys(p_receipt))<>9 or not(p_receipt ?& array['session_id','payment_intent_id','charge_id',
    'balance_transaction_id','payment_method_id','amount_cents','application_fee_cents','actual_stripe_fee_cents','paid_at']) then
    raise exception 'Exact first receipt fields required'; end if;
  if p_receipt->>'session_id' is distinct from b.session_id or
    jsonb_typeof(p_receipt->'amount_cents') is distinct from 'number' or jsonb_typeof(p_receipt->'application_fee_cents') is distinct from 'number' or
    jsonb_typeof(p_receipt->'actual_stripe_fee_cents') is distinct from 'number' or jsonb_typeof(p_receipt->'paid_at') is distinct from 'number' or
    coalesce(p_receipt->>'amount_cents','') !~ '^\d+$' or coalesce(p_receipt->>'application_fee_cents','') !~ '^\d+$' or
    coalesce(p_receipt->>'actual_stripe_fee_cents','') !~ '^\d+$' or coalesce(p_receipt->>'paid_at','') !~ '^\d+$' or
    (p_receipt->>'amount_cents')::bigint is distinct from (a.request#>>'{params,line_items,0,price_data,unit_amount}')::bigint or
    (p_receipt->>'application_fee_cents')::bigint is distinct from (a.request#>>'{params,payment_intent_data,application_fee_amount}')::bigint or
    (p_receipt->>'paid_at')::bigint<floor(extract(epoch from a.claimed_at)) or
    (p_receipt->>'paid_at')::bigint>floor(extract(epoch from clock_timestamp())) then raise exception 'First receipt binding/amount/time differs'; end if;
  -- This RPC trusts the private server's fresh provider inspection, not metadata
  -- from an HTTP body. The immutable evidence alone cannot grant access/credit.
  select * into saved from public.exact_context_first_receipts_v2 where reservation_id=p_reservation_id;
  if found then
    if (to_jsonb(saved)-'reservation_id'-'recorded_at') is distinct from p_receipt then raise exception 'First receipt already recorded differently'; end if;
  else
    -- A later accounting connection may have consumed this exact saved receipt.
    -- Re-reading identical evidence is allowed; adopting an old payment into a
    -- NEW context receipt remains forbidden and grants no accounting authority.
    if exists(select 1 from public.exact_installment_receipts where stripe_payment_intent_id=p_receipt->>'payment_intent_id') then
      raise exception 'Old payment cannot be adopted'; end if;
    insert into public.exact_context_first_receipts_v2(reservation_id,session_id,payment_intent_id,charge_id,balance_transaction_id,payment_method_id,
      amount_cents,application_fee_cents,actual_stripe_fee_cents,paid_at)
      values(p_reservation_id,b.session_id,p_receipt->>'payment_intent_id',p_receipt->>'charge_id',p_receipt->>'balance_transaction_id',p_receipt->>'payment_method_id',
        (p_receipt->>'amount_cents')::bigint,(p_receipt->>'application_fee_cents')::bigint,(p_receipt->>'actual_stripe_fee_cents')::bigint,(p_receipt->>'paid_at')::bigint);
  end if;
  return public.read_exact_context_first_receipt_v2(p_reservation_id,p_actor_id,p_context);
end;
$$;

do $permissions$
declare oid_value oid; tab text; role_name text;
begin
  foreach oid_value in array array['public.read_exact_context_checkout_v2(uuid,uuid,jsonb)'::regprocedure::oid,
    'public.claim_exact_context_checkout_v2(uuid,uuid,jsonb)'::regprocedure::oid,
    'public.bind_exact_context_checkout_v2(uuid,uuid,jsonb,uuid,text,text)'::regprocedure::oid,
    'public.read_exact_context_first_receipt_v2(uuid,uuid,jsonb)'::regprocedure::oid,
    'public.record_exact_context_first_receipt_v2(uuid,uuid,jsonb,jsonb)'::regprocedure::oid] loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',oid_value::regprocedure);
    execute format('grant execute on function %s to service_role',oid_value::regprocedure);
    if exists(select 1 from pg_proc where oid=oid_value and (not prosecdef or proowner<>(select oid from pg_roles where rolname=current_user) or
      proconfig is distinct from array['search_path=pg_catalog'])) or has_function_privilege('anon',oid_value,'EXECUTE') or
      has_function_privilege('authenticated',oid_value,'EXECUTE') or not has_function_privilege('service_role',oid_value,'EXECUTE') then
      raise exception 'Context Checkout function configuration differs'; end if;
  end loop;
  foreach tab in array array['exact_context_checkout_attempts_v2','exact_context_checkout_results_v2','exact_context_first_receipts_v2'] loop
    oid_value:=to_regclass('public.'||tab);
    if not exists(select 1 from pg_class where oid=oid_value and relrowsecurity and relowner=(select oid from pg_roles where rolname=current_user)) or
      exists(select 1 from pg_policy where polrelid=oid_value) then raise exception 'Context Checkout table baseline differs'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if has_table_privilege(role_name,oid_value,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or
        exists(select 1 from pg_attribute where attrelid=oid_value and attnum>0 and not attisdropped and
        (has_column_privilege(role_name,oid_value,attnum,'SELECT') or has_column_privilege(role_name,oid_value,attnum,'INSERT') or
         has_column_privilege(role_name,oid_value,attnum,'UPDATE') or has_column_privilege(role_name,oid_value,attnum,'REFERENCES'))) then
        raise exception 'Context Checkout table/column ACL differs'; end if;
    end loop;
  end loop;
end;
$permissions$;
commit;
