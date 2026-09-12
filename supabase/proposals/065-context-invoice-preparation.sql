-- UNAPPLIED: connect existing invoice claims/unpaid preparation only.
-- No dispatch admission, pay, receipt credit, automatic collection or backfill.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.read_exact_context_activation_v2(uuid,uuid,jsonb)') is null or
    to_regprocedure('public.read_exact_context_invoice_v2(uuid,uuid,jsonb,text)') is not null then
    raise exception 'Context invoice prerequisites or collision'; end if;
end;
$preflight$;

alter table public.exact_context_sql_admissions_v2 drop constraint exact_context_sql_admissions_v2_operation_check;
alter table public.exact_context_sql_admissions_v2 add constraint exact_context_sql_admissions_v2_operation_check
  check(operation in ('first_credit','activation_claim','activation_complete','invoice_prepare'));

do $guard_existing_entries$
declare spec record; function_oid oid; source text; definition text; guarded text;
begin
  for spec in select * from (values
    ('claim_exact_installment_invoice','uuid,text,text,bigint,bigint,uuid','10b0f905531cca9494835ce4a852c1aeb504a124574bf0fe9642350038d5ef04'),
    ('prepare_exact_installment_dispatch','uuid,text,text,uuid','455954b7af325efe92abf6cac0ac00c186d282b2de3bbea367962cbc8853e65c'),
    ('admit_exact_installment_dispatch','uuid,text,uuid','f6f3b8431ba8dc79e456a0eb157310c769edcc4864153d59188fac6f68e4c50e')
  ) as entries(name,args,hash) loop
    function_oid:=to_regprocedure('public.'||spec.name||'('||spec.args||')');
    select prosrc into source from pg_proc where oid=function_oid and prosecdef and proowner=(select oid from pg_roles where rolname='postgres');
    if source is null or encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>spec.hash then
      raise exception 'Context invoice entry baseline differs: %',spec.name; end if;
    definition:=pg_get_functiondef(function_oid);
    guarded:=regexp_replace(source,E'\nbegin\r?\n',E'\nbegin\n  perform public.guard_exact_context_sql_entry_v2(p_agreement_id,'''||spec.name||E''');\n');
    if guarded=source then raise exception 'Context invoice entry insertion failed'; end if;
    execute replace(definition,source,guarded);
  end loop;
  function_oid:='public.guard_exact_context_sql_entry_v2(uuid,text)'::regprocedure;
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'3b47469cb288afba02a7d99b9f66b6808b9a4caad4c0f1ac0a3f6eb2647de79e' then
    raise exception 'Context admission baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'raise exception ''Context-scoped payment entry required'';',
    'if operation=''invoice_prepare'' and p_entry in (''claim_exact_installment_invoice'',''prepare_exact_installment_dispatch'') then return; end if;
  raise exception ''Context-scoped payment entry required'';');
  if guarded=source then raise exception 'Context invoice admission insertion failed'; end if;
  execute replace(definition,source,guarded);
  -- admit_exact_installment_dispatch intentionally has NO v2 permission here.
end;
$guard_existing_entries$;

create function public.read_exact_context_invoice_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare activation jsonb; a public.exact_installment_agreements%rowtype;
  receipt public.exact_context_first_receipts_v2%rowtype; claim public.exact_installment_invoice_claims%rowtype;
begin
  if p_invoice_id is null or p_invoice_id!~'^in_[a-zA-Z0-9]+$' then raise exception 'Invalid context invoice identity'; end if;
  activation:=public.read_exact_context_activation_v2(p_reservation_id,p_actor_id,p_context);
  if activation#>>'{activation,status}' is distinct from 'complete' then raise exception 'Completed context activation required'; end if;
  select * into a from public.exact_installment_agreements where id=p_reservation_id;
  select * into receipt from public.exact_context_first_receipts_v2 where reservation_id=p_reservation_id;
  select * into claim from public.exact_installment_invoice_claims where agreement_id=p_reservation_id and stripe_invoice_id=p_invoice_id;
  return jsonb_build_object('agreement_id',a.id,'booking_payment_id',a.booking_payment_id,'activation',activation,
    'first_receipt',to_jsonb(receipt)-'reservation_id'-'recorded_at',
    'periods',coalesce((select jsonb_agg(to_jsonb(p) order by p.payment_number) from public.exact_installment_periods p where p.agreement_id=a.id),'[]'::jsonb),
    'claim',case when claim.agreement_id is null then null else to_jsonb(claim) end);
end;
$$;

create function public.claim_exact_context_invoice_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,
  p_subscription_id text,p_period_start bigint,p_period_end bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb; token uuid:=gen_random_uuid();
begin
  perform public.read_exact_context_invoice_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id);
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'invoice_prepare');
  result:=public.claim_exact_installment_invoice(p_reservation_id,p_invoice_id,p_subscription_id,p_period_start,p_period_end,token);
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return jsonb_build_object('claim',result,'state',public.read_exact_context_invoice_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id));
end;
$$;

create function public.assert_exact_context_invoice_preparation_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,p_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; claim public.exact_installment_invoice_claims%rowtype;
begin
  state:=public.read_exact_context_invoice_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id);
  select * into claim from public.exact_installment_invoice_claims where agreement_id=p_reservation_id and stripe_invoice_id=p_invoice_id for update;
  if not found or claim.status not in ('preparing','prepared') or claim.claim_token is distinct from p_token or
    claim.lease_until<=now() or claim.first_started_at+interval '20 hours'<=now() then
    raise exception 'Context invoice preparation claim lost'; end if;
  perform public.assert_exact_installment_renewal_ready(p_reservation_id,claim.payment_number);
  return state;
end;
$$;

create function public.bind_exact_context_invoice_preparation_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,
  p_token uuid,p_payment_intent_id text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform public.assert_exact_context_invoice_preparation_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id,p_token);
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'invoice_prepare');
  perform public.prepare_exact_installment_dispatch(p_reservation_id,p_invoice_id,p_payment_intent_id,p_token);
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return public.read_exact_context_invoice_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id);
end;
$$;

revoke all on function public.read_exact_context_invoice_v2(uuid,uuid,jsonb,text),
  public.claim_exact_context_invoice_v2(uuid,uuid,jsonb,text,text,bigint,bigint),
  public.assert_exact_context_invoice_preparation_v2(uuid,uuid,jsonb,text,uuid),
  public.bind_exact_context_invoice_preparation_v2(uuid,uuid,jsonb,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_invoice_v2(uuid,uuid,jsonb,text),
  public.claim_exact_context_invoice_v2(uuid,uuid,jsonb,text,text,bigint,bigint),
  public.assert_exact_context_invoice_preparation_v2(uuid,uuid,jsonb,text,uuid),
  public.bind_exact_context_invoice_preparation_v2(uuid,uuid,jsonb,text,uuid,text) to service_role;
commit;
