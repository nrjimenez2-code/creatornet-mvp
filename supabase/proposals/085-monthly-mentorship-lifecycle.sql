-- UNAPPLIED. Locked steps 1/2/5/8. Lifecycle observations and non-charging containment.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regprocedure('public.abandon_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,jsonb)') is null then
    raise exception 'Monthly lifecycle prerequisites differ'; end if;
end; $preflight$;
alter table public.monthly_mentorship_agreements_v1 add column billing_review_at timestamptz;
alter table public.monthly_mentorship_agreements_v1 add column billing_review_reason text;
create table public.monthly_mentorship_lifecycle_v1 (
  event_id text primary key check(event_id ~ '^evt_[A-Za-z0-9_]+$'),
  agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  event_type text not null,
  object_id text not null,
  first_observation jsonb not null,
  latest_observation jsonb not null,
  outcome text not null check(outcome in ('observed','waiting_collection','reconciled','checkout_attention','review_required','provider_stopped')),
  first_observed_at timestamptz not null default clock_timestamp(),
  last_observed_at timestamptz not null default clock_timestamp()
);
create table public.monthly_mentorship_containment_v1 (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references public.monthly_mentorship_lifecycle_v1(event_id),
  agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  resource_id text not null,
  resource_type text not null check(resource_type in ('subscription','invoice')),
  request jsonb not null,
  dispatched_at timestamptz not null default clock_timestamp(),
  status text not null default 'dispatched' check(status in ('dispatched','review_required','contained')),
  provider_proof jsonb,
  completed_at timestamptz,
  unique(event_id,resource_id),
  check((status='contained')=(provider_proof is not null and completed_at is not null))
);
alter table public.monthly_mentorship_lifecycle_v1 enable row level security;
alter table public.monthly_mentorship_containment_v1 enable row level security;
revoke all on public.monthly_mentorship_lifecycle_v1,public.monthly_mentorship_containment_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_lifecycle_v1,public.monthly_mentorship_containment_v1 to service_role;

