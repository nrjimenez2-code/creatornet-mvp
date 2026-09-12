-- UNAPPLIED. Reuse the administrator-approved future-billing stop, post-credit.
-- No refund, debt forgiveness, entitlement change, invoice void or unhold.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.apply_exact_context_financial_event_v2(uuid,uuid,jsonb,jsonb,jsonb)') is null or
    to_regprocedure('public.read_exact_context_stop_v2(uuid,uuid,jsonb)') is not null then
    raise exception 'Context billing stop prerequisites or collision'; end if;
end;
$preflight$;
alter table public.exact_context_sql_admissions_v2 drop constraint exact_context_sql_admissions_v2_operation_check;
alter table public.exact_context_sql_admissions_v2 add constraint exact_context_sql_admissions_v2_operation_check
  check(operation in ('first_credit','activation_claim','activation_complete','invoice_prepare','invoice_dispatch','invoice_credit','financial_event','billing_stop'));
do $guard_entries$
declare spec record; function_oid oid; source text; definition text; guarded text;
begin
  for spec in select * from (values
    ('hold_exact_installment_for_cancellation','uuid,uuid,uuid','6cf88ee60d109b4b922858bf66af04d7e7280de4c0c9614fec42d353715b6629'),
    ('claim_exact_installment_billing_stop','uuid,uuid,uuid,uuid','723483c4897501b918eca2a44e9bfc60768ee7d0fe4abd32079fbc10ca1e813c'),
    ('assert_exact_installment_billing_stop','uuid,uuid,uuid,uuid','95a945c985ea14ffce64f6bd814638a7809b09f977b82f7fa75d945f2d6f4a33'),
    ('complete_exact_installment_billing_stop','uuid,uuid,uuid,uuid,text,text,bigint,text,text','25531095a394322fa34d7103a4c01139b8730dbdbd118d6c4b83ff8859cc84e6')
  ) as entries(name,args,hash) loop
    function_oid:=to_regprocedure('public.'||spec.name||'('||spec.args||')');
    select prosrc into source from pg_proc where oid=function_oid and prosecdef and proowner=(select oid from pg_roles where rolname='postgres');
    if source is null or encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>spec.hash then
      raise exception 'Context stop baseline differs: %',spec.name; end if;
    definition:=pg_get_functiondef(function_oid);
    guarded:=regexp_replace(source,E'\nbegin\r?\n',E'\nbegin\n  perform public.guard_exact_context_sql_entry_v2(p_agreement_id,'''||spec.name||E''');\n');
    if guarded=source then raise exception 'Context stop guard insertion failed'; end if;
    execute replace(definition,source,guarded);
  end loop;
  function_oid:='public.guard_exact_context_sql_entry_v2(uuid,text)'::regprocedure;
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'141e03ba7faec0b764e64511df5b52088d0d31bcf0423cfeaab6cc4b1ea2e3bd' then
    raise exception 'Context stop admission baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'raise exception ''Context-scoped payment entry required'';',
    'if operation=''billing_stop'' and p_entry in (''hold_exact_installment_for_cancellation'',''claim_exact_installment_billing_stop'',
      ''assert_exact_installment_billing_stop'',''complete_exact_installment_billing_stop'') then return; end if;
  raise exception ''Context-scoped payment entry required'';');
  if guarded=source then raise exception 'Context stop admission insertion failed'; end if;
  execute replace(definition,source,guarded);
end;
$guard_entries$;

-- POST: verifies the authenticated administrator, real context and immutable
-- setup/accounting linkage. No metadata hint can authorize another agreement.
create function public.read_exact_context_stop_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; a public.exact_installment_agreements%rowtype;
  op public.exact_installment_context_customer_operations_v2%rowtype; customer_id text; sub_id text; checkout_id text;
  customer_metadata jsonb; sub_metadata jsonb; checkout_metadata jsonb; receipts jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or not exists(
    select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'Verified context administrator required'; end if;
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  if not found then raise exception 'Context stop reservation missing'; end if;
  select * into op from public.read_exact_customer_operation_v2(r.id,(r.terms->>'creatorId')::uuid,p_context);
  select customer.customer_id into customer_id from public.exact_context_customer_bindings_v2 customer where customer.operation_id=op.id;
  customer_metadata:=op.request#>'{params,metadata}';
  select bound.provider_id,step.request#>'{params,metadata}' into sub_id,sub_metadata
    from public.exact_context_held_steps_v2 step join public.exact_context_held_results_v2 bound on bound.step_id=step.id
    where step.reservation_id=r.id and step.stage='subscription';
  select bound.session_id,attempt.request#>'{params,metadata}' into checkout_id,checkout_metadata
    from public.exact_context_checkout_attempts_v2 attempt join public.exact_context_checkout_results_v2 bound on bound.attempt_id=attempt.id
    where attempt.reservation_id=r.id;
  select ag.* into a from public.exact_installment_agreements ag join public.exact_context_accounting_links_v2 link
    on link.agreement_id=ag.id and link.booking_payment_id=ag.booking_payment_id where link.reservation_id=r.id for update of ag;
  if not found or a.first_fulfilled_at is null or a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',a.booking_payment_id) or
    customer_id is null or sub_id is null or checkout_id is null or a.stripe_customer_id is distinct from customer_id or
    a.stripe_subscription_id is distinct from sub_id or a.stripe_checkout_session_id is distinct from checkout_id or
    not exists(select 1 from public.exact_context_first_receipts_v2 receipt where receipt.reservation_id=r.id and receipt.session_id=checkout_id) or
    not exists(select 1 from public.exact_context_held_steps_v2 step join public.exact_context_held_results_v2 bound on bound.step_id=step.id
      where step.reservation_id=r.id and step.stage='hold' and bound.provider_id=sub_id) then
    raise exception 'Credited context stop binding required'; end if;
  if exists(select 1 from public.exact_installment_receipts receipt left join public.payment_fee_ledger ledger on ledger.id=receipt.ledger_id
    where receipt.agreement_id=a.id and receipt.counted_at is not null and (
      ledger.id is null or ledger.earnings_credited_at is null or ledger.purchase_id is distinct from a.purchase_id or
      ledger.booking_payment_id is distinct from a.booking_payment_id or ledger.creator_id::text is distinct from r.terms->>'creatorId' or
      ledger.stripe_payment_intent_id is distinct from receipt.stripe_payment_intent_id or ledger.stripe_invoice_id is distinct from receipt.stripe_invoice_id or
      ledger.gross_amount_cents is distinct from receipt.amount_cents or ledger.total_creator_deduction_cents is distinct from receipt.application_fee_cents or
      ledger.currency is distinct from 'usd' or ledger.status not in ('paid','refunded'))) then raise exception 'Context stop receipt accounting differs'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('paymentIntentId',receipt.stripe_payment_intent_id,'invoiceId',receipt.stripe_invoice_id,
    'amountCents',receipt.amount_cents) order by receipt.payment_number),'[]'::jsonb) into receipts
    from public.exact_installment_receipts receipt where receipt.agreement_id=a.id and receipt.counted_at is not null;
  return jsonb_build_object('reservation',to_jsonb(r),'customerId',customer_id,'subscriptionId',sub_id,'sessionId',checkout_id,
    'metadata',jsonb_build_object('customer',customer_metadata,'subscription',sub_metadata,'checkout',checkout_metadata),'receipts',receipts);
end;
$$;

create function public.run_exact_context_stop_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,
  p_request_id uuid,p_token uuid,p_phase text,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; result text;
begin
  state:=public.read_exact_context_stop_v2(p_reservation_id,p_actor_id,p_context);
  if p_request_id is null or p_token is null or p_phase is null or p_phase not in ('claim','assert','complete') or
    (p_phase<>'complete' and p_proof is distinct from 'null'::jsonb) then raise exception 'Invalid context stop operation'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'billing_stop');
  if p_phase='claim' then
    result:=public.claim_exact_installment_billing_stop(p_reservation_id,p_request_id,p_actor_id,p_token);
  elsif p_phase='assert' then
    perform public.assert_exact_installment_billing_stop(p_reservation_id,p_request_id,p_actor_id,p_token); result:='authorized';
  else
    if jsonb_typeof(p_proof) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_proof))<>5 or
      not(p_proof ?& array['subscriptionId','sessionId','canceledAt','checkoutStatus','firstPaymentIntentId']) or
      p_proof->>'subscriptionId' is distinct from state->>'subscriptionId' or p_proof->>'sessionId' is distinct from state->>'sessionId' or
      jsonb_typeof(p_proof->'canceledAt') is distinct from 'number' or
      (p_proof->>'canceledAt')::numeric is distinct from trunc((p_proof->>'canceledAt')::numeric) then raise exception 'Invalid context terminal stop proof'; end if;
    perform public.complete_exact_installment_billing_stop(p_reservation_id,p_request_id,p_actor_id,p_token,
      p_proof->>'subscriptionId',p_proof->>'sessionId',(p_proof->>'canceledAt')::bigint,p_proof->>'checkoutStatus',p_proof->>'firstPaymentIntentId');
    result:='collection_stopped';
  end if;
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return jsonb_build_object('reservationId',p_reservation_id,'actorId',p_actor_id,'requestId',p_request_id,'token',p_token,'status',result);
end;
$$;
revoke all on function public.read_exact_context_stop_v2(uuid,uuid,jsonb),public.run_exact_context_stop_v2(uuid,uuid,jsonb,uuid,uuid,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_stop_v2(uuid,uuid,jsonb),public.run_exact_context_stop_v2(uuid,uuid,jsonb,uuid,uuid,text,jsonb) to service_role;
commit;
