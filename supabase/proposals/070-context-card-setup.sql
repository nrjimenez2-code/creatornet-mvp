-- UNAPPLIED. Buyer-consented SETUP only. Reuse 051 rows/eligibility; no debit,
-- default change, retry admission, future-card choice, credit or hold release.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.run_exact_context_recovery_v2(uuid,uuid,jsonb,text,jsonb,text,jsonb,text,jsonb)') is null or
    exists(select 1 from pg_attribute where attrelid='public.exact_installment_card_setups'::regclass and attname='context_mode' and not attisdropped) then
    raise exception 'Context card setup prerequisites or collision'; end if;
end;
$preflight$;
alter table public.exact_installment_card_setups add column context_mode text,
  add column context_dispatch_token uuid,add column context_dispatched_at timestamptz,add column context_request jsonb;
alter table public.exact_installment_card_setups drop constraint exact_installment_card_setups_stripe_checkout_session_id_check;
alter table public.exact_installment_card_setups add constraint exact_card_setup_context_shape check(coalesce(
  (context_mode is null and context_dispatch_token is null and context_dispatched_at is null and context_request is null) or
  (context_mode in ('test','live') and ((context_dispatch_token is null and context_dispatched_at is null and context_request is null) or
    (context_dispatch_token is not null and context_dispatched_at is not null and jsonb_typeof(context_request)='object'))),false)),
  add constraint exact_card_setup_session_mode check(coalesce(stripe_checkout_session_id is null or
    (coalesce(context_mode,'test')='test' and stripe_checkout_session_id ~ '^cs_test_[a-zA-Z0-9]+$') or
    (context_mode='live' and stripe_checkout_session_id ~ '^cs_[a-zA-Z0-9_]+$' and stripe_checkout_session_id !~ '^cs_test_'),false));
alter table public.exact_context_sql_admissions_v2 drop constraint exact_context_sql_admissions_v2_operation_check;
alter table public.exact_context_sql_admissions_v2 add constraint exact_context_sql_admissions_v2_operation_check
  check(operation in ('first_credit','activation_claim','activation_complete','invoice_prepare','invoice_dispatch','invoice_credit','financial_event','billing_stop','invoice_recovery','card_setup'));
do $guard_entries$
declare spec record; function_oid oid; source text; definition text; guarded text; agreement_expression text;
begin
  for spec in select * from (values
    ('assert_exact_card_setup_eligible','uuid,text,uuid','c082aa9b7e817d2916626bfb23526c64ba775b008897029efa13919b27dc60e8'),
    ('reserve_exact_card_setup','uuid,uuid,text,uuid,text','26eedcfb68ce791b0bc560443d7015581961a06a72baf1213b16f50a72cf1e0a'),
    ('read_current_exact_card_setup','uuid,uuid','c7d2b873dd1fd62f9eb444384bd0d3deeb609000fb0199ef6eac749b4cff00c2'),
    ('bind_exact_card_setup','uuid,uuid,text','69c7af64c62bb49f0827a767ab4cdff72bbf89cc14e749fe9f8824c31f6e359d'),
    ('verify_exact_card_setup','uuid,uuid,text,text,text','c18d4b32e2dca4cfcba92b04d7224277d405e8c805aa284abcb2585e55171c26')
  ) as entries(name,args,hash) loop
    function_oid:=to_regprocedure('public.'||spec.name||'('||spec.args||')');
    select prosrc into source from pg_proc where oid=function_oid and prosecdef and proowner=(select oid from pg_roles where rolname='postgres');
    if source is null or encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>spec.hash then
      raise exception 'Context card baseline differs: %',spec.name; end if;
    definition:=pg_get_functiondef(function_oid);
    agreement_expression:=case when spec.name in ('assert_exact_card_setup_eligible','reserve_exact_card_setup') then 'p_agreement_id'
      else '(select agreement_id from public.exact_installment_card_setups where id=p_id)' end;
    guarded:=regexp_replace(source,E'\nbegin\r?\n',E'\nbegin\n  perform public.guard_exact_context_sql_entry_v2('||agreement_expression||','''||spec.name||E''');\n');
    if guarded=source then raise exception 'Context card guard insertion failed'; end if;
    if spec.name='bind_exact_card_setup' then
      guarded:=replace(guarded,'p_session_id !~ ''^cs_test_[a-zA-Z0-9]+$''',
        '(case when saved.context_mode=''live'' then p_session_id !~ ''^cs_[a-zA-Z0-9_]+$'' or p_session_id ~ ''^cs_test_'' else p_session_id !~ ''^cs_test_[a-zA-Z0-9]+$'' end)');
    end if;
    execute replace(definition,source,guarded);
  end loop;
  function_oid:='public.guard_exact_context_sql_entry_v2(uuid,text)'::regprocedure;
  select prosrc into source from pg_proc where oid=function_oid;
  if encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex')<>'debe615f1cf85d995c6eec7a385fc68f69358d383927fa57d08ce4a32701f614' then
    raise exception 'Context card admission baseline differs'; end if;
  definition:=pg_get_functiondef(function_oid);
  guarded:=replace(source,'raise exception ''Context-scoped payment entry required'';',
    'if operation=''card_setup'' and p_entry in (''assert_exact_card_setup_eligible'',''reserve_exact_card_setup'',''read_current_exact_card_setup'',
      ''bind_exact_card_setup'',''verify_exact_card_setup'',''claim_exact_installment_invoice'') then return; end if;
  raise exception ''Context-scoped payment entry required'';');
  if guarded=source then raise exception 'Context card admission insertion failed'; end if;
  execute replace(definition,source,guarded);
