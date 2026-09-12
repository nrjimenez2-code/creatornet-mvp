-- UNAPPLIED. Context-scoped single dispatch and atomic original receipt/credit.
-- Reuses 043's permanent admission, 041's ledger/count and fixed-end completion.
-- No scheduler, enabled route, automatic collection, backfill or hosted change.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.bind_exact_context_invoice_preparation_v2(uuid,uuid,jsonb,text,uuid,text)') is null or
    to_regprocedure('public.read_exact_context_invoice_collection_v2(uuid,uuid,jsonb,text)') is not null then
    raise exception 'Context collection prerequisites or collision'; end if;
end;
$preflight$;

alter table public.exact_context_sql_admissions_v2 drop constraint exact_context_sql_admissions_v2_operation_check;
alter table public.exact_context_sql_admissions_v2 add constraint exact_context_sql_admissions_v2_operation_check
  check(operation in ('first_credit','activation_claim','activation_complete','invoice_prepare','invoice_dispatch','invoice_credit'));

do $guard_existing_entries$
declare spec record; function_oid oid; source text; definition text; guarded text;
begin
  for spec in select * from (values
    ('record_exact_installment_renewal_receipt','uuid,text,text,bigint,bigint,timestamptz','c6c73b2e5f78087666ed2116651de5a2d6230afece47ccab01483e45c75943c1'),
    ('complete_exact_installment_agreement','uuid','99987b9a70c376749a332f79cfc0dd647b2b694b1a6cbcf2a2b18cde7c0382b8')
  ) as entries(name,args,hash) loop
    function_oid:=to_regprocedure('public.'||spec.name||'('||spec.args||')');
    select prosrc into source from pg_proc where oid=function_oid and prosecdef and proowner=(select oid from pg_roles where rolname='postgres');
    if source is null or encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>spec.hash then
      raise exception 'Context collection baseline differs: %',spec.name; end if;
    definition:=pg_get_functiondef(function_oid);
    guarded:=regexp_replace(source,E'\nbegin\r?\n',E'\nbegin\n  perform public.guard_exact_context_sql_entry_v2(p_agreement_id,'''||spec.name||E''');\n');
    if guarded=source then raise exception 'Context collection guard insertion failed'; end if;
    execute replace(definition,source,guarded);
  end loop;
  function_oid:='public.guard_exact_context_sql_entry_v2(uuid,text)'::regprocedure;
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'5aca16dc9e80481a1c3b064aaeac106c04e9e2db8bc9640b424407231fdd2ee9' then
    raise exception 'Context collection admission baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'raise exception ''Context-scoped payment entry required'';',
    'if operation=''invoice_dispatch'' and p_entry=''admit_exact_installment_dispatch'' then return; end if;
  if operation=''invoice_credit'' and p_entry in (''record_exact_installment_renewal_receipt'',''credit_exact_installment_receipt'',''complete_exact_installment_agreement'') then return; end if;
  raise exception ''Context-scoped payment entry required'';');
  if guarded=source then raise exception 'Context collection admission insertion failed'; end if;
  execute replace(definition,source,guarded);
end;
$guard_existing_entries$;

-- READ COMMITTED/POST because this read locks the owned agreement. Unlike the
-- preparation admission, a receipt read is allowed after a hold/cancellation:
-- it cannot send money or erase a stop. Original credit rules still apply.
create function public.read_exact_context_invoice_collection_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; a public.exact_installment_agreements%rowtype;
  receipt public.exact_context_first_receipts_v2%rowtype; act public.exact_installment_activations%rowtype;
  claim public.exact_installment_invoice_claims%rowtype; period public.exact_installment_periods%rowtype;
  state jsonb; authorized jsonb; card jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_invoice_id is null or p_invoice_id!~'^in_[a-zA-Z0-9]+$' then
    raise exception 'Invalid context collection read'; end if;
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into receipt from public.exact_context_first_receipts_v2 where reservation_id=r.id;
  select ag.* into a from public.exact_installment_agreements ag join public.exact_context_accounting_links_v2 link
    on link.agreement_id=ag.id and link.booking_payment_id=ag.booking_payment_id where link.reservation_id=r.id for update of ag;
  if not found or a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',a.booking_payment_id) or
    a.stripe_checkout_session_id is distinct from receipt.session_id or a.first_fulfilled_at is null or
    not exists(select 1 from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
      where s.reservation_id=r.id and s.stage='subscription' and b.provider_id=a.stripe_subscription_id) or
    not exists(select 1 from public.exact_installment_context_customer_operations_v2 i join public.exact_context_customer_bindings_v2 b
      on b.operation_id=i.id where i.reservation_id=r.id and b.customer_id=a.stripe_customer_id) or
    not exists(select 1 from public.exact_installment_receipts rec where rec.agreement_id=a.id and rec.payment_number=1 and
      rec.stripe_payment_intent_id=receipt.payment_intent_id and rec.counted_at is not null and rec.amount_cents=receipt.amount_cents and
      rec.application_fee_cents=receipt.application_fee_cents and rec.paid_at=to_timestamp(receipt.paid_at)) then
    raise exception 'Owned fulfilled context payment required'; end if;
  select * into act from public.exact_installment_activations where agreement_id=a.id and status='complete';
  if not found then raise exception 'Completed context activation required'; end if;
  select * into claim from public.exact_installment_invoice_claims where agreement_id=a.id and stripe_invoice_id=p_invoice_id;
  state:=jsonb_build_object('agreement_id',a.id,'booking_payment_id',a.booking_payment_id,
    'activation',jsonb_build_object('agreement_id',a.id,'payment_method_id',receipt.payment_method_id,'activation',to_jsonb(act)),
    'first_receipt',to_jsonb(receipt)-'reservation_id'-'recorded_at',
    'periods',coalesce((select jsonb_agg(to_jsonb(p) order by p.payment_number) from public.exact_installment_periods p where p.agreement_id=a.id),'[]'::jsonb),
    'claim',case when claim.agreement_id is null then null else to_jsonb(claim) end);
  if claim.agreement_id is not null then
    select * into period from public.exact_installment_periods where agreement_id=a.id and payment_number=claim.payment_number;
    authorized:=jsonb_build_object('planId',a.id,'bookingPaymentId',a.booking_payment_id,'invoiceId',p_invoice_id,
      'subscriptionId',a.stripe_subscription_id,'subscriptionItemId',act.activation_snapshot->>'subscriptionItemId',
      'customerId',a.stripe_customer_id,'destinationId',a.terms->>'destinationId','currency','usd',
      'totalCents',(a.terms->>'totalCents')::bigint,'paymentCount',(a.terms->>'paymentCount')::integer,
      'paymentNumber',period.payment_number,'periodStart',period.due_at,'periodEnd',period.period_end,
      'cancelAt',(act.activation_snapshot->>'cancelAt')::bigint,'feeSchedule',a.terms->'renewalFeeSchedule',
      'paymentMethodId',act.activation_snapshot->>'paymentMethodId');
    select authorization_snapshot into card from public.exact_installment_invoice_cards where stripe_invoice_id=p_invoice_id;
    if found then authorized:=card; end if;
  end if;
  return jsonb_build_object('state',state,'authorization',authorized,'agreement_status',a.status,
    'prior',coalesce((select jsonb_agg(jsonb_build_object('paymentNumber',rec.payment_number,'paymentIntentId',rec.stripe_payment_intent_id)
      order by rec.payment_number) from public.exact_installment_receipts rec where rec.agreement_id=a.id and rec.counted_at is not null),'[]'::jsonb));
end;
$$;

create function public.admit_exact_context_invoice_dispatch_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,
  p_token uuid,p_payment_intent_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb;
begin
  state:=public.assert_exact_context_invoice_preparation_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id,p_token);
  if state#>>'{claim,status}' is distinct from 'prepared' or state#>>'{claim,stripe_payment_intent_id}' is distinct from p_payment_intent_id then
    raise exception 'Prepared context invoice identity differs'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'invoice_dispatch');
  perform public.admit_exact_installment_dispatch(p_reservation_id,p_invoice_id,p_token);
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  -- A lost response is NOT repeat permission: original status is dispatching.
  return jsonb_build_object('admitted',true,'collection',public.read_exact_context_invoice_collection_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id));
end;
$$;

create function public.credit_exact_context_invoice_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare collection jsonb; number integer; credited boolean; result text;
begin
  collection:=public.read_exact_context_invoice_collection_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id);
  if jsonb_typeof(p_receipt) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_receipt))<>9 or
    not (p_receipt ?& array['invoiceId','paymentIntentId','amountCents','applicationFeeCents','paidAt','chargeId','balanceTransactionId','actualStripeFeeCents','refundedAmountCents']) or
    p_receipt->>'invoiceId' is distinct from p_invoice_id or
    p_receipt->>'paymentIntentId' is distinct from collection#>>'{state,claim,stripe_payment_intent_id}' or
    collection#>>'{state,claim,status}' is null or collection#>>'{state,claim,status}' not in ('dispatching','paid') then
    raise exception 'Original admitted context receipt required'; end if;
  number:=(collection#>>'{state,claim,payment_number}')::integer;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'invoice_credit');
  perform public.record_exact_installment_renewal_receipt(p_reservation_id,p_invoice_id,p_receipt->>'paymentIntentId',
    (p_receipt->>'amountCents')::bigint,(p_receipt->>'applicationFeeCents')::bigint,to_timestamp((p_receipt->>'paidAt')::bigint));
  perform public.record_payment_refund_state(p_receipt->>'paymentIntentId',p_receipt->>'chargeId',
    (p_receipt->>'amountCents')::bigint,(p_receipt->>'refundedAmountCents')::bigint);
  credited:=public.credit_exact_installment_receipt(p_reservation_id,number,p_receipt->>'chargeId',p_receipt->>'balanceTransactionId',
    (p_receipt->>'actualStripeFeeCents')::bigint);
  perform public.reconcile_exact_installment_dispute_audit(p_receipt->>'paymentIntentId');
  if number=(collection#>>'{authorization,paymentCount}')::integer then perform public.complete_exact_installment_agreement(p_reservation_id); end if;
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  select status into result from public.exact_installment_agreements where id=p_reservation_id;
  return jsonb_build_object('reservation_id',p_reservation_id,'invoice_id',p_invoice_id,'payment_number',number,'credited',credited,'agreement_status',result);
end;
$$;

revoke all on function public.read_exact_context_invoice_collection_v2(uuid,uuid,jsonb,text),
  public.admit_exact_context_invoice_dispatch_v2(uuid,uuid,jsonb,text,uuid,text),
  public.credit_exact_context_invoice_v2(uuid,uuid,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_invoice_collection_v2(uuid,uuid,jsonb,text),
  public.admit_exact_context_invoice_dispatch_v2(uuid,uuid,jsonb,text,uuid,text),
  public.credit_exact_context_invoice_v2(uuid,uuid,jsonb,text,jsonb) to service_role;
commit;
