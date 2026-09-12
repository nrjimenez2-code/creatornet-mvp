-- UNAPPLIED. Observe an already admitted renewal; never authorize another pay.
-- Reuses 049's hold, revision/basis comparison and original receipt accounting.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.read_exact_context_stop_v2(uuid,uuid,jsonb)') is null or
    to_regprocedure('public.run_exact_context_recovery_v2(uuid,uuid,jsonb,text,jsonb,text,jsonb,text,jsonb)') is not null then
    raise exception 'Context recovery prerequisites or collision'; end if;
end;
$preflight$;
alter table public.exact_context_sql_admissions_v2 drop constraint exact_context_sql_admissions_v2_operation_check;
alter table public.exact_context_sql_admissions_v2 add constraint exact_context_sql_admissions_v2_operation_check
  check(operation in ('first_credit','activation_claim','activation_complete','invoice_prepare','invoice_dispatch','invoice_credit','financial_event','billing_stop','invoice_recovery'));
do $guard_entries$
declare spec record; function_oid oid; source text; definition text; guarded text;
begin
  for spec in select * from (values
    ('begin_exact_installment_recovery','uuid,text','aa738019fab15063b51a7dc3d036d105551c39acdda83f55c3e519933c6c0d67'),
    ('finish_exact_installment_recovery','uuid,text,text,bigint,jsonb,text,text,jsonb','026f5d4857883ea9127bd6bfb8a827f210b01649ec52bd8dad2d428441e228e3')
  ) as entries(name,args,hash) loop
    function_oid:=to_regprocedure('public.'||spec.name||'('||spec.args||')');
    select prosrc into source from pg_proc where oid=function_oid and prosecdef and proowner=(select oid from pg_roles where rolname='postgres');
    if source is null or encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>spec.hash then
      raise exception 'Context recovery baseline differs: %',spec.name; end if;
    definition:=pg_get_functiondef(function_oid);
    guarded:=regexp_replace(source,E'\nbegin\r?\n',E'\nbegin\n  perform public.guard_exact_context_sql_entry_v2(p_agreement_id,'''||spec.name||E''');\n');
    if guarded=source then raise exception 'Context recovery guard insertion failed'; end if;
    execute replace(definition,source,guarded);
  end loop;
  function_oid:='public.guard_exact_context_sql_entry_v2(uuid,text)'::regprocedure;
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'8e6540b1a1aa95c9b6a3bb20498971ed49eac3574e69e2c8096a13a114e127c1' then
    raise exception 'Context recovery admission baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'raise exception ''Context-scoped payment entry required'';',
    'if operation=''invoice_recovery'' and p_entry in (''begin_exact_installment_recovery'',''finish_exact_installment_recovery'') then return; end if;
  raise exception ''Context-scoped payment entry required'';');
  if guarded=source then raise exception 'Context recovery admission insertion failed'; end if;
  execute replace(definition,source,guarded);
end;
$guard_entries$;

-- The server reads the actual Stripe event and present invoice/PI. Event fields
-- here are locators, not payment evidence. Only the original receipt can credit.
create function public.run_exact_context_recovery_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,
  p_event jsonb,p_phase text,p_read jsonb,p_outcome text,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare collection jsonb; snapshot jsonb; saved boolean:=false; retry_admitted boolean;
begin
  collection:=public.read_exact_context_invoice_collection_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id);
  if collection#>>'{state,claim,status}' is null or collection#>>'{state,claim,status}' not in ('dispatching','paid') or
    collection#>>'{state,claim,stripe_payment_intent_id}' is null or collection#>>'{state,claim,dispatch_started_at}' is null then
    raise exception 'Original admitted context recovery required'; end if;
  if jsonb_typeof(p_event) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_event))<>7 or
    not(p_event ?& array['id','type','invoiceId','customerId','subscriptionId','created','livemode']) or
    p_event->>'id' is null or p_event->>'id' !~ '^evt_[a-zA-Z0-9]+$' or
    p_event->>'type' is null or p_event->>'type' not in ('invoice.payment_failed','invoice.payment_action_required','invoice.voided',
      'invoice.marked_uncollectible','invoice.paid','invoice.payment_succeeded') or
    p_event->>'invoiceId' is distinct from p_invoice_id or
    p_event->>'customerId' is distinct from collection#>>'{authorization,customerId}' or
    p_event->>'subscriptionId' is distinct from collection#>>'{authorization,subscriptionId}' or
    p_event->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    jsonb_typeof(p_event->'created') is distinct from 'number' or (p_event->>'created')::numeric<1 or
    (p_event->>'created')::numeric is distinct from trunc((p_event->>'created')::numeric) or
    (p_event->>'created')::numeric>extract(epoch from clock_timestamp()) or
    p_phase is null or p_phase not in ('begin','finish') then raise exception 'Invalid owned recovery event'; end if;
  select exists(select 1 from public.exact_installment_retry_admissions where agreement_id=p_reservation_id and stripe_invoice_id=p_invoice_id)
    into retry_admitted;
  if p_phase='begin' then
    if p_read is distinct from 'null'::jsonb or p_evidence is distinct from 'null'::jsonb or p_outcome is not null then
      raise exception 'Unexpected recovery begin proof'; end if;
    -- Normal paid delivery without a recovery is the existing receipt route, not
    -- a new failed-payment hold. A stale failure still observes current payment.
    if p_event->>'type' in ('invoice.paid','invoice.payment_succeeded') and not exists(
      select 1 from public.exact_installment_payment_recoveries where agreement_id=p_reservation_id and stripe_invoice_id=p_invoice_id) then
      return jsonb_build_object('read',null,'retryAdmitted',retry_admitted,'saved',false); end if;
    insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'invoice_recovery');
    snapshot:=public.begin_exact_installment_recovery(p_reservation_id,p_invoice_id);
  else
    if retry_admitted then raise exception 'Replacement admission requires its separate receipt path'; end if;
    if jsonb_typeof(p_read) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_read))<>7 or
      not(p_read ?& array['revision','basis','paymentIntentId','subscriptionId','periodStart','periodEnd','dispatchStartedAt']) or
      p_read->>'paymentIntentId' is distinct from collection#>>'{state,claim,stripe_payment_intent_id}' or
      p_read->>'subscriptionId' is distinct from collection#>>'{authorization,subscriptionId}' or
      jsonb_typeof(p_read->'revision') is distinct from 'number' or
      (p_read->>'revision')::numeric is distinct from trunc((p_read->>'revision')::numeric) or
      (p_read->>'revision')::numeric<0 or
      p_read->'periodStart' is distinct from collection#>'{authorization,periodStart}' or
      p_read->'periodEnd' is distinct from collection#>'{authorization,periodEnd}' or
      p_read->'dispatchStartedAt' is distinct from to_jsonb(floor(extract(epoch from (collection#>>'{state,claim,dispatch_started_at}')::timestamptz))::bigint) or
      jsonb_typeof(p_evidence) is distinct from 'object' or (select count(*) from jsonb_object_keys(p_evidence))<>6 or
      not(p_evidence ?& array['invoiceStatus','paymentStatus','amountReceived','amountCapturable','canceledAt','voidedAt']) or
      jsonb_typeof(p_evidence->'invoiceStatus') is distinct from 'string' or
      p_evidence->>'invoiceStatus' not in ('open','paid','void','uncollectible') or
      jsonb_typeof(p_evidence->'paymentStatus') is distinct from 'string' or
      p_evidence->>'paymentStatus' not in ('requires_action','requires_payment_method','requires_confirmation','processing','requires_capture','canceled','succeeded') or
      exists(select 1 from jsonb_each(p_evidence) e where e.key in ('amountReceived','amountCapturable','canceledAt','voidedAt') and
        not(e.key in ('canceledAt','voidedAt') and e.value='null'::jsonb) and
        (jsonb_typeof(e.value) is distinct from 'number' or e.value::text !~ '^[0-9]+$')) then
      raise exception 'Invalid recovery comparison or evidence'; end if;
    insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'invoice_recovery');
    saved:=public.finish_exact_installment_recovery(p_reservation_id,p_invoice_id,p_read->>'paymentIntentId',
      (p_read->>'revision')::bigint,p_read->'basis',p_outcome,p_event->>'id',p_evidence);
    snapshot:=p_read;
  end if;
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return jsonb_build_object('read',snapshot,'retryAdmitted',retry_admitted,'saved',saved);
end;
$$;
revoke all on function public.run_exact_context_recovery_v2(uuid,uuid,jsonb,text,jsonb,text,jsonb,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.run_exact_context_recovery_v2(uuid,uuid,jsonb,text,jsonb,text,jsonb,text,jsonb) to service_role;
commit;