end;
$guard_entries$;

create function public.read_exact_context_card_setup_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; op public.exact_installment_context_customer_operations_v2%rowtype;
  collection jsonb; dependencies jsonb; saved public.exact_installment_card_setups%rowtype;
begin
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  if not found or p_actor_id is null or r.terms->>'buyerId' is distinct from p_actor_id::text or p_request_id is null then
    raise exception 'Owned buyer card setup required'; end if;
  select * into op from public.read_exact_customer_operation_v2(r.id,(r.terms->>'creatorId')::uuid,p_context);
  collection:=public.read_exact_context_invoice_collection_v2(r.id,(r.terms->>'creatorId')::uuid,p_context,p_invoice_id);
  select jsonb_build_object('customerId',collection#>>'{authorization,customerId}','subscriptionId',collection#>>'{authorization,subscriptionId}',
    'productId',result.provider_id,'anchor',step.anchor_seconds) into dependencies from public.exact_context_held_steps_v2 step
    join public.exact_context_held_results_v2 result on result.step_id=step.id where step.reservation_id=r.id and step.stage='product';
  if dependencies is null then raise exception 'Context held product missing'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),r.id,'card_setup');
  perform public.assert_exact_card_setup_eligible(r.id,p_invoice_id,p_actor_id);
  select * into saved from public.exact_installment_card_setups where stripe_invoice_id=p_invoice_id;
  if found then
    if saved.id is distinct from p_request_id or saved.agreement_id is distinct from r.id or saved.buyer_id is distinct from p_actor_id or
      saved.context_mode is distinct from p_context->>'mode' then raise exception 'Context card request differs; no adoption'; end if;
    saved:=public.read_current_exact_card_setup(p_request_id,p_actor_id);
  end if;
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=r.id;
  return jsonb_build_object('reservation',to_jsonb(r),'operation',to_jsonb(op),'collection',collection,'dependencies',dependencies,
    'setup',case when saved.id is null then null else to_jsonb(saved) end);
end;
$$;

create function public.run_exact_context_card_setup_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_invoice_id text,p_request_id uuid,
  p_phase text,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; saved public.exact_installment_card_setups%rowtype; metadata jsonb; params jsonb;
  return_url text; dispatched boolean:=false; token uuid; key text;
