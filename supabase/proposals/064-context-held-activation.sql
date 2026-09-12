-- UNAPPLIED. Reuse existing activation/calendar/period functions under context
-- admission. Keeps Stripe collection held. No pay/resume/publication operation.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Context activation requires reviewed owner and READ COMMITTED'; end if;
  if to_regprocedure('public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb)') is null or
    to_regclass('public.exact_context_sql_admissions_v2') is not null or
    to_regprocedure('public.read_exact_context_activation_v2(uuid,uuid,jsonb)') is not null then
    raise exception 'Context activation prerequisites or collision'; end if;
end;
$preflight$;

-- Transaction-local admission, removed before the admitting RPC returns. This
-- is not a caller-writable GUC, lease or permanent permission. Old RPCs can use
-- the new rows only while a context-checking wrapper calls their fixed subset.
create table public.exact_context_sql_admissions_v2 (
  transaction_id xid8 not null,
  reservation_id uuid not null references public.exact_installment_context_reservations_v2(id),
  operation text not null check(operation in ('first_credit','activation_claim','activation_complete')),
  primary key(transaction_id,reservation_id)
);
alter table public.exact_context_sql_admissions_v2 enable row level security;
revoke all on public.exact_context_sql_admissions_v2 from public,anon,authenticated,service_role;
create function public.guard_exact_context_sql_entry_v2(p_agreement_id uuid,p_entry text)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare operation text;
begin
  if not exists(select 1 from public.exact_installment_agreements where id=p_agreement_id and terms->>'version'='exact-cents-context-v2') then return; end if;
  select admission.operation into operation from public.exact_context_sql_admissions_v2 admission
    join public.exact_installment_context_reservations_v2 r on r.id=admission.reservation_id
    join public.exact_installment_context_pin_v2 pin on pin.context=r.context and pin.singleton
    where admission.transaction_id=pg_current_xact_id() and admission.reservation_id=p_agreement_id;
  if (operation='first_credit' and p_entry in ('bind_exact_installment_purchase','seed_exact_installment_purchase',
      'record_exact_installment_first_receipt','credit_exact_installment_receipt','fulfill_exact_installment_first_payment')) or
    (operation='activation_claim' and p_entry='claim_exact_installment_activation') or
    (operation='activation_complete' and p_entry='complete_exact_installment_activation') then return; end if;
  raise exception 'Context-scoped payment entry required';
end;
$$;
revoke all on function public.guard_exact_context_sql_entry_v2(uuid,text) from public,anon,authenticated,service_role;

