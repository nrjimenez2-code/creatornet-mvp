begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

-- Reuse the existing intent/confirmation journal. No shadow checkout attempt,
-- hosted session, provider operation, receipt or access is created here.
do $preflight$ begin
  if current_user<>'postgres' or to_regclass('public.monthly_manual_payment_selections_v1') is null or
    to_regprocedure('public.claim_server_confirmation_v1(uuid,uuid,jsonb,jsonb,jsonb)') is null or
    to_regprocedure('public.read_nonmonthly_server_payment_source_v1(uuid,uuid,jsonb,boolean)') is not null then
    raise exception 'Monthly manual journal prerequisites differ'; end if;
end $preflight$;

alter table public.server_payment_protocols_v1 drop constraint server_payment_protocols_v1_kind_check;
alter table public.server_payment_protocols_v1 drop constraint server_payment_protocols_v1_check;
alter table public.server_payment_protocols_v1 add constraint server_payment_protocols_v1_kind_check
  check(kind in ('full','first_installment','monthly_first','monthly_payoff'));
alter table public.server_payment_protocols_v1 add constraint server_payment_protocols_v1_check
  check((kind in ('full','monthly_first','monthly_payoff') and reservation_id is null) or
    (kind='first_installment' and reservation_id is not null));

-- Preserve the exact composed old validators. Keep the public entry-point OIDs
-- stable with CREATE OR REPLACE; do not rename them or redirect cached callers.
do $copy$
declare body text; name text; suffix text;
begin
  foreach name in array array['read_server_payment_source_v1','validate_server_payment_contract_v1'] loop
    suffix:=case when name='read_server_payment_source_v1' then '(uuid,uuid,jsonb,boolean)' else '(uuid,uuid,jsonb,jsonb,jsonb)' end;
    body:=pg_get_functiondef(('public.'||name||suffix)::regprocedure);
    if (length(body)-length(replace(body,'FUNCTION public.'||name||'(','')))/length('FUNCTION public.'||name||'(')<>1 then
      raise exception 'Original server validator definition differs'; end if;
    execute replace(body,'FUNCTION public.'||name||'(','FUNCTION public.'||replace(name,'server_payment','nonmonthly_server_payment')||'(');
  end loop;
