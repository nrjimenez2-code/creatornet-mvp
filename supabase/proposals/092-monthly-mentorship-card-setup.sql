-- UNAPPLIED. Locked steps 1/4/5/8. Setup-only, never payment permission.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regclass('public.monthly_mentorship_renewal_recoveries_v1') is null or
    to_regclass('public.monthly_mentorship_card_setups_v1') is not null then raise exception 'Monthly card setup prerequisites differ'; end if;
end; $preflight$;
create table public.monthly_mentorship_card_setups_v1 (
  id uuid primary key, operation_id uuid not null references public.monthly_mentorship_operations_v1(id),
  agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id), buyer_id uuid not null,
  snapshot jsonb not null, consent_version text not null, consent_text text not null,
  created_at bigint not null, expires_at bigint not null check(expires_at>created_at and expires_at<=created_at+3600),
  request jsonb not null, dispatch_started_at timestamptz,
  session_id text unique, session_proof jsonb, setup_intent_id text unique, payment_method_id text,
  verified_at timestamptz, setup_proof jsonb, closed_at timestamptz,
  check((session_id is null and session_proof is null) or (session_id ~ '^cs_[A-Za-z0-9_]+$' and session_proof is not null and dispatch_started_at is not null)),
  check((verified_at is null and setup_intent_id is null and payment_method_id is null and setup_proof is null) or
    (verified_at is not null and session_id is not null and setup_intent_id ~ '^seti_[A-Za-z0-9]+$' and payment_method_id ~ '^pm_[A-Za-z0-9]+$' and setup_proof is not null))
);
create unique index monthly_card_setup_active_v1 on public.monthly_mentorship_card_setups_v1(operation_id) where closed_at is null;
alter table public.monthly_mentorship_card_setups_v1 enable row level security;
revoke all on public.monthly_mentorship_card_setups_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_card_setups_v1 to service_role;