begin
  state:=public.read_exact_context_card_setup_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id,p_request_id);
  if p_phase is null or p_phase not in ('reserve','claim','bind','verify') then raise exception 'Invalid context card phase'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),p_reservation_id,'card_setup');
  if p_phase='reserve' then
    if p_proof is distinct from '{"accepted":true,"consentVersion":"replacement-card-setup-v1"}'::jsonb then raise exception 'Explicit save-card consent required'; end if;
    saved:=public.reserve_exact_card_setup(p_request_id,p_reservation_id,p_invoice_id,p_actor_id,'replacement-card-setup-v1');
    update public.exact_installment_card_setups set context_mode=p_context->>'mode' where id=saved.id and context_mode is null;
  else
    saved:=public.read_current_exact_card_setup(p_request_id,p_actor_id);
    if saved.context_mode is distinct from p_context->>'mode' then raise exception 'Context mode differs'; end if;
    if p_phase='claim' then
      if p_proof is distinct from 'null'::jsonb then raise exception 'Unexpected card claim proof'; end if;
      if saved.context_dispatch_token is null then
        if saved.stripe_checkout_session_id is not null or saved.expires_at-extract(epoch from clock_timestamp())<1860 then
          raise exception 'Card creation window expired'; end if;
        metadata:=jsonb_build_object('card_setup_version','replacement-card-setup-v1','card_setup_request_id',saved.id,
          'installment_plan_id',p_reservation_id,'installment_collection_version',state#>>'{reservation,terms,version}',
          'context_hash',state#>>'{operation,context_hash}','terms_hash',state#>>'{operation,terms_hash}');
        return_url:=(p_context->>'siteOrigin')||'/payments/recovery/'||p_reservation_id::text;
        params:=jsonb_build_object('mode','setup','ui_mode','hosted','customer',saved.authorization_snapshot->>'customerId',
          'client_reference_id',saved.id,'payment_method_types',jsonb_build_array('card'),'expires_at',saved.expires_at,
          'success_url',return_url,'cancel_url',return_url,'metadata',metadata,'setup_intent_data',jsonb_build_object('metadata',metadata),
          'custom_text',jsonb_build_object('submit',jsonb_build_object('message','Save a replacement card for this installment plan. Saving does not make a payment, replace the currently authorized card, or restart automatic collection. You must separately confirm a payment before CreatorNet attempts it.')));
        token:=gen_random_uuid(); key:='cn-exact-v2-card:'||saved.id::text||':'||token::text;
        update public.exact_installment_card_setups set context_dispatch_token=token,context_dispatched_at=clock_timestamp(),
          context_request=jsonb_build_object('params',params,'idempotencyKey',key) where id=saved.id;
        dispatched:=true;
      end if;
    else
      if saved.context_dispatch_token is null or jsonb_typeof(p_proof) is distinct from 'object' or
        p_proof->>'token' is distinct from saved.context_dispatch_token::text then raise exception 'Original card dispatch required'; end if;
      if p_phase='bind' then
        if (select count(*) from jsonb_object_keys(p_proof))<>2 or not(p_proof ?& array['token','sessionId']) then raise exception 'Invalid setup binding'; end if;
        perform public.bind_exact_card_setup(saved.id,p_actor_id,p_proof->>'sessionId');
      else
        if (select count(*) from jsonb_object_keys(p_proof))<>4 or not(p_proof ?& array['token','sessionId','setupIntentId','paymentMethodId']) then
          raise exception 'Invalid saved-card proof'; end if;
        perform public.verify_exact_card_setup(saved.id,p_actor_id,p_proof->>'sessionId',p_proof->>'setupIntentId',p_proof->>'paymentMethodId');
      end if;
    end if;
  end if;
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=p_reservation_id;
  return jsonb_build_object('dispatched',dispatched,'state',public.read_exact_context_card_setup_v2(p_reservation_id,p_actor_id,p_context,p_invoice_id,p_request_id));
end;
$$;
revoke all on function public.read_exact_context_card_setup_v2(uuid,uuid,jsonb,text,uuid),
  public.run_exact_context_card_setup_v2(uuid,uuid,jsonb,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_exact_context_card_setup_v2(uuid,uuid,jsonb,text,uuid),
  public.run_exact_context_card_setup_v2(uuid,uuid,jsonb,text,uuid,text,jsonb) to service_role;
commit;