end $copy$;
revoke all on function public.read_nonmonthly_server_payment_source_v1(uuid,uuid,jsonb,boolean),
  public.validate_nonmonthly_server_payment_contract_v1(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.register_monthly_manual_source_v1(p_selection_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare m public.monthly_manual_payment_selections_v1%rowtype;
  a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype;
  s public.server_payment_protocols_v1%rowtype; expected jsonb;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh monthly source required'; end if;
  select * into m from public.monthly_manual_payment_selections_v1 where id=p_selection_id and buyer_id=p_buyer_id;
  if not found then raise exception 'Owned monthly selection unavailable'; end if;
  expected:=jsonb_build_object('version','exact-payment-context-v1','mode',m.context->>'mode',
    'platformAccountId',m.context->>'stripeAccountId','supabaseProjectRef',m.context->>'supabaseProjectRef','siteOrigin',m.context->>'siteOrigin');
  if p_context is distinct from expected or m.context->>'apiVersion' is distinct from '2025-10-29.clover' then
    raise exception 'Monthly source context differs'; end if;
  perform pg_advisory_xact_lock(hashtextextended(m.buyer_id::text||':'||(m.source->>'productId'),72913));
  select * into a from public.monthly_mentorship_agreements_v1 where id=m.agreement_id for update;
  if not found or a.buyer_id is distinct from m.buyer_id or a.product_id::text is distinct from m.source->>'productId' or
    a.terms->'paymentContext' is distinct from m.context then raise exception 'Monthly source ownership differs'; end if;
  select * into s from public.server_payment_protocols_v1 where attempt_id=m.id;
  if found then
    if s.buyer_id is distinct from m.buyer_id or s.product_id is distinct from a.product_id or s.context is distinct from p_context or
      s.kind is distinct from 'monthly_'||m.kind or s.source is distinct from to_jsonb(m) then raise exception 'Original monthly journal source differs'; end if;
    return to_jsonb(s);
  end if;
  -- A frozen selection remains readable after abandonment, but it must not
  -- acquire a new payment protocol once the agreement has begun closing.
  if a.initial_abandon_requested_at is not null or a.initial_abandoned_at is not null then
    raise exception 'Monthly manual source is closing or abandoned'; end if;
  if a.revision::text is distinct from m.source->>'revision' or a.financial_hold_at is not null or
    a.debit_revoked_at is not null or a.billing_review_at is not null or
    (m.source->>'expiresAt')::bigint<=floor(extract(epoch from clock_timestamp())) then
    raise exception 'Monthly manual source changed or expired before registration'; end if;
  if m.kind='payoff' then
    select * into pf from public.monthly_mentorship_payoffs_v1
      where id=m.payoff_id and agreement_id=a.id for update;
    if not found or pf.buyer_id is distinct from p_buyer_id or pf.status<>'accepted' or
      pf.checkout_request is not null or pf.checkout_dispatched_at is not null or
      pf.stripe_checkout_session_id is not null or pf.ledger_id is not null or
      pf.provider_proof is not null or pf.fingerprint is distinct from m.source->>'sourceFingerprint' or
      pf.first_unpaid_month<>a.covered_months+1 or a.payoff_hold_at is null then
      raise exception 'Original monthly payoff requires recovery'; end if;
  end if;
  if not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Monthly manual context is not pinned'; end if;
  insert into public.server_payment_protocols_v1(attempt_id,buyer_id,product_id,context,kind,source)
    values(m.id,m.buyer_id,a.product_id,p_context,'monthly_'||m.kind,to_jsonb(m)) returning * into s;
  return to_jsonb(s);
end $$;
revoke all on function public.register_monthly_manual_source_v1(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.register_monthly_manual_source_v1(uuid,uuid,jsonb) to service_role;

create or replace function public.read_server_payment_source_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_for_dispatch boolean)
returns public.server_payment_protocols_v1 language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; m public.monthly_manual_payment_selections_v1%rowtype;
  a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype;
begin
  select * into s from public.server_payment_protocols_v1 where attempt_id=p_attempt_id;
  if not found or s.kind not in ('monthly_first','monthly_payoff') then
    return public.read_nonmonthly_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,p_for_dispatch);
  end if;
  if current_setting('transaction_isolation')<>'read committed' or p_for_dispatch is null or
    s.buyer_id is distinct from p_buyer_id or s.context is distinct from p_context then raise exception 'Owned monthly journal source unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.buyer_id::text||':'||s.product_id::text,72913));
  select * into m from public.monthly_manual_payment_selections_v1 where id=s.attempt_id;
  if not found or s.source is distinct from to_jsonb(m) or s.kind is distinct from 'monthly_'||m.kind then
    raise exception 'Original monthly selection differs'; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=m.agreement_id for update;
  if not found or a.buyer_id is distinct from s.buyer_id or a.product_id is distinct from s.product_id or
    a.fingerprint is distinct from m.source->>'agreementFingerprint' then raise exception 'Monthly source ownership differs'; end if;
  if not p_for_dispatch then return s; end if;
  if exists(select 1 from public.server_payment_stops_v1 where attempt_id=s.attempt_id) or
    not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) or
    a.revision::text is distinct from m.source->>'revision' or a.financial_hold_at is not null or
    a.debit_revoked_at is not null or a.billing_review_at is not null or a.initial_abandon_requested_at is not null or
    a.initial_abandoned_at is not null or (m.source->>'expiresAt')::bigint<=floor(extract(epoch from clock_timestamp())) then
    raise exception 'Monthly manual dispatch is stopped, changed or expired'; end if;
  if m.kind='first' then
    if a.covered_months<>0 or a.anchor_at is not null or a.stripe_checkout_session_id is not null or
      a.renewal_stopped_at is not null or a.payoff_hold_at is not null or
      exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind in ('checkout','activate','collect')) or
      exists(select 1 from public.monthly_mentorship_receipts_v1 where agreement_id=a.id) or
      exists(select 1 from public.payment_fee_ledger where purchase_id=a.purchase_id) then
      raise exception 'Monthly first payment requires original reconciliation'; end if;
  else
    select * into pf from public.monthly_mentorship_payoffs_v1 where id=m.payoff_id and agreement_id=a.id for update;
    if not found or pf.status<>'accepted' or pf.checkout_request is not null or pf.checkout_dispatched_at is not null or
      pf.stripe_checkout_session_id is not null or pf.ledger_id is not null or a.payoff_hold_at is null or
      pf.fingerprint is distinct from m.source->>'sourceFingerprint' or pf.first_unpaid_month<>a.covered_months+1 then
      raise exception 'Monthly payoff requires original reconciliation'; end if;
  end if;
  return s;
