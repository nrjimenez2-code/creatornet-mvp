-- UNAPPLIED. Observe existing refunds/disputes using 046/048, not new refunds.
-- No route enablement, access change, debt waiver, collection resumption or backfill.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.credit_exact_context_invoice_v2(uuid,uuid,jsonb,text,jsonb)') is null or
    to_regprocedure('public.read_exact_context_financial_event_v2(uuid,uuid,jsonb,jsonb)') is not null then
    raise exception 'Context financial event prerequisites or collision'; end if;
end;
$preflight$;
alter table public.exact_context_sql_admissions_v2 drop constraint exact_context_sql_admissions_v2_operation_check;
alter table public.exact_context_sql_admissions_v2 add constraint exact_context_sql_admissions_v2_operation_check
  check(operation in ('first_credit','activation_claim','activation_complete','invoice_prepare','invoice_dispatch','invoice_credit','financial_event'));
do $guard_existing_entries$
declare spec record; function_oid oid; source text; definition text; guarded text;
begin
  for spec in select * from (values
    ('hold_exact_installment_refund_event','uuid,text,text,text,bigint','490102190549a8e94a9eb542ef2e7ac6fc7547175d51847109012ba2fda7ff98'),
    ('apply_exact_installment_refund_event','uuid,text,text,text,bigint,bigint','1b6a409c7e742f27a6bd4818295760d9b3352623f1844a30aa38ab53757bc213'),
    ('hold_exact_installment_lifecycle_event','uuid,text,text,text','663b31d9c94ed0a0701899927a581181a18dd6a59af258e5f17ad8d5ed95a16d'),
    ('finish_exact_installment_lifecycle','uuid,text,text,bigint,jsonb,text,jsonb','2f105d4ef1d5bf43524ec9885bc0de66ff633dcddbca7d2e11bb8ccf06938e89'),
    ('apply_exact_installment_dispute_event','uuid,text,text,bigint,jsonb,text,text,bigint,bigint,text,bigint','7e6d49fd8795901bfc222b3e8fc09d2047b1e2aa5daf0e0f1a919054889cc297')
  ) as entries(name,args,hash) loop
    function_oid:=to_regprocedure('public.'||spec.name||'('||spec.args||')');
    select prosrc into source from pg_proc where oid=function_oid and prosecdef and proowner=(select oid from pg_roles where rolname='postgres');
    if source is null or encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>spec.hash then
      raise exception 'Context financial event baseline differs: %',spec.name; end if;
    definition:=pg_get_functiondef(function_oid);
    guarded:=regexp_replace(source,E'\nbegin\r?\n',E'\nbegin\n  perform public.guard_exact_context_sql_entry_v2(p_agreement_id,'''||spec.name||E''');\n');
    if guarded=source then raise exception 'Context financial event guard insertion failed'; end if;
    execute replace(definition,source,guarded);
  end loop;
  function_oid:='public.guard_exact_context_sql_entry_v2(uuid,text)'::regprocedure;
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'d2445583ea290def03ca5c8981dcbb109bcf0934b09247696da5e81e9c661e54' then
    raise exception 'Context financial event admission baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'raise exception ''Context-scoped payment entry required'';',
    'if operation=''financial_event'' and p_entry in (''hold_exact_installment_refund_event'',''apply_exact_installment_refund_event'',
      ''hold_exact_installment_lifecycle_event'',''finish_exact_installment_lifecycle'',''apply_exact_installment_dispute_event'') then return; end if;
  raise exception ''Context-scoped payment entry required'';');
  if guarded=source then raise exception 'Context financial event admission insertion failed'; end if;
  execute replace(definition,source,guarded);
end;
$guard_existing_entries$;

-- Event identity comes from the private account-checked Stripe retrieve, never
-- metadata alone. Its payment must already be a receipt or permanent admission.
-- This POST locks ownership, but grants no payment permission or stop release.
create function public.read_exact_context_financial_event_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_event jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; a public.exact_installment_agreements%rowtype;
  first public.exact_context_first_receipts_v2%rowtype; rec public.exact_installment_receipts%rowtype;
  ledger public.payment_fee_ledger%rowtype; receipt jsonb; lifecycle jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' or jsonb_typeof(p_event) is distinct from 'object' or
    (select count(*) from jsonb_object_keys(p_event))<>7 or
    not (p_event ?& array['id','type','kind','objectId','paymentIntentId','chargeId','created']) or
    coalesce(p_event->>'id','')!~'^evt_[A-Za-z0-9]+$' or coalesce(p_event->>'chargeId','')!~'^ch_[A-Za-z0-9]+$' or
    coalesce(p_event->>'paymentIntentId','')!~'^pi_[A-Za-z0-9]+$' or jsonb_typeof(p_event->'created') is distinct from 'number' or
    (p_event->>'created')::numeric<>trunc((p_event->>'created')::numeric) or (p_event->>'created')::bigint>extract(epoch from now()) then
    raise exception 'Invalid context financial event'; end if;
  if ((p_event->>'kind'='refund' and ((p_event->>'type'='charge.refunded' and p_event->>'objectId'=p_event->>'chargeId') or
      (p_event->>'type' in ('refund.created','refund.updated','refund.failed') and p_event->>'objectId'~'^re_[A-Za-z0-9]+$'))) or
    (p_event->>'kind'='dispute' and p_event->>'type' in ('charge.dispute.created','charge.dispute.updated','charge.dispute.closed',
      'charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated') and p_event->>'objectId'~'^du_[A-Za-z0-9]+$')) is not true then
    raise exception 'Unsupported context financial event'; end if;
  perform public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into first from public.exact_context_first_receipts_v2 where reservation_id=r.id;
  select ag.* into a from public.exact_installment_agreements ag join public.exact_context_accounting_links_v2 link
    on link.agreement_id=ag.id and link.booking_payment_id=ag.booking_payment_id where link.reservation_id=r.id for update of ag;
  if not found or (p_event->>'created')::bigint<extract(epoch from r.created_at)::bigint-1 or
    a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',a.booking_payment_id) or
    a.stripe_checkout_session_id is distinct from first.session_id or a.first_fulfilled_at is null or
    not exists(select 1 from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
      where s.reservation_id=r.id and s.stage='subscription' and b.provider_id=a.stripe_subscription_id) or
    not exists(select 1 from public.exact_installment_context_customer_operations_v2 i join public.exact_context_customer_bindings_v2 b
      on b.operation_id=i.id where i.reservation_id=r.id and b.customer_id=a.stripe_customer_id) then
    raise exception 'Owned context financial binding required'; end if;
  select * into rec from public.exact_installment_receipts where agreement_id=a.id and stripe_payment_intent_id=p_event->>'paymentIntentId';
  if not found and not exists(select 1 from public.exact_installment_invoice_claims where agreement_id=a.id and
      stripe_payment_intent_id=p_event->>'paymentIntentId' and status in ('dispatching','paid')) then
    raise exception 'Context event payment is not durably bound'; end if;
  if rec.counted_at is not null then
    select * into ledger from public.payment_fee_ledger where id=rec.ledger_id;
    if not found or ledger.earnings_credited_at is null or ledger.purchase_id is distinct from a.purchase_id or
      ledger.booking_payment_id is distinct from a.booking_payment_id or ledger.creator_id::text is distinct from r.terms->>'creatorId' or
      ledger.stripe_payment_intent_id is distinct from rec.stripe_payment_intent_id or ledger.stripe_charge_id is distinct from p_event->>'chargeId' or
      ledger.stripe_invoice_id is distinct from rec.stripe_invoice_id or ledger.gross_amount_cents is distinct from rec.amount_cents or
      ledger.total_creator_deduction_cents is distinct from rec.application_fee_cents or ledger.currency is distinct from 'usd' then
      raise exception 'Context event receipt ledger differs'; end if;
    receipt:=jsonb_build_object('paymentNumber',rec.payment_number,'amountCents',rec.amount_cents,'applicationFeeCents',rec.application_fee_cents,
      'chargeId',ledger.stripe_charge_id,'balanceTransactionId',ledger.stripe_balance_transaction_id,'actualStripeFeeCents',ledger.actual_stripe_fee_cents,'invoiceId',rec.stripe_invoice_id);
  end if;
  if p_event->>'kind'='dispute' then lifecycle:=public.read_exact_installment_lifecycle(a.id,p_event->>'objectId'); end if;
  return jsonb_build_object('agreement_id',a.id,'booking_payment_id',a.booking_payment_id,'customer_id',a.stripe_customer_id,
    'subscription_id',a.stripe_subscription_id,'session_id',a.stripe_checkout_session_id,'receipt',receipt,'lifecycle',lifecycle,'event',p_event);
end;
$$;

create function public.hold_exact_context_financial_event_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_event jsonb)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb;
begin
  state:=public.read_exact_context_financial_event_v2(p_reservation_id,p_actor_id,p_context,p_event);
  if p_event->>'kind'='refund' and state->'receipt'='null'::jsonb then return 'reconciliation_required'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'financial_event');
  if p_event->>'kind'='refund' then
    perform public.hold_exact_installment_refund_event(p_reservation_id,p_event->>'id',p_event->>'paymentIntentId',p_event->>'chargeId',(state#>>'{receipt,amountCents}')::bigint);
  else
    perform public.hold_exact_installment_lifecycle_event(p_reservation_id,p_event->>'id',p_event->>'objectId',p_event->>'paymentIntentId');
  end if;
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return 'held';
end;
$$;

create function public.apply_exact_context_financial_event_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_event jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; cumulative bigint; status text; refund jsonb;
begin
  state:=public.read_exact_context_financial_event_v2(p_reservation_id,p_actor_id,p_context,p_event);
  if state->'receipt'='null'::jsonb or jsonb_typeof(p_proof) is distinct from 'object' then raise exception 'Credited context event evidence required'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'financial_event');
  if p_event->>'kind'='refund' then
    if (select count(*) from jsonb_object_keys(p_proof))<>2 or not(p_proof ?& array['refundedAmountCents','succeeded']) or
      jsonb_typeof(p_proof->'refundedAmountCents') is distinct from 'number' or
      (p_proof->>'refundedAmountCents')::numeric is distinct from trunc((p_proof->>'refundedAmountCents')::numeric) or
      jsonb_typeof(p_proof->'succeeded') is distinct from 'array' or jsonb_array_length(p_proof->'succeeded') not between 1 and 10000 or
      (select sum((x->>'amount')::bigint) from jsonb_array_elements(p_proof->'succeeded') x) is distinct from (p_proof->>'refundedAmountCents')::bigint or
      (select count(distinct x->>'id') from jsonb_array_elements(p_proof->'succeeded') x)<>jsonb_array_length(p_proof->'succeeded') then
      raise exception 'Invalid context refund confirmation'; end if;
    for refund in select * from jsonb_array_elements(p_proof->'succeeded') loop
      if jsonb_typeof(refund) is distinct from 'object' or (select count(*) from jsonb_object_keys(refund))<>3 or
        not(refund ?& array['id','amount','operationId']) or coalesce(refund->>'id','')!~'^re_[A-Za-z0-9]+$' or
        jsonb_typeof(refund->'amount') is distinct from 'number' or
        (refund->>'amount')::numeric is distinct from trunc((refund->>'amount')::numeric) or
        jsonb_typeof(refund->'operationId') not in ('string','null') or
        (refund->>'amount')::bigint not between 1 and (state#>>'{receipt,amountCents}')::bigint then
        raise exception 'Invalid context succeeded refund'; end if;
    end loop;
    cumulative:=public.apply_exact_installment_refund_event(p_reservation_id,p_event->>'id',p_event->>'paymentIntentId',p_event->>'chargeId',
      (state#>>'{receipt,amountCents}')::bigint,(p_proof->>'refundedAmountCents')::bigint);
    status:='reconciliation_required';
    if cumulative=(p_proof->>'refundedAmountCents')::bigint then
      -- Same matching rules as confirmAdminRefundWebhookDelivery: exact own PI,
      -- amount and refund ID (or operation metadata when delivery beat binding).
      -- This confirms delivery only, not responsibility or fee-refund completion.
      update public.refund_operations op set webhook_confirmed_at=now(),updated_at=now()
        where op.stripe_payment_intent_id=p_event->>'paymentIntentId' and op.webhook_confirmed_at is null and
          op.cumulative_customer_refund_target_cents>0 and op.cumulative_customer_refund_target_cents<=cumulative and
          exists(select 1 from jsonb_array_elements(p_proof->'succeeded') x where (x->>'amount')::bigint=op.customer_refund_amount_cents and
            ((op.stripe_refund_id is not null and x->>'id'=op.stripe_refund_id) or (op.stripe_refund_id is null and x->>'operationId'=op.id::text)));
      status:='refund_reconciled';
    end if;
  else
    if (select count(*) from jsonb_object_keys(p_proof))<>3 or not(p_proof ?& array['read','amount','status']) or
      jsonb_typeof(p_proof->'amount') is distinct from 'number' or
      (p_proof->>'amount')::numeric is distinct from trunc((p_proof->>'amount')::numeric) or
      (p_proof->>'amount')::bigint not between 1 and 99999999 or
      jsonb_typeof(p_proof->'status') is distinct from 'string' or
      p_proof->>'status' not in ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented') then
      raise exception 'Invalid context dispute observation'; end if;
    if (p_proof->>'amount')::bigint>(state#>>'{receipt,amountCents}')::bigint then
      -- 019's ledger mirror is bounded by original gross. Preserve that limit;
      -- record the actual larger observation for review, never clamp its amount
      -- or repeatedly fail while trying to write an incompatible ledger row.
      perform public.hold_exact_installment_lifecycle_event(p_reservation_id,p_event->>'id',p_event->>'objectId',p_event->>'paymentIntentId');
      if public.finish_exact_installment_lifecycle(p_reservation_id,p_event->>'id',p_event->>'objectId',
        (p_proof#>>'{read,revision}')::bigint,p_proof#>'{read,basis}','review_required',
        jsonb_build_object('reason','dispute_amount_exceeds_ledger_gross','status',p_proof->>'status',
          'disputedCents',(p_proof->>'amount')::bigint,'paymentIntentId',p_event->>'paymentIntentId','chargeId',p_event->>'chargeId')) then
        status:='lifecycle_review_recorded';
      else status:='reconciliation_required'; end if;
    else
      status:=public.apply_exact_installment_dispute_event(p_reservation_id,p_event->>'id',p_event->>'objectId',
        (p_proof#>>'{read,revision}')::bigint,p_proof#>'{read,basis}',p_event->>'paymentIntentId',p_event->>'chargeId',
        (state#>>'{receipt,amountCents}')::bigint,(p_proof->>'amount')::bigint,p_proof->>'status',(p_event->>'created')::bigint);
    end if;
  end if;
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return jsonb_build_object('reservation_id',p_reservation_id,'event_id',p_event->>'id','status',status);
end;
$$;
revoke all on function public.read_exact_context_financial_event_v2(uuid,uuid,jsonb,jsonb),
  public.hold_exact_context_financial_event_v2(uuid,uuid,jsonb,jsonb),public.apply_exact_context_financial_event_v2(uuid,uuid,jsonb,jsonb,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_financial_event_v2(uuid,uuid,jsonb,jsonb),
  public.hold_exact_context_financial_event_v2(uuid,uuid,jsonb,jsonb),public.apply_exact_context_financial_event_v2(uuid,uuid,jsonb,jsonb,jsonb) to service_role;

-- Post-first-credit subscription observations reuse the existing 048 audit and
-- collection holds. No new table, payment/stop permission or hold release.
create function public.read_exact_context_subscription_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; a public.exact_installment_agreements%rowtype;
  op public.exact_installment_context_customer_operations_v2%rowtype; first public.exact_context_first_receipts_v2%rowtype;
  act public.exact_installment_activations%rowtype; dependencies jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Context subscription requires READ COMMITTED'; end if;
  select * into op from public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into first from public.exact_context_first_receipts_v2 where reservation_id=r.id;
  select ag.* into a from public.exact_installment_agreements ag join public.exact_context_accounting_links_v2 link
    on link.agreement_id=ag.id and link.booking_payment_id=ag.booking_payment_id where link.reservation_id=r.id for update of ag;
  if not found or a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',a.booking_payment_id) or
    a.first_fulfilled_at is null or a.stripe_checkout_session_id is distinct from first.session_id or
    not exists(select 1 from public.exact_context_customer_bindings_v2 b where b.operation_id=op.id and b.customer_id=a.stripe_customer_id) or
    not exists(select 1 from public.exact_installment_receipts rec where rec.agreement_id=a.id and rec.payment_number=1 and
      rec.stripe_payment_intent_id=first.payment_intent_id and rec.counted_at is not null and rec.amount_cents=first.amount_cents and
      rec.application_fee_cents=first.application_fee_cents and rec.paid_at=to_timestamp(first.paid_at)) then
    raise exception 'Owned fulfilled context subscription required'; end if;
  select jsonb_build_object('customerId',a.stripe_customer_id,'subscriptionId',a.stripe_subscription_id,
    'productId',product.provider_id,'anchor',step.anchor_seconds) into dependencies
    from public.exact_context_held_steps_v2 step join public.exact_context_held_results_v2 product on product.step_id=step.id
    where step.reservation_id=r.id and step.stage='product' and exists(
      select 1 from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
      where s.reservation_id=r.id and s.stage='subscription' and s.anchor_seconds=step.anchor_seconds and b.provider_id=a.stripe_subscription_id)
    and exists(select 1 from public.exact_context_held_steps_v2 s join public.exact_context_held_results_v2 b on b.step_id=s.id
      where s.reservation_id=r.id and s.stage='hold' and s.anchor_seconds=step.anchor_seconds and b.provider_id=a.stripe_subscription_id);
  if dependencies is null then raise exception 'Original held subscription binding required'; end if;
  select * into act from public.exact_installment_activations where agreement_id=a.id;
  return jsonb_build_object('reservation',to_jsonb(r),'operation',to_jsonb(op),'dependencies',dependencies,
    'firstReceipt',to_jsonb(first)-'reservation_id'-'recorded_at',
    'activation',jsonb_build_object('agreement_id',a.id,'payment_method_id',first.payment_method_id,
      'activation',case when act.agreement_id is null then null else to_jsonb(act) end),
    'lifecycle',public.read_exact_installment_lifecycle(a.id,a.stripe_subscription_id),
    'createdAt',floor(extract(epoch from a.created_at))::bigint,'agreementStatus',a.status);
end;
$$;

create function public.observe_exact_context_subscription_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,
  p_event jsonb,p_read jsonb,p_disposition text,p_details jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; saved boolean;
begin
  state:=public.read_exact_context_subscription_v2(p_reservation_id,p_actor_id,p_context);
  if jsonb_typeof(p_event) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_event))<>6 or
    not(p_event ?& array['id','type','subscriptionId','customerId','created','livemode']) or
    coalesce(p_event->>'id','')!~'^evt_[A-Za-z0-9]+$' or p_event->>'type' is null or p_event->>'type' not in (
      'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed') or
    p_event->>'subscriptionId' is distinct from state#>>'{dependencies,subscriptionId}' or
    p_event->>'customerId' is distinct from state#>>'{dependencies,customerId}' or
    p_event->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    jsonb_typeof(p_event->'created') is distinct from 'number' or (p_event->>'created')::numeric is distinct from trunc((p_event->>'created')::numeric) or
    (p_event->>'created')::numeric<floor(extract(epoch from (state#>>'{reservation,created_at}')::timestamptz)) or
    (p_event->>'created')::numeric>extract(epoch from clock_timestamp()) then raise exception 'Invalid owned subscription event'; end if;
  if jsonb_typeof(p_read) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_read))<>2 or
    not(p_read ?& array['revision','basis']) or jsonb_typeof(p_read->'revision') is distinct from 'number' or
    (p_read->>'revision')::numeric is distinct from trunc((p_read->>'revision')::numeric) or (p_read->>'revision')::numeric<0 or
    jsonb_typeof(p_read->'basis') is distinct from 'object' or p_disposition is null or p_disposition not in (
      'expected_held_schedule','billing_stop_observed','scheduled_end_observed','review_required') or
    jsonb_typeof(p_details) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_details))<>5 or
    not(p_details ?& array['status','cancelAt','canceledAt','endedAt','pauseBehavior']) or p_details->>'status' is null or
    p_details->>'status' not in ('trialing','active','past_due','canceled','unpaid','incomplete','incomplete_expired','paused','unknown') or
    jsonb_typeof(p_details->'pauseBehavior') not in ('string','null') or
    (p_details->>'pauseBehavior' is not null and p_details->>'pauseBehavior' not in ('keep_as_draft','void','mark_uncollectible','unknown')) or
    exists(select 1 from jsonb_each(p_details) e where e.key in ('cancelAt','canceledAt','endedAt') and e.value<>'null'::jsonb and
      (jsonb_typeof(e.value) is distinct from 'number' or e.value::text !~ '^[0-9]+$')) then raise exception 'Invalid subscription observation'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'financial_event');
  if p_disposition<>'expected_held_schedule' then
    perform public.hold_exact_installment_lifecycle_event(p_reservation_id,p_event->>'id',p_event->>'subscriptionId',null);
  end if;
  saved:=public.finish_exact_installment_lifecycle(p_reservation_id,p_event->>'id',p_event->>'subscriptionId',
    (p_read->>'revision')::bigint,p_read->'basis',p_disposition,p_details);
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return jsonb_build_object('reservationId',p_reservation_id,'eventId',p_event->>'id','saved',saved);
end;
$$;
revoke all on function public.read_exact_context_subscription_v2(uuid,uuid,jsonb),
  public.observe_exact_context_subscription_v2(uuid,uuid,jsonb,jsonb,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_subscription_v2(uuid,uuid,jsonb),
  public.observe_exact_context_subscription_v2(uuid,uuid,jsonb,jsonb,jsonb,text,jsonb) to service_role;
commit;