create function public.record_monthly_mentorship_lifecycle_v1(p_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_event_type text,p_outcome text,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; e public.monthly_mentorship_lifecycle_v1%rowtype; v_stop boolean;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context or
    p_proof->>'version' is distinct from 'monthly-lifecycle-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    a.stripe_customer_id is null or a.stripe_subscription_id is null or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    not coalesce(p_proof->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) or
    not coalesce(p_event_id ~ '^evt_[A-Za-z0-9_]+$',false) or p_outcome is null or
    p_outcome not in ('observed','waiting_collection','reconciled','checkout_attention','review_required','provider_stopped') then
    raise exception 'Monthly lifecycle ownership or evidence differs'; end if;
  if not coalesce(case p_proof->>'objectType'
    when 'subscription' then p_event_type like 'customer.subscription.%' and p_proof->>'objectId'=a.stripe_subscription_id
    when 'invoice' then p_event_type like 'invoice.%' and p_proof->>'objectId' ~ '^in_[A-Za-z0-9_]+$'
    when 'checkout.session' then p_event_type like 'checkout.session.%' and (
      p_proof->>'objectId'=a.stripe_checkout_session_id or exists(select 1 from public.monthly_mentorship_payoffs_v1 pf
        where pf.agreement_id=a.id and pf.buyer_id=a.buyer_id and pf.stripe_checkout_session_id=p_proof->>'objectId'))
    else false end,false) then raise exception 'Monthly lifecycle object differs'; end if;
  v_stop:=p_proof->>'objectType'='subscription' and p_proof->>'status'='canceled';
  if (p_outcome='provider_stopped') is distinct from v_stop then raise exception 'Monthly stop requires actual canceled subscription'; end if;
  select * into e from public.monthly_mentorship_lifecycle_v1 where event_id=p_event_id for update;
  if found and (e.agreement_id<>a.id or e.event_type<>p_event_type or e.object_id is distinct from p_proof->>'objectId') then
    raise exception 'Monthly lifecycle event identity changed'; end if;
  if e.event_id is null then
    insert into public.monthly_mentorship_lifecycle_v1(event_id,agreement_id,event_type,object_id,first_observation,latest_observation,outcome)
      values(p_event_id,a.id,p_event_type,p_proof->>'objectId',p_proof,p_proof,p_outcome) returning * into e;
  else
    update public.monthly_mentorship_lifecycle_v1 set latest_observation=p_proof,last_observed_at=clock_timestamp(),
      outcome=case when outcome='provider_stopped' or p_outcome='provider_stopped' then 'provider_stopped'
        when outcome='review_required' then 'review_required'
        when outcome='reconciled' and p_outcome in ('observed','waiting_collection','checkout_attention') then 'reconciled' else p_outcome end
      where event_id=e.event_id returning * into e;
  end if;
  if p_outcome='review_required' and a.billing_review_at is null then
    update public.monthly_mentorship_agreements_v1 set billing_review_at=clock_timestamp(),billing_review_reason=p_event_id,
      revision=revision+1,billing_next_attempt_at='infinity' where id=a.id;
  end if;
  if v_stop then
    update public.monthly_mentorship_agreements_v1 set renewal_stopped_at=coalesce(renewal_stopped_at,clock_timestamp()),
      revision=revision+case when renewal_stopped_at is null then 1 else 0 end,billing_next_attempt_at='infinity' where id=a.id;
    update public.monthly_mentorship_exit_requests_v1 set status='provider_stopped',provider_completed_at=clock_timestamp(),
      provider_proof=jsonb_build_object('version','monthly-exit-stop-proof-v1','paymentContext',p_context,
        'subscriptionId',a.stripe_subscription_id,'customerId',a.stripe_customer_id,'status','canceled','requestId',p_proof->>'requestId')
      where agreement_id=a.id and status<>'provider_stopped';
  end if;
  -- No receipt, earnings, paid-access hold, payoff release, debt waiver or fabricated buyer acceptance.
  return to_jsonb(e);
end;
$$;

create function public.claim_monthly_mentorship_containment_v1(p_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_resource_type text,p_resource_id text,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; e public.monthly_mentorship_lifecycle_v1%rowtype;
  o public.monthly_mentorship_containment_v1%rowtype; v_expected jsonb;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Monthly containment owner differs'; end if;
  select * into e from public.monthly_mentorship_lifecycle_v1 where event_id=p_event_id and agreement_id=a.id;
  if not found or e.outcome<>'review_required' or a.billing_review_at is null then raise exception 'Monthly containment lacks durable review'; end if;
  if p_resource_type='subscription' and p_resource_id=a.stripe_subscription_id then
    v_expected:=jsonb_build_object('method','POST','path','/v1/subscriptions/'||p_resource_id,
      'params',jsonb_build_object('pause_collection',jsonb_build_object('behavior','keep_as_draft'),'proration_behavior','none'));
  elsif p_resource_type='invoice' and p_resource_id=e.object_id and e.latest_observation->>'objectType'='invoice' then
    v_expected:=jsonb_build_object('method','POST','path','/v1/invoices/'||p_resource_id,'params',jsonb_build_object('auto_advance',false));
  else raise exception 'Monthly containment target differs'; end if;
  if p_request is distinct from v_expected then raise exception 'Monthly containment may only disable collection'; end if;
  select * into o from public.monthly_mentorship_containment_v1 where event_id=p_event_id and resource_id=p_resource_id for update;
  if found then
    if o.request is distinct from p_request or o.resource_type<>p_resource_type then raise exception 'Monthly containment retry differs'; end if;
    if o.status<>'contained' and o.dispatched_at<=clock_timestamp()-interval '20 hours' then
      update public.monthly_mentorship_containment_v1 set status='review_required' where id=o.id returning * into o;
    end if;
    return to_jsonb(o);
  end if;
  insert into public.monthly_mentorship_containment_v1(event_id,agreement_id,resource_id,resource_type,request)
    values(p_event_id,a.id,p_resource_id,p_resource_type,p_request) returning * into o;
  return to_jsonb(o);
end;
$$;
create function public.complete_monthly_mentorship_containment_v1(p_operation_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_containment_v1%rowtype; v_id uuid;
begin
  select agreement_id into v_id from public.monthly_mentorship_containment_v1 where id=p_operation_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Monthly containment completion owner differs'; end if;
  select * into o from public.monthly_mentorship_containment_v1 where id=p_operation_id for update;
  if p_proof->>'version' is distinct from 'monthly-lifecycle-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    p_proof->>'objectId' is distinct from o.resource_id or p_proof->>'objectType' is distinct from o.resource_type or
    not coalesce(p_proof->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) or not coalesce(case o.resource_type
      when 'subscription' then p_proof->>'status'='canceled' or
        (p_proof->>'pauseBehavior'='keep_as_draft' and p_proof->'resumesAt'='null'::jsonb)
      when 'invoice' then p_proof->'autoAdvance'='false'::jsonb else false end,false) then
    raise exception 'Monthly containment requires fresh stopped-collection evidence'; end if;
  if o.status='contained' then return false; end if;
  update public.monthly_mentorship_containment_v1 set status='contained',provider_proof=p_proof,completed_at=clock_timestamp() where id=o.id;
  return true;
end;
$$;

create or replace function public.claim_monthly_mentorship_operation_v1(p_agreement_id uuid,p_actor_id uuid,p_kind text,p_scope text,
  p_revision bigint,p_context jsonb,p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype; v_prior text;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_agreement_id for update;
  if not found or p_context is distinct from a.terms->'paymentContext' or
    p_actor_id is distinct from (case when p_kind='collect' then a.creator_id else a.buyer_id end) or
    p_kind is null or p_kind not in ('customer','product','subscription','hold','checkout','activate','collect') or
    p_request is null or jsonb_typeof(p_request)<>'object' or p_request->>'method' is distinct from 'POST' or
    not coalesce(p_request->>'path' ~ '^/v1/[A-Za-z0-9_/]+$',false) or jsonb_typeof(p_request->'params') is distinct from 'object' or
    p_request-array['method','path','params']<>'{}'::jsonb then raise exception 'Monthly operation identity or request differs'; end if;
  if (p_kind<>'collect' and p_scope is distinct from 'initial') or
    (p_kind='collect' and not coalesce(p_scope ~ '^[1-9][0-9]{0,8}$',false)) then raise exception 'Monthly operation scope differs'; end if;
  if not (case p_kind when 'customer' then p_request->>'path'='/v1/customers'
    when 'product' then p_request->>'path'='/v1/products'
    when 'subscription' then p_request->>'path'='/v1/subscriptions'
    when 'checkout' then p_request->>'path'='/v1/checkout/sessions'
    when 'collect' then p_request->>'path' ~ '^/v1/invoices/in_[A-Za-z0-9]+/pay$'
    else p_request->>'path' ~ '^/v1/subscriptions/sub_[A-Za-z0-9]+$' end) then
    raise exception 'Monthly operation provider path differs'; end if;
  select * into o from public.monthly_mentorship_operations_v1 where agreement_id=p_agreement_id and kind=p_kind and scope_key=p_scope for update;
  if found then
    if o.request is distinct from p_request then raise exception 'Monthly operation retry parameters differ'; end if;
    if o.status='complete' then return to_jsonb(o); end if;
    if o.dispatched_at<=clock_timestamp()-interval '20 hours' then
      update public.monthly_mentorship_operations_v1 set status='review_required' where id=o.id returning * into o;
      return to_jsonb(o);
    end if;
  end if;
  if a.billing_review_at is not null or a.payoff_hold_at is not null or a.revision is distinct from p_revision or a.financial_hold_at is not null or a.renewal_stopped_at is not null or
    a.debit_revoked_at is not null then raise exception 'Monthly operation requires fresh eligible agreement state'; end if;
  if p_kind in ('customer','product','subscription','hold','checkout') and (a.covered_months<>0 or a.stripe_subscription_id is not null) then
    raise exception 'Monthly bootstrap is already bound or paid'; end if;
  if p_kind in ('activate','collect') and (a.covered_months<1 or a.stripe_subscription_id is null or exists(
    select 1 from public.monthly_mentorship_receipts_v1 r join public.payment_fee_ledger l on l.id=r.ledger_id
      where r.agreement_id=a.id and (l.status<>'paid' or l.refunded_amount_cents<>0 or
        (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed'))))) then
    raise exception 'Monthly collection requires settled receipt-backed state'; end if;
  if p_kind='collect' and (p_scope::integer<>a.covered_months+1 or (not a.auto_renew and p_scope::integer>a.minimum_months) or
    public.monthly_mentorship_boundary_v1(a.anchor_at,p_scope::integer-1)>extract(epoch from clock_timestamp())::bigint or
    public.monthly_mentorship_boundary_v1(a.anchor_at,p_scope::integer)<=extract(epoch from clock_timestamp())::bigint) then
    raise exception 'Monthly collection is not the current unpaid service period'; end if;
  v_prior:=case p_kind when 'product' then 'customer' when 'subscription' then 'product' when 'hold' then 'subscription'
    when 'checkout' then 'hold' when 'activate' then 'checkout' when 'collect' then 'activate' else null end;
  if v_prior is not null and not exists(select 1 from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind=v_prior and scope_key='initial' and status='complete') then
    raise exception 'Prior monthly operation is not complete'; end if;
  if o.id is null then
    insert into public.monthly_mentorship_operations_v1(agreement_id,kind,scope_key,request,agreement_revision)
      values(a.id,p_kind,p_scope,p_request,a.revision) returning * into o;
  end if;
  return to_jsonb(o);
end;
$$;

create or replace function public.lease_monthly_mentorship_work_v1(p_context jsonb,p_limit integer default 6)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare v record; v_token uuid; v_now timestamptz:=clock_timestamp(); v_result jsonb:='[]'::jsonb;
begin
  if p_limit is null or p_limit<1 or p_limit>6 or jsonb_typeof(p_context) is distinct from 'object' then
    raise exception 'Monthly worker request differs'; end if;
  for v in select a.id,a.buyer_id,a.creator_id,not exists(select 1 from public.monthly_mentorship_operations_v1 o
      where o.agreement_id=a.id and o.kind='activate' and o.scope_key='initial' and o.status='complete') needs_activation
    from public.monthly_mentorship_agreements_v1 a
    where a.terms->'paymentContext'=p_context and a.covered_months>=1 and a.anchor_at is not null and
      a.billing_review_at is null and a.payoff_hold_at is null and a.financial_hold_at is null and a.renewal_stopped_at is null and a.debit_revoked_at is null and
      a.billing_next_attempt_at<=v_now and (a.billing_lease_until is null or a.billing_lease_until<=v_now) and
      (not exists(select 1 from public.monthly_mentorship_operations_v1 o where o.agreement_id=a.id and o.kind='activate' and o.status='complete') or
       ((a.auto_renew or a.covered_months<a.minimum_months) and
         public.monthly_mentorship_boundary_v1(a.anchor_at,a.covered_months)<=extract(epoch from v_now)::bigint))
    order by a.billing_next_attempt_at,a.id limit p_limit for update of a skip locked
  loop
    v_token:=gen_random_uuid();
    update public.monthly_mentorship_agreements_v1 set billing_work_token=v_token,billing_lease_until=v_now+interval '75 seconds',
      billing_next_attempt_at=v_now+interval '75 seconds',billing_worker_status='running',billing_last_attempt_at=v_now where id=v.id;
    v_result:=v_result||jsonb_build_array(jsonb_build_object('id',v.id,'buyer_id',v.buyer_id,'creator_id',v.creator_id,
      'lease_token',v_token,'needs_activation',v.needs_activation));
  end loop;
  return v_result;
end;
$$;

create or replace function public.read_monthly_mentorship_exit_quote_v1(p_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_reasons jsonb:='[]'::jsonb;
  v_remaining integer; v_paid_through bigint; v_min_end bigint; v_count integer;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Monthly exit ownership differs'; end if;
  v_remaining:=greatest(0,a.minimum_months-a.covered_months);
  v_min_end:=case when a.anchor_at is not null then public.monthly_mentorship_boundary_v1(a.anchor_at,a.minimum_months) end;
  select count(*)::integer into v_count from public.monthly_mentorship_receipts_v1 where agreement_id=a.id;
  select v_count+coalesce(sum(remaining_months),0)::integer into v_count from public.monthly_mentorship_payoffs_v1 where agreement_id=a.id and status='captured';
  if a.covered_months=0 or v_count<>a.covered_months then v_reasons:=v_reasons||'["receipt_state_requires_review"]'::jsonb; end if;
  if a.billing_review_at is not null then v_reasons:=v_reasons||'["billing_review"]'::jsonb; end if;
  if a.financial_hold_at is not null then v_reasons:=v_reasons||'["financial_hold"]'::jsonb; end if;
  if exists(select 1 from public.payment_fee_ledger l where l.purchase_id=a.purchase_id and
    (l.status<>'paid' or l.refunded_amount_cents<>0 or
      (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')))) then
    v_reasons:=v_reasons||'["refund_or_payment_review"]'::jsonb; end if;
  if exists(select 1 from public.payment_fee_ledger l where l.purchase_id=a.purchase_id and not exists(
    select 1 from public.monthly_mentorship_receipts_v1 r where r.agreement_id=a.id and r.ledger_id=l.id) and not exists(select 1 from public.monthly_mentorship_payoffs_v1 pf where pf.agreement_id=a.id and pf.ledger_id=l.id and pf.status='captured')) then
    v_reasons:=v_reasons||'["unreconciled_payment"]'::jsonb; end if;
  if exists(select 1 from public.monthly_mentorship_operations_v1 o where o.agreement_id=a.id and o.kind='collect' and not exists(
    select 1 from public.monthly_mentorship_receipts_v1 r where r.agreement_id=a.id and r.month_number::text=o.scope_key)) then
    v_reasons:=v_reasons||'["collection_in_flight_or_review"]'::jsonb; end if;
  if v_remaining>0 and v_min_end<=extract(epoch from clock_timestamp())::bigint then
    v_reasons:=v_reasons||'["elapsed_unpaid_minimum"]'::jsonb; end if;
  select max(r.period_end) into v_paid_through from public.monthly_mentorship_receipts_v1 r
    join public.payment_fee_ledger l on l.id=r.ledger_id where r.agreement_id=a.id and l.purchase_id=a.purchase_id and
      l.status='paid' and l.earnings_credited_at is not null and l.refunded_amount_cents<l.gross_amount_cents and
      (l.dispute_status is null or l.dispute_status in ('won','warning_closed'));
  select greatest(v_paid_through,max(pf.period_end)) into v_paid_through from public.monthly_mentorship_payoffs_v1 pf
    join public.payment_fee_ledger l on l.id=pf.ledger_id where pf.agreement_id=a.id and pf.status='captured' and
    l.status='paid' and l.earnings_credited_at is not null and l.refunded_amount_cents<l.gross_amount_cents and
    (l.dispute_status is null or l.dispute_status in ('won','warning_closed'));
  if a.financial_hold_at is not null then v_paid_through:=null; end if;
  return jsonb_build_object('version','monthly-exit-quote-v1','membershipId',a.id,'revision',a.revision,
    'agreementFingerprint',a.fingerprint,'monthlyPriceCents',a.monthly_price_cents,'minimumMonths',a.minimum_months,
    'minimumTotalCents',a.monthly_price_cents::bigint*a.minimum_months,'coveredMonths',a.covered_months,
    'remainingMonths',v_remaining,'payoffAmountCents',case when v_reasons='[]'::jsonb then v_remaining*a.monthly_price_cents end,
    'paidThrough',v_paid_through,'minimumEnd',v_min_end,'reviewReasons',v_reasons,
    'renewalStopped',a.renewal_stopped_at is not null,'debitsRevoked',a.debit_revoked_at is not null,
    'policyVersion',a.terms->>'policyVersion');
end;
$$;

create or replace function public.claim_monthly_mentorship_payoff_checkout_v1(p_payoff_id uuid,p_buyer_id uuid,p_context jsonb,p_request jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype; v_id uuid;
begin
  select agreement_id into v_id from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id and buyer_id=p_buyer_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context then raise exception 'Payoff checkout owner differs'; end if;
  select * into pf from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id for update;
  if pf.checkout_request is not null and pf.checkout_request is distinct from p_request then raise exception 'Payoff retry parameters differ'; end if;
  if pf.status in ('captured','abandoned') or pf.stripe_checkout_session_id is not null then return to_jsonb(pf); end if;
  if pf.checkout_dispatched_at<=clock_timestamp()-interval '20 hours' then
    update public.monthly_mentorship_payoffs_v1 set status='review_required' where id=pf.id returning * into pf;
    return to_jsonb(pf);
  end if;
  if a.billing_review_at is not null or pf.status='review_required' or a.payoff_hold_at is null or a.financial_hold_at is not null or
    a.covered_months<>pf.first_unpaid_month-1 or
    public.read_monthly_mentorship_exit_quote_v1(a.id,a.buyer_id,p_context)->'reviewReasons'<>'[]'::jsonb or
    pf.accepted_at+interval '23 hours'<=clock_timestamp()+interval '30 minutes' then raise exception 'Payoff checkout requires recovery or fresh eligibility'; end if;
  if jsonb_typeof(p_request) is distinct from 'object' or p_request->>'mode' is distinct from 'payment' or
    p_request->>'customer' is distinct from a.stripe_customer_id or p_request->'payment_method_types' is distinct from '["card"]'::jsonb or
    p_request#>>'{line_items,0,price_data,unit_amount}' is distinct from pf.amount_cents::text or
    p_request#>>'{line_items,0,quantity}' is distinct from '1' or jsonb_array_length(p_request->'line_items')<>1 or
    p_request#>>'{line_items,0,price_data,currency}' is distinct from 'usd' or
    p_request#>>'{payment_intent_data,application_fee_amount}' is distinct from pf.terms#>>'{fees,totalCreatorDeductionCents}' or
    p_request#>>'{payment_intent_data,transfer_data,destination}' is distinct from a.terms->>'destinationId' or
    p_request#>'{payment_intent_data,setup_future_usage}' is not null or
    p_request#>>'{metadata,creatornet_membership_payoff_id}' is distinct from pf.id::text or
    p_request#>>'{metadata,creatornet_membership_payoff_fingerprint}' is distinct from pf.fingerprint or
    p_request#>'{payment_intent_data,metadata}' is distinct from p_request->'metadata' or
    p_request->>'expires_at' is distinct from (floor(extract(epoch from pf.accepted_at))::bigint+23*3600)::text or
    p_request#>'{automatic_tax,enabled}' is distinct from 'false'::jsonb or
    p_request#>'{invoice_creation,enabled}' is distinct from 'false'::jsonb then raise exception 'Payoff provider request differs'; end if;
  update public.monthly_mentorship_payoffs_v1 set checkout_request=p_request,checkout_dispatched_at=coalesce(checkout_dispatched_at,clock_timestamp()),
    status='checkout_dispatched' where id=pf.id returning * into pf;
  return to_jsonb(pf);
end;
$$;
revoke all on function public.record_monthly_mentorship_lifecycle_v1(uuid,uuid,jsonb,text,text,text,jsonb),
  public.claim_monthly_mentorship_containment_v1(uuid,uuid,jsonb,text,text,text,jsonb),
  public.complete_monthly_mentorship_containment_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_monthly_mentorship_lifecycle_v1(uuid,uuid,jsonb,text,text,text,jsonb),
  public.claim_monthly_mentorship_containment_v1(uuid,uuid,jsonb,text,text,text,jsonb),
  public.complete_monthly_mentorship_containment_v1(uuid,uuid,jsonb,jsonb) to service_role;
commit;