-- Exact normalized body hashes prevent silently wrapping a different function.
-- Keep original OIDs/signatures/ACLs and bodies; insert only the entry guard.
-- There is no renamed unguarded service-callable copy.
do $guard_existing_entries$
declare spec record; function_oid oid; source text; definition text; guarded text;
begin
  for spec in select * from (values
    ('record_exact_installment_first_receipt','uuid,text,text,bigint,bigint,timestamptz','dcda770d21cad8b7a23867027d84f4de6f405e2bc2c207ea103b8b523b932871'),
    ('bind_exact_installment_purchase','uuid,uuid','c9d8c3010463971006f5098bab7e5ab850360271e5a2576ff8804a5fcb04d6ba'),
    ('credit_exact_installment_receipt','uuid,integer,text,text,bigint','d1b6546e087499314d5af76f49737e8497f40b027a3da20260180854180873a1'),
    ('claim_exact_installment_activation','uuid,text,text,uuid','b8ad38d57fa09984b46a9d89f595c05f3d96582f4092f10db09ab56cceaabf2f'),
    ('complete_exact_installment_activation','uuid,uuid','e805e0177f42b7e28480893df244bc943f14011f6f9f66de87f4621148405824'),
    ('seed_exact_installment_purchase','uuid','ee21f3f494d78c7014a1ae17f223d3152ae0fe38e063ff605f2f353b6fe62c9c'),
    ('fulfill_exact_installment_first_payment','uuid','72f739e3bac8e64ddba553b4e51f8d514df4320d456815345c82024796533f1a')
  ) as entries(name,args,hash) loop
    function_oid:=to_regprocedure('public.'||spec.name||'('||spec.args||')');
    select prosrc into source from pg_proc where oid=function_oid and prosecdef and proowner=(select oid from pg_roles where rolname='postgres');
    if source is null or encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>spec.hash then
      raise exception 'Context entry baseline differs: %',spec.name; end if;
    definition:=pg_get_functiondef(function_oid);
    guarded:=regexp_replace(source,E'\nbegin\r?\n',E'\nbegin\n  perform public.guard_exact_context_sql_entry_v2(p_agreement_id,'''||spec.name||E''');\n');
    if guarded=source then raise exception 'Context entry guard insertion failed'; end if;
    execute replace(definition,source,guarded);
  end loop;
  function_oid:='public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb)'::regprocedure;
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'f5e96097f0431d983ecc1f5f4ba78cab6a55a0227c5c19007141feb626584b7e' then
    raise exception 'Context first credit baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'select * into op from public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);',
    'select * into op from public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,''first_credit'');');
  guarded:=replace(guarded,'return jsonb_build_object(''reservation_id'',r.id',
    'delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=r.id;
  return jsonb_build_object(''reservation_id'',r.id');
  if guarded=source then raise exception 'Context credit admission insertion failed'; end if;
  execute replace(definition,source,guarded);
end;
$guard_existing_entries$;

create function public.read_exact_context_activation_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; a public.exact_installment_agreements%rowtype;
  receipt public.exact_context_first_receipts_v2%rowtype; op public.exact_installment_activations%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Context activation requires READ COMMITTED'; end if;
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into receipt from public.exact_context_first_receipts_v2 where reservation_id=r.id;
  select ag.* into a from public.exact_installment_agreements ag join public.exact_context_accounting_links_v2 link
    on link.agreement_id=ag.id and link.booking_payment_id=ag.booking_payment_id where link.reservation_id=r.id for update of ag;
  if not found or a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',a.booking_payment_id) or
    a.stripe_checkout_session_id is distinct from receipt.session_id or a.first_fulfilled_at is null or
    a.status not in ('awaiting_first','active','complete') or
    not exists(select 1 from public.exact_context_held_steps_v2 step join public.exact_context_held_results_v2 binding on binding.step_id=step.id
      where step.reservation_id=r.id and step.stage='subscription' and binding.provider_id=a.stripe_subscription_id) or
    not exists(select 1 from public.exact_installment_context_customer_operations_v2 intent join public.exact_context_customer_bindings_v2 binding
      on binding.operation_id=intent.id where intent.reservation_id=r.id and binding.customer_id=a.stripe_customer_id) or
    not exists(select 1 from public.exact_installment_receipts rec where rec.agreement_id=a.id and rec.payment_number=1 and
      rec.stripe_payment_intent_id=receipt.payment_intent_id and rec.counted_at is not null and rec.amount_cents=receipt.amount_cents and
      rec.application_fee_cents=receipt.application_fee_cents and rec.paid_at=to_timestamp(receipt.paid_at)) or
    exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id) then
    raise exception 'Context activation requires the owned fulfilled first credit without a hold'; end if;
  if a.status='awaiting_first' then perform public.assert_exact_installment_activation_ready(a.id); end if;
  select * into op from public.exact_installment_activations where agreement_id=a.id;
  return jsonb_build_object('agreement_id',a.id,'payment_method_id',receipt.payment_method_id,
    'activation',case when op.agreement_id is null then null else to_jsonb(op) end);
end;
$$;

create function public.claim_exact_context_activation_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_payment_method_id text,p_item_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; result jsonb; token uuid:=gen_random_uuid();
begin
  state:=public.read_exact_context_activation_v2(p_reservation_id,p_actor_id,p_context);
  if state->>'payment_method_id' is distinct from p_payment_method_id then raise exception 'Context activation card differs'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'activation_claim');
  result:=public.claim_exact_installment_activation(p_reservation_id,p_payment_method_id,p_item_id,token);
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  if result->>'status'='review_required' then return jsonb_build_object('claim',result,'state',null); end if;
  return jsonb_build_object('claim',result,'state',public.read_exact_context_activation_v2(p_reservation_id,p_actor_id,p_context));
end;
$$;

create function public.complete_exact_context_activation_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform public.read_exact_context_activation_v2(p_reservation_id,p_actor_id,p_context);
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'activation_complete');
  perform public.complete_exact_installment_activation(p_reservation_id,p_token);
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return public.read_exact_context_activation_v2(p_reservation_id,p_actor_id,p_context);
end;
$$;
revoke all on function public.read_exact_context_activation_v2(uuid,uuid,jsonb),
  public.claim_exact_context_activation_v2(uuid,uuid,jsonb,text,text),public.complete_exact_context_activation_v2(uuid,uuid,jsonb,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_activation_v2(uuid,uuid,jsonb),
  public.claim_exact_context_activation_v2(uuid,uuid,jsonb,text,text),public.complete_exact_context_activation_v2(uuid,uuid,jsonb,uuid) to service_role;
commit;
