-- UNAPPLIED. Reuse 052/054 quotes, 053/056 permanent retry admission and
-- original accounting and 056's separately reviewed future-card choice.
-- Still UNAPPLIED: no new table, default change or hold release here.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.run_exact_context_card_setup_v2(uuid,uuid,jsonb,text,uuid,text,jsonb)') is null or
    to_regprocedure('public.read_exact_context_buyer_retry_v2(uuid,uuid,jsonb,text,uuid)') is not null then
    raise exception 'Context buyer retry prerequisites or collision'; end if;
end;
$preflight$;
alter table public.exact_context_sql_admissions_v2 drop constraint exact_context_sql_admissions_v2_operation_check;
alter table public.exact_context_sql_admissions_v2 add constraint exact_context_sql_admissions_v2_operation_check
  check(operation in ('first_credit','activation_claim','activation_complete','invoice_prepare','invoice_dispatch','invoice_credit',
    'financial_event','billing_stop','invoice_recovery','card_setup','buyer_retry','buyer_retry_credit','buyer_bank'));
do $guard_entries$
declare spec record; function_oid oid; source text; definition text; guarded text; agreement_expression text;
begin
  for spec in select * from (values
    ('quote_exact_installment_retry','uuid,uuid,uuid,text','e2f7fd2537d6d90bf89bd155ea17879426172c2de6c06e15662b3eec67c82181'),
    ('confirm_exact_installment_retry','uuid,uuid,text','58cadf6259570cd5c81a120b5a3ccc92587be54ae4418027a5495384edcbbbc6'),
    ('admit_exact_installment_retry','uuid,uuid','cca503bde97b648a74e73f4e6c5bddaaf9ff2fb30b6404da3dc9bde73255caca'),
    ('record_exact_installment_retry_receipt','uuid,text,text,bigint,bigint,timestamptz','214d3eecd00bc4bea1b98ec93dfd3f4cd8836b159d93dd5c034473f00204636f'),
    ('quote_exact_installment_future_card','uuid,uuid,uuid','f2cf0455714cb1eb1242f3f1c7c4fd11480da933ebc8c0c8f6bed01181acd262'),
    ('confirm_exact_installment_future_card','uuid,uuid,boolean,text','d421a575e10ddd3210ae05984c651e98c80a55ba71e50480b8e38eac82833e32'),
    ('read_exact_installment_bank_context','uuid,text,uuid,boolean','4062d18ee1b25e8b7173a1efb365e14c0712a085f1eb55c5e1d91975582ea2c2')
  ) as entries(name,args,hash) loop
    function_oid:=to_regprocedure('public.'||spec.name||'('||spec.args||')');
    select prosrc into source from pg_proc where oid=function_oid and prosecdef and proowner=(select oid from pg_roles where rolname='postgres');
    if source is null or encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>spec.hash then
      raise exception 'Context retry baseline differs: %',spec.name; end if;
    definition:=pg_get_functiondef(function_oid);
    agreement_expression:=case when spec.name='read_exact_installment_bank_context' then 'p_agreement_id'
      when spec.name in ('quote_exact_installment_retry','quote_exact_installment_future_card')
      then '(select agreement_id from public.exact_installment_card_setups where id=p_setup_id)'
      when spec.name in ('confirm_exact_installment_retry','confirm_exact_installment_future_card') then '(select agreement_id from public.exact_installment_payment_confirmations where id=p_id)'
      else '(select agreement_id from public.exact_installment_payment_confirmations where id=p_confirmation_id)' end;
    guarded:=regexp_replace(source,E'\nbegin\r?\n',E'\nbegin\n  perform public.guard_exact_context_sql_entry_v2('||agreement_expression||','''||spec.name||E''');\n');
    if guarded=source then raise exception 'Context retry guard insertion failed'; end if;
    execute replace(definition,source,guarded);
  end loop;
  function_oid:='public.guard_exact_context_sql_entry_v2(uuid,text)'::regprocedure;
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'3dfeacd04213dcaa91f825df28e480a144b76a426a673bdafa313fa682f78963' then
    raise exception 'Context retry admission baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'raise exception ''Context-scoped payment entry required'';',
    'if operation=''buyer_retry'' and p_entry in (''quote_exact_installment_retry'',''confirm_exact_installment_retry'',
      ''admit_exact_installment_retry'',''read_current_exact_card_setup'',''assert_exact_card_setup_eligible'',''claim_exact_installment_invoice'',
      ''quote_exact_installment_future_card'',''confirm_exact_installment_future_card'') then return; end if;
  if operation=''buyer_retry_credit'' and p_entry in (''record_exact_installment_retry_receipt'',''record_exact_installment_renewal_receipt'') then return; end if;
  if operation=''buyer_bank'' and p_entry in (''read_exact_installment_bank_context'',''claim_exact_installment_invoice'') then return; end if;
  raise exception ''Context-scoped payment entry required'';');
  if guarded=source then raise exception 'Context retry admission insertion failed'; end if;
  execute replace(definition,source,guarded);
end;
$guard_entries$;

-- A receipt read can run after expiry, a stop or payment. Eligibility to send
-- is rechecked by the original functions, only in the explicit pay phase.
create function public.read_exact_context_buyer_retry_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,p_quote_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; op public.exact_installment_context_customer_operations_v2%rowtype;
  collection jsonb; dependencies jsonb; s public.exact_installment_card_setups%rowtype;
  q public.exact_installment_payment_confirmations%rowtype; admission public.exact_installment_retry_admissions%rowtype;
begin
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  if not found or p_actor_id is null or r.terms->>'buyerId' is distinct from p_actor_id::text or p_quote_id is null then
    raise exception 'Owned buyer retry required'; end if;
  select * into op from public.read_exact_customer_operation_v2(r.id,(r.terms->>'creatorId')::uuid,p_context);
  collection:=public.read_exact_context_invoice_collection_v2(r.id,(r.terms->>'creatorId')::uuid,p_context,p_invoice_id);
  select jsonb_build_object('customerId',collection#>>'{authorization,customerId}','subscriptionId',collection#>>'{authorization,subscriptionId}',
    'productId',result.provider_id,'anchor',step.anchor_seconds) into dependencies from public.exact_context_held_steps_v2 step
    join public.exact_context_held_results_v2 result on result.step_id=step.id where step.reservation_id=r.id and step.stage='product';
  select * into s from public.exact_installment_card_setups where stripe_invoice_id=p_invoice_id;
  if not found or dependencies is null or s.agreement_id is distinct from r.id or s.buyer_id is distinct from p_actor_id or
    s.context_mode is distinct from p_context->>'mode' or s.context_dispatch_token is null or s.context_request is null or
    s.stripe_checkout_session_id is null or s.verified_at is null or s.stripe_setup_intent_id is null or s.replacement_payment_method_id is null or
    s.authorization_snapshot is distinct from collection->'authorization' or
    s.original_payment_intent_id is distinct from collection#>>'{state,claim,stripe_payment_intent_id}' then
    raise exception 'Owned verified context card required'; end if;
  select * into q from public.exact_installment_payment_confirmations where id=p_quote_id;
  if found and (q.agreement_id is distinct from r.id or q.buyer_id is distinct from p_actor_id or q.setup_request_id is distinct from s.id or
    q.stripe_invoice_id is distinct from p_invoice_id or q.original_payment_intent_id is distinct from s.original_payment_intent_id or
    q.authorization_snapshot is distinct from s.authorization_snapshot or q.setup_intent_id is distinct from s.stripe_setup_intent_id or
    q.replacement_payment_method_id is distinct from s.replacement_payment_method_id or q.consent_version is distinct from 'single-invoice-pay-now-v1' or
    (not q.future_card_option and (q.future_card_periods is not null or q.future_card_accepted is not null))) then
    raise exception 'Context retry quote differs; no adoption'; end if;
  if q.id is not null and q.future_card_option then
    if (q.authorization_snapshot->>'paymentNumber')::integer >= (q.authorization_snapshot->>'paymentCount')::integer or
      q.future_card_periods is distinct from (select jsonb_agg(jsonb_build_object('paymentNumber',p.payment_number,'amountCents',p.amount_cents,
        'dueAt',p.due_at,'periodEnd',p.period_end) order by p.payment_number) from public.exact_installment_periods p
        where p.agreement_id=r.id and p.payment_number>(q.authorization_snapshot->>'paymentNumber')::integer) or
      (q.confirmed_at is null and (q.future_card_accepted is not null or exists(
        select 1 from public.exact_installment_future_card_choices where confirmation_id=q.id))) or
      (q.confirmed_at is not null and not exists(select 1 from public.exact_installment_future_card_choices c where c.confirmation_id=q.id and
        c.agreement_id=r.id and c.accepted=q.future_card_accepted and c.consent_version='same-plan-remaining-card-v1' and
        c.consent_text='Optional: Use this replacement card for the remaining scheduled installments on this plan only, after this payment is verified and the account checks pass. The original amounts, dates, and fixed end stay unchanged. This does not collect the remaining balance now or authorize payments for other purchases.' and
        c.first_payment_number=(q.authorization_snapshot->>'paymentNumber')::integer+1 and c.remaining_periods=q.future_card_periods and
        c.created_at>=q.confirmed_at and c.created_at<=clock_timestamp())) then
      raise exception 'Original future-card choice or schedule differs'; end if;
  end if;
  select * into admission from public.exact_installment_retry_admissions where stripe_invoice_id=p_invoice_id;
  if found and (q.id is null or admission.confirmation_id is distinct from q.id or admission.agreement_id is distinct from r.id) then
    raise exception 'Original retry admission differs'; end if;
  return jsonb_build_object('reservation',to_jsonb(r),'operation',to_jsonb(op),'collection',collection,'dependencies',dependencies,
    'setup',to_jsonb(s),'quote',case when q.id is null then null else to_jsonb(q) end,
    'admission',case when admission.confirmation_id is null then null else to_jsonb(admission) end);
end;
$$;

create function public.run_exact_context_buyer_retry_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,p_quote_id uuid,
  p_phase text,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; q public.exact_installment_payment_confirmations%rowtype; admitted boolean:=false; credited jsonb;
begin
  state:=public.read_exact_context_buyer_retry_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id,p_quote_id);
  if p_phase is null or p_phase not in ('quote','quote_future','pay','credit') then raise exception 'Invalid context retry phase'; end if;
  if p_phase in ('quote','quote_future','pay') then
    insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'buyer_retry');
    if p_phase in ('quote','quote_future') then
      if p_proof is distinct from 'null'::jsonb then raise exception 'Unexpected quote input'; end if;
      if p_phase='quote_future' then
        perform public.quote_exact_installment_future_card(p_quote_id,(state#>>'{setup,id}')::uuid,p_actor_id);
      else
        perform public.quote_exact_installment_retry(p_quote_id,(state#>>'{setup,id}')::uuid,p_actor_id,'single-invoice-pay-now-v1');
      end if;
    else
      if p_proof is distinct from '{"accepted":true,"consentVersion":"single-invoice-pay-now-v1"}'::jsonb and
        p_proof is distinct from '{"accepted":true,"consentVersion":"single-invoice-pay-now-v1","futureCardConsentVersion":"same-plan-remaining-card-v1"}'::jsonb then
        raise exception 'Explicit pay-now consent required'; end if;
      select * into q from public.exact_installment_payment_confirmations where id=p_quote_id;
      if not found then raise exception 'Reviewed quote required'; end if;
      if q.future_card_option then
        perform public.confirm_exact_installment_future_card(q.id,p_actor_id,p_proof ? 'futureCardConsentVersion','same-plan-remaining-card-v1');
      elsif p_proof ? 'futureCardConsentVersion' then raise exception 'Future-card option was not reviewed'; end if;
      -- Record consent and consume admission atomically. A lost acknowledgement
      -- cannot later be promoted into a new charge by repeating the HTTP action.
      if q.confirmed_at is null then
        perform public.confirm_exact_installment_retry(q.id,p_actor_id,'single-invoice-pay-now-v1');
        admitted:=public.admit_exact_installment_retry(q.id,p_actor_id);
        if not admitted then raise exception 'Fresh confirmation did not admit'; end if;
      end if;
    end if;
    delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  else
    if state->'admission'='null'::jsonb or jsonb_typeof(p_proof) is distinct from 'object' or
      (select count(*) from jsonb_object_keys(p_proof))<>9 or not(p_proof ?& array['invoiceId','paymentIntentId','amountCents',
        'applicationFeeCents','paidAt','chargeId','balanceTransactionId','actualStripeFeeCents','refundedAmountCents']) or
      p_proof->>'invoiceId' is distinct from p_invoice_id then raise exception 'Admitted retry receipt required'; end if;
    insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'buyer_retry_credit');
    perform public.record_exact_installment_retry_receipt(p_quote_id,p_invoice_id,p_proof->>'paymentIntentId',
      (p_proof->>'amountCents')::bigint,(p_proof->>'applicationFeeCents')::bigint,to_timestamp((p_proof->>'paidAt')::bigint));
    delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
    -- Same original once-only ledger/credit/completion path, in this transaction.
    credited:=public.credit_exact_context_invoice_v2(p_reservation_id,(state#>>'{reservation,terms,creatorId}')::uuid,p_context,p_invoice_id,p_proof);
  end if;
  return jsonb_build_object('admitted',admitted,'credit',credited,
    'state',public.read_exact_context_buyer_retry_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id,p_quote_id));
end;
$$;
-- Both original-card and replacement-card bank challenges reuse 055's action
-- checks. No new financial records, debit admission, or stored client secret.
create function public.read_exact_context_bank_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,p_for_action boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; op public.exact_installment_context_customer_operations_v2%rowtype;
  collection jsonb; dependencies jsonb; bank jsonb; retry jsonb:=null;
begin
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  if not found or p_actor_id is null or r.terms->>'buyerId' is distinct from p_actor_id::text or p_for_action is null then
    raise exception 'Owned buyer bank context required'; end if;
  select * into op from public.read_exact_customer_operation_v2(r.id,(r.terms->>'creatorId')::uuid,p_context);
  collection:=public.read_exact_context_invoice_collection_v2(r.id,(r.terms->>'creatorId')::uuid,p_context,p_invoice_id);
  select jsonb_build_object('customerId',collection#>>'{authorization,customerId}','subscriptionId',collection#>>'{authorization,subscriptionId}',
    'productId',result.provider_id,'anchor',step.anchor_seconds) into dependencies from public.exact_context_held_steps_v2 step
    join public.exact_context_held_results_v2 result on result.step_id=step.id where step.reservation_id=r.id and step.stage='product';
  if dependencies is null or collection->'authorization'='null'::jsonb then raise exception 'Original bank invoice required'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),r.id,'buyer_bank');
  bank:=public.read_exact_installment_bank_context(r.id,p_invoice_id,p_actor_id,p_for_action);
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=r.id;
  if bank->'authorization' is distinct from collection->'authorization' or
    bank->>'paymentIntentId' is distinct from collection#>>'{state,claim,stripe_payment_intent_id}' then
    raise exception 'Bank admission changed'; end if;
  if bank->>'retryId' is not null then
    retry:=public.read_exact_context_buyer_retry_v2(r.id,p_actor_id,p_context,p_invoice_id,(bank->>'retryId')::uuid);
  end if;
  return jsonb_build_object('reservation',to_jsonb(r),'operation',to_jsonb(op),'collection',collection,'dependencies',dependencies,'bank',bank,'retry',retry);
end;
$$;

-- Extend the existing observation entry only after installing the owned retry
-- reader above. The original event/revision/basis/evidence checks stay intact.
do $bank_recovery$
declare function_oid oid:='public.run_exact_context_recovery_v2(uuid,uuid,jsonb,text,jsonb,text,jsonb,text,jsonb)'::regprocedure;
  source text; definition text; guarded text;
begin
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'dfaef10eae9ae60da9f1785dcab5faf64c6c9ecd959ef12ad17fbfcbc0b30e20' then
    raise exception 'Context bank recovery baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'if retry_admitted then raise exception ''Replacement admission requires its separate receipt path''; end if;',
    'if retry_admitted then perform public.read_exact_context_bank_v2(p_reservation_id,
      (select (terms->>''buyerId'')::uuid from public.exact_installment_context_reservations_v2 where id=p_reservation_id),
      p_context,p_invoice_id,false); end if;');
  if guarded=source then raise exception 'Context bank recovery insertion failed'; end if;
  execute replace(definition,source,guarded);
end;
$bank_recovery$;
revoke all on function public.read_exact_context_bank_v2(uuid,uuid,jsonb,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_bank_v2(uuid,uuid,jsonb,text,boolean) to service_role;
revoke all on function public.read_exact_context_buyer_retry_v2(uuid,uuid,jsonb,text,uuid),
  public.run_exact_context_buyer_retry_v2(uuid,uuid,jsonb,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_buyer_retry_v2(uuid,uuid,jsonb,text,uuid),
  public.run_exact_context_buyer_retry_v2(uuid,uuid,jsonb,text,uuid,text,jsonb) to service_role;
commit;