create function public.monthly_card_setup_basis_v1(p_operation uuid,p_buyer uuid,p_context jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; r public.monthly_mentorship_renewal_recoveries_v1%rowtype;
  o public.monthly_mentorship_operations_v1%rowtype; v_id uuid; v_now bigint:=floor(extract(epoch from clock_timestamp()))::bigint;
begin
  select agreement_id into v_id from public.monthly_mentorship_operations_v1 where id=p_operation;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id and buyer_id=p_buyer for update;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Monthly card setup owner differs'; end if;
  select * into o from public.monthly_mentorship_operations_v1 where id=p_operation and agreement_id=a.id for update;
  select * into r from public.monthly_mentorship_renewal_recoveries_v1 where operation_id=o.id for update;
  if r.operation_id is null or o.kind<>'collect' or o.status<>'review_required' or r.outcome<>'payment_method_required' or
    r.month_number<>a.covered_months+1 or r.latest_observation->>'paymentStatus' is distinct from 'requires_payment_method' or
    (r.latest_observation->>'observedAt')::bigint<v_now-60 or (r.latest_observation->>'observedAt')::bigint>v_now+1 or
    (r.latest_observation->>'periodStart')::bigint>v_now or (r.latest_observation->>'periodEnd')::bigint<=v_now or
    a.financial_hold_at is not null or a.debit_revoked_at is not null or a.renewal_stopped_at is not null or
    exists(select 1 from public.payment_fee_ledger where stripe_invoice_id=r.invoice_id or stripe_payment_intent_id=r.payment_intent_id) or
    exists(select 1 from public.monthly_mentorship_receipts_v1 mr join public.payment_fee_ledger l on l.id=mr.ledger_id
      where mr.agreement_id=a.id and (l.status<>'paid' or l.refunded_amount_cents<>0 or
        (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')))) then
    raise exception 'Monthly card setup requires a fresh eligible unpaid attempt'; end if;
  if (a.billing_review_at is not null and not exists(select 1 from public.monthly_mentorship_lifecycle_v1 e
    where e.event_id=a.billing_review_reason and e.agreement_id=a.id and e.object_id=r.invoice_id and
      e.event_type in ('invoice.payment_failed','invoice.payment_action_required'))) or
    exists(select 1 from public.monthly_mentorship_lifecycle_v1 e where e.agreement_id=a.id and e.outcome='review_required' and
      (e.object_id<>r.invoice_id or e.event_type not in ('invoice.payment_failed','invoice.payment_action_required'))) then
    raise exception 'Unrelated monthly billing review cannot authorize card setup'; end if;
  return jsonb_build_object('membershipId',a.id,'operationId',o.id,'invoiceId',r.invoice_id,'paymentIntentId',r.payment_intent_id,
    'customerId',a.stripe_customer_id,'subscriptionId',a.stripe_subscription_id,'originalPaymentMethodId',o.request->'params'->>'payment_method',
    'monthlyPriceCents',a.monthly_price_cents,'periodStart',(r.latest_observation->>'periodStart')::bigint,
    'periodEnd',(r.latest_observation->>'periodEnd')::bigint,'revision',a.revision,'fingerprint',a.fingerprint,'paymentContext',p_context);
end;
$$;

create function public.monthly_card_setup_v1(p_action text,p_id uuid,p_operation uuid,p_buyer uuid,p_context jsonb,
  p_consent text,p_accepted boolean,p_proof jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare s public.monthly_mentorship_card_setups_v1%rowtype; b jsonb; m jsonb; v_session jsonb; v_url text; v_id uuid;
  v_now bigint:=floor(extract(epoch from clock_timestamp()))::bigint; v_exp bigint; v_version text:='monthly-card-setup-consent-v1';
  v_text text:='I authorize CreatorNet and Stripe to securely save this card for this mentorship''s payment recovery. Saving a card does not charge me, change service dates, restart debits, or waive a balance. A payment retry and use for future scheduled charges require a separate confirmation.';
begin
  if p_id is null or p_action is null or p_action not in ('reserve','read','claim','bind','verify') then raise exception 'Invalid monthly setup action'; end if;
  if p_action='reserve' then
    if p_operation is null or p_accepted is distinct from true or p_consent is distinct from v_version or p_proof is not null then
      raise exception 'Explicit monthly setup consent is required'; end if;
    b:=public.monthly_card_setup_basis_v1(p_operation,p_buyer,p_context);
    update public.monthly_mentorship_card_setups_v1 set closed_at=clock_timestamp() where operation_id=p_operation and closed_at is null and
      (expires_at<=v_now or snapshot is distinct from b);
    select * into s from public.monthly_mentorship_card_setups_v1 where operation_id=p_operation and closed_at is null for update;
    if found then return to_jsonb(s); end if;
    v_exp:=least(v_now+3600,(b->>'periodEnd')::bigint);
    if v_exp<v_now+1860 then raise exception 'Monthly setup creation window is too short'; end if;
    m:=jsonb_build_object('creatornet_membership_card_setup','monthly-card-setup-v1','membership_id',b->>'membershipId',
      'setup_request_id',p_id::text,'collection_operation_id',p_operation::text,'invoice_id',b->>'invoiceId','buyer_id',p_buyer::text,
      'membership_fingerprint',b->>'fingerprint');
    v_url:=p_context->>'siteOrigin'||'/memberships/renewal-recovery?membership_id='||(b->>'membershipId');
    insert into public.monthly_mentorship_card_setups_v1(id,operation_id,agreement_id,buyer_id,snapshot,consent_version,consent_text,created_at,expires_at,request)
      values(p_id,p_operation,(b->>'membershipId')::uuid,p_buyer,b,v_version,v_text,v_now,v_exp,
        jsonb_build_object('mode','setup','ui_mode','hosted','customer',b->>'customerId','client_reference_id',p_id::text,
          'payment_method_types',jsonb_build_array('card'),'expires_at',v_exp,'success_url',v_url,'cancel_url',v_url,'metadata',m,
          'setup_intent_data',jsonb_build_object('metadata',m),'custom_text',jsonb_build_object('submit',jsonb_build_object('message',v_text))))
      returning * into s;
    return to_jsonb(s);
  end if;
  if p_operation is not null or p_consent is not null or p_accepted is distinct from false or
    (p_action in ('read','claim') and p_proof is not null) then raise exception 'Monthly setup action parameters differ'; end if;
  select operation_id into v_id from public.monthly_mentorship_card_setups_v1 where id=p_id and buyer_id=p_buyer;
  if not found then raise exception 'Monthly card setup owner differs'; end if;
  b:=public.monthly_card_setup_basis_v1(v_id,p_buyer,p_context);
  select * into s from public.monthly_mentorship_card_setups_v1 where id=p_id for update;
  if s.closed_at is not null or s.expires_at<=v_now or s.snapshot is distinct from b or
    s.consent_version<>v_version or s.consent_text<>v_text then raise exception 'Monthly setup expired or its basis changed'; end if;
  if p_action='read' then return to_jsonb(s); end if;
  if p_action='claim' then
    update public.monthly_mentorship_card_setups_v1 set dispatch_started_at=coalesce(dispatch_started_at,clock_timestamp()) where id=s.id returning * into s;
    return to_jsonb(s);
  end if;
  v_session:=p_proof->'session';
  if s.dispatch_started_at is null or p_proof->>'version' is distinct from 'monthly-card-setup-proof-v1' or
    p_proof->'paymentContext' is distinct from p_context or not coalesce(v_session->>'id' ~ '^cs_[A-Za-z0-9_]+$',false) or
    (p_context->>'mode'='test') is distinct from (v_session->>'id' ~ '^cs_test_') or
    v_session->>'customerId' is distinct from b->>'customerId' or v_session->>'mode' is distinct from 'setup' or
    v_session->>'uiMode' is distinct from 'hosted' or v_session->>'paymentStatus' is distinct from 'no_payment_required' or
    v_session->>'clientReferenceId' is distinct from s.id::text or v_session->'metadata' is distinct from s.request->'metadata' or
    v_session->>'expiresAt' is distinct from s.expires_at::text or
    not coalesce(v_session->>'createdAt' ~ '^[0-9]{1,12}$',false) or
    (v_session->>'createdAt')::bigint<s.created_at or (v_session->>'createdAt')::bigint<floor(extract(epoch from s.dispatch_started_at))::bigint or (v_session->>'createdAt')::bigint>v_now or
    not coalesce(v_session->>'status' in ('open','complete'),false) or v_session->>'amountCents' is distinct from '0' or
    v_session->'paymentIntentId' is distinct from 'null'::jsonb or v_session->'subscriptionId' is distinct from 'null'::jsonb or
    v_session->'invoiceId' is distinct from 'null'::jsonb or not coalesce(v_session->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) or
    (s.session_id is not null and s.session_id is distinct from v_session->>'id') then raise exception 'Monthly setup session proof differs'; end if;
  if p_action='bind' then
    if s.session_id is null then
      update public.monthly_mentorship_card_setups_v1 set session_id=v_session->>'id',session_proof=p_proof where id=s.id returning * into s;
    end if;
    return to_jsonb(s);
  end if;
  if s.session_id is null or v_session->>'status' is distinct from 'complete' or
    p_proof->>'setupIntentId' is distinct from v_session->>'setupIntentId' or
    not coalesce(p_proof->>'setupIntentId' ~ '^seti_[A-Za-z0-9]+$',false) or not coalesce(p_proof->>'paymentMethodId' ~ '^pm_[A-Za-z0-9]+$',false) or
    p_proof->>'setupStatus' is distinct from 'succeeded' or p_proof->>'usage' is distinct from 'off_session' or
    p_proof->>'setupCustomerId' is distinct from b->>'customerId' or p_proof->>'cardCustomerId' is distinct from b->>'customerId' or
    p_proof->>'cardType' is distinct from 'card' or p_proof->'setupMetadata' is distinct from s.request->'metadata' or
    not coalesce(p_proof->>'setupRequestId' ~ '^req_[A-Za-z0-9]+$',false) or not coalesce(p_proof->>'cardRequestId' ~ '^req_[A-Za-z0-9]+$',false) then
    raise exception 'Monthly saved-card proof differs'; end if;
  if s.verified_at is not null then
    if s.setup_intent_id is distinct from p_proof->>'setupIntentId' or s.payment_method_id is distinct from p_proof->>'paymentMethodId' then
      raise exception 'Monthly saved card cannot be replaced in its original setup'; end if;
    return to_jsonb(s);
  end if;
  update public.monthly_mentorship_card_setups_v1 set setup_intent_id=p_proof->>'setupIntentId',payment_method_id=p_proof->>'paymentMethodId',
    setup_proof=p_proof,verified_at=clock_timestamp() where id=s.id returning * into s;
  return to_jsonb(s);
end;
$$;
revoke all on function public.monthly_card_setup_basis_v1(uuid,uuid,jsonb),public.monthly_card_setup_v1(text,uuid,uuid,uuid,jsonb,text,boolean,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.monthly_card_setup_v1(text,uuid,uuid,uuid,jsonb,text,boolean,jsonb) to service_role;
commit;