end $$;

create or replace function public.validate_server_payment_contract_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,p_contract jsonb,p_request jsonb)
returns void language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; m public.monthly_manual_payment_selections_v1%rowtype;
  a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype;
  customer public.monthly_mentorship_operations_v1%rowtype; product public.monthly_mentorship_operations_v1%rowtype;
  sub public.monthly_mentorship_operations_v1%rowtype; hold public.monthly_mentorship_operations_v1%rowtype;
  customer_id text; subscription_id text; fees jsonb; metadata jsonb; schedule jsonb; expected jsonb; params jsonb;
  amount bigint; platform bigint; processing bigint;
begin
  select * into s from public.server_payment_protocols_v1 where attempt_id=p_attempt_id;
  if not found or s.kind not in ('monthly_first','monthly_payoff') then
    perform public.validate_nonmonthly_server_payment_contract_v1(p_attempt_id,p_buyer_id,p_context,p_contract,p_request);return;
  end if;
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,true);
  select * into m from public.monthly_manual_payment_selections_v1 where id=s.attempt_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=m.agreement_id;
  if m.kind='first' then
    select * into customer from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='customer' and scope_key='initial';
    select * into product from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='product' and scope_key='initial';
    select * into sub from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='subscription' and scope_key='initial';
    select * into hold from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='hold' and scope_key='initial';
    if customer.status is distinct from 'complete' or product.status is distinct from 'complete' or
      sub.status is distinct from 'complete' or hold.status is distinct from 'complete' or sub.provider_id is distinct from hold.provider_id or
      (a.stripe_customer_id is not null and a.stripe_customer_id is distinct from customer.provider_id) or
      (a.stripe_subscription_id is not null and a.stripe_subscription_id is distinct from sub.provider_id) or
      customer.provider_id is distinct from sub.request#>>'{params,customer}' or
      product.provider_id is distinct from sub.request#>>'{params,items,0,price_data,product}' or
      sub.request#>>'{params,items,0,price_data,unit_amount}' is distinct from a.monthly_price_cents::text or
      hold.request is distinct from jsonb_build_object('method','POST','path','/v1/subscriptions/'||sub.provider_id,
        'params',jsonb_build_object('pause_collection',jsonb_build_object('behavior','keep_as_draft'))) then
      raise exception 'Original monthly held preparation is incomplete'; end if;
    customer_id:=customer.provider_id;subscription_id:=sub.provider_id;fees:=a.terms->'firstMonthFees';
  else
    select * into pf from public.monthly_mentorship_payoffs_v1 where id=m.payoff_id;
    customer_id:=a.stripe_customer_id;subscription_id:=a.stripe_subscription_id;fees:=pf.terms->'fees';
  end if;
  if coalesce(customer_id,'')!~'^cus_[A-Za-z0-9]+$' or coalesce(subscription_id,'')!~'^sub_[A-Za-z0-9]+$' then
    raise exception 'Original monthly customer/subscription missing'; end if;
  amount:=(m.source->>'amountCents')::bigint;
  schedule:=jsonb_build_object('enabled',fees->'processingFeeEnabled','basisPoints',fees->'processingFeeBasisPoints',
    'fixedCents',fees->'processingFeeFixedCents','version',fees->'feeScheduleVersion');
  platform:=round(amount::numeric*1200/10000)::bigint;
  processing:=case when (schedule->>'enabled')::boolean then round(amount::numeric*(schedule->>'basisPoints')::bigint/10000)::bigint+(schedule->>'fixedCents')::bigint else 0 end;
  if amount is null or amount not between 50 and 99999999 or jsonb_typeof(schedule->'enabled') is distinct from 'boolean' or
    coalesce(schedule->>'basisPoints','')!~'^[0-9]{1,5}$' or (schedule->>'basisPoints')::bigint>10000 or
    coalesce(schedule->>'fixedCents','')!~'^[0-9]{1,8}$' or length(coalesce(schedule->>'version','')) not between 1 and 200 or
    coalesce(a.terms->>'destinationId','')!~'^acct_[A-Za-z0-9]+$' or
    fees->'grossAmountCents' is distinct from to_jsonb(amount) or fees->'platformFeeCents' is distinct from to_jsonb(platform) or
    fees->'processingFeeCents' is distinct from to_jsonb(processing) or fees->'totalCreatorDeductionCents' is distinct from to_jsonb(platform+processing) or
    fees->'creatorNetCents' is distinct from to_jsonb(amount-platform-processing) or platform+processing>amount then
    raise exception 'Accepted monthly fee snapshot differs'; end if;
  metadata:=jsonb_build_object('creatornet_membership_version','monthly-mentorship-stripe-v1','creatornet_membership_id',a.id::text,
    'creatornet_membership_fingerprint',a.fingerprint,'buyer_id',a.buyer_id::text,'creator_id',a.creator_id::text,
    'product_id',a.product_id::text,'post_id',a.post_id::text,'creator_stripe_account_id',a.terms->>'destinationId',
    'kind','monthly_mentorship','operation_kind',case when m.kind='first' then 'manual_first' else 'payoff' end,
    'fee_gross_cents',amount::text,'platform_fee_cents',platform::text,'processing_fee_cents',processing::text,
    'total_creator_deduction_cents',(platform+processing)::text,'creator_net_cents',(amount-platform-processing)::text,
    'processing_fee_enabled',schedule->>'enabled','processing_fee_bps',case when (schedule->>'enabled')::boolean then schedule->>'basisPoints' else '0' end,
    'processing_fee_fixed_cents',case when (schedule->>'enabled')::boolean then schedule->>'fixedCents' else '0' end,'fee_schedule_version',schedule->>'version');
  if m.kind='first' then metadata:=metadata||jsonb_build_object('membership_subscription_id',subscription_id);
  else metadata:=metadata||jsonb_build_object('creatornet_membership_payoff_id',m.payoff_id::text,'creatornet_membership_payoff_fingerprint',pf.fingerprint);end if;
  expected:=jsonb_build_object('protocol',s.protocol,'attemptId',s.attempt_id::text,'buyerId',a.buyer_id::text,'creatorId',a.creator_id::text,
    'productId',a.product_id::text,'termsFingerprint',m.source->>'sourceFingerprint','context',p_context,'customerId',customer_id,
    'destinationId',a.terms->>'destinationId','amountCents',amount,'processingFees',schedule,'kind',s.kind,'sourceMetadata',metadata,
    'acceptedAt',m.source->'acceptedAt','expiresAt',m.source->'expiresAt');
  params:=jsonb_build_object('amount',amount,'currency','usd','confirm',false,'confirmation_method','manual','capture_method','automatic_async',
    'payment_method_types',jsonb_build_array('card'),'customer',customer_id,'application_fee_amount',platform+processing,
    'transfer_data',jsonb_build_object('destination',a.terms->>'destinationId'),
    'metadata',metadata||jsonb_build_object('server_payment_protocol',s.protocol,'server_payment_attempt_id',s.attempt_id::text,
      'server_payment_terms',m.source->>'sourceFingerprint'));
  if m.kind='first' then params:=params||jsonb_build_object('setup_future_usage','off_session');end if;
  if p_contract is distinct from expected or p_request is distinct from jsonb_build_object('apiVersion','2025-10-29.clover',
    'method','POST','path','/v1/payment_intents','params',params) then raise exception 'Original monthly manual contract or request differs';end if;
end $$;

do $return_path$
declare body text; needle text:=$old$||'/purchase/payment/return?attempt='||p_attempt_id::text$old$;
begin
  body:=pg_get_functiondef('public.claim_server_confirmation_v1(uuid,uuid,jsonb,jsonb,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'Original confirmation return path differs';end if;
  execute replace(body,needle,$new$||(case when original.contract->>'kind' in ('monthly_first','monthly_payoff')
    then '/memberships/payment/return?attempt=' else '/purchase/payment/return?attempt=' end)||p_attempt_id::text$new$);
end $return_path$;
commit;
