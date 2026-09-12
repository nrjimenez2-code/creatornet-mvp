-- UNAPPLIED. Locked steps 1/2/4/7/8. One confirmed payoff, one ledger credit.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or to_regprocedure('public.request_monthly_mentorship_exit_v1(uuid,uuid,jsonb,text,jsonb,boolean)') is null then
    raise exception 'Monthly payoff prerequisites differ'; end if;
end;
$preflight$;
alter table public.monthly_mentorship_agreements_v1 add column payoff_hold_at timestamptz;
create table public.monthly_mentorship_payoffs_v1 (
  id uuid primary key default gen_random_uuid(), agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  buyer_id uuid not null references public.profiles(id), terms jsonb not null, fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
  amount_cents integer not null check(amount_cents between 50 and 99999999), remaining_months integer not null check(remaining_months between 1 and 23),
  first_unpaid_month integer not null check(first_unpaid_month between 2 and 24),
  period_start bigint not null, period_end bigint not null check(period_end>period_start),
  accepted_at timestamptz not null default clock_timestamp(),
  status text not null default 'accepted' check(status in ('accepted','checkout_dispatched','checkout_ready','review_required','captured','abandoned')),
  checkout_request jsonb, checkout_dispatched_at timestamptz, stripe_checkout_session_id text unique, checkout_request_id text,
  ledger_id uuid unique references public.payment_fee_ledger(id), provider_proof jsonb, captured_at timestamptz,
  abandonment_proof jsonb, abandoned_at timestamptz,
  check((status='captured' and ledger_id is not null and provider_proof is not null and captured_at is not null) or
    (status<>'captured' and ledger_id is null and provider_proof is null and captured_at is null)),
  check((status='abandoned' and abandonment_proof is not null and abandoned_at is not null) or
    (status<>'abandoned' and abandonment_proof is null and abandoned_at is null))
);
create unique index monthly_mentorship_one_current_payoff_v1 on public.monthly_mentorship_payoffs_v1(agreement_id) where status<>'abandoned';
alter table public.monthly_mentorship_payoffs_v1 enable row level security;
revoke all on public.monthly_mentorship_payoffs_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_payoffs_v1 to service_role;

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
  if a.payoff_hold_at is not null or a.revision is distinct from p_revision or a.financial_hold_at is not null or a.renewal_stopped_at is not null or
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
      a.payoff_hold_at is null and a.financial_hold_at is null and a.renewal_stopped_at is null and a.debit_revoked_at is null and
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

create function public.reserve_monthly_mentorship_payoff_v1(p_id uuid,p_buyer_id uuid,p_context jsonb,p_terms jsonb,p_fingerprint text,p_accepted boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype;
  q jsonb; expected jsonb; fees jsonb; v_remaining integer; v_amount integer;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or p_context is distinct from a.terms->'paymentContext' or p_accepted is distinct from true or
    not coalesce(p_fingerprint ~ '^[0-9a-f]{64}$',false) then raise exception 'Explicit owned payoff acceptance required'; end if;
  select * into pf from public.monthly_mentorship_payoffs_v1 where agreement_id=a.id and status<>'abandoned';
  if found then
    if pf.terms is distinct from p_terms or pf.fingerprint is distinct from p_fingerprint then raise exception 'Existing payoff terms differ'; end if;
    return to_jsonb(pf);
  end if;
  q:=public.read_monthly_mentorship_exit_quote_v1(a.id,p_buyer_id,p_context);
  if a.payoff_hold_at is not null or a.covered_months<1 or a.stripe_checkout_session_id is null or
    q->'reviewReasons'<>'[]'::jsonb or coalesce((q->>'payoffAmountCents')::integer,0)<50 or
    p_terms->'exitQuote' is distinct from q then raise exception 'Payoff quote requires fresh settled receipt state'; end if;
  v_remaining:=a.minimum_months-a.covered_months; v_amount:=v_remaining*a.monthly_price_cents; fees:=p_terms->'fees';
  if not public.valid_monthly_fee_snapshot_v1(fees,v_amount) or
    fees->>'processingFeeEnabled' is distinct from a.terms#>>'{firstMonthFees,processingFeeEnabled}' or
    fees->>'processingFeeBasisPoints' is distinct from a.terms#>>'{firstMonthFees,processingFeeBasisPoints}' or
    fees->>'processingFeeFixedCents' is distinct from a.terms#>>'{firstMonthFees,processingFeeFixedCents}' or
    fees->>'feeScheduleVersion' is distinct from a.terms#>>'{firstMonthFees,feeScheduleVersion}' then raise exception 'Payoff fee schedule differs'; end if;
  expected:=jsonb_build_object('version','monthly-mentorship-payoff-v1','membershipId',a.id,'agreementFingerprint',a.fingerprint,
    'buyerId',a.buyer_id,'creatorId',a.creator_id,'purchaseId',a.purchase_id,'productId',a.product_id,'postId',a.post_id,
    'title',a.terms->>'title','destinationId',a.terms->>'destinationId','currency','usd','amountCents',v_amount,
    'remainingMonths',v_remaining,'firstUnpaidMonth',a.covered_months+1,'periodStart',(q->>'paidThrough')::bigint,
    'periodEnd',(q->>'minimumEnd')::bigint,'exitQuote',q,'fees',fees,'paymentContext',p_context,
    'policyVersion',a.terms->>'policyVersion','policy',a.terms->'policy',
    'renewalsStopAfterPayoff',true,'paidAccessAndSupportThroughMinimum',true,'refundRightsPreserved',true);
  if p_terms is distinct from expected then raise exception 'Payoff acceptance does not match the exact unpaid minimum'; end if;
  insert into public.monthly_mentorship_payoffs_v1(agreement_id,buyer_id,terms,fingerprint,amount_cents,remaining_months,first_unpaid_month,period_start,period_end)
    values(a.id,a.buyer_id,p_terms,p_fingerprint,v_amount,v_remaining,a.covered_months+1,(q->>'paidThrough')::bigint,(q->>'minimumEnd')::bigint)
    returning * into pf;
  update public.monthly_mentorship_agreements_v1 set payoff_hold_at=pf.accepted_at,revision=revision+1,billing_next_attempt_at='infinity' where id=a.id;
  return to_jsonb(pf);
end;
$$;

create function public.claim_monthly_mentorship_payoff_checkout_v1(p_payoff_id uuid,p_buyer_id uuid,p_context jsonb,p_request jsonb)
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
  if pf.status='review_required' or a.payoff_hold_at is null or a.financial_hold_at is not null or
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

create function public.bind_monthly_mentorship_payoff_checkout_v1(p_payoff_id uuid,p_buyer_id uuid,p_context jsonb,p_session_id text,p_request_id text)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype; v_id uuid;
begin
  select agreement_id into v_id from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id and buyer_id=p_buyer_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context then raise exception 'Payoff publication owner differs'; end if;
  select * into pf from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id for update;
  if not coalesce(p_session_id ~ '^cs_[A-Za-z0-9_]+$',false) or not coalesce(p_request_id ~ '^req_[A-Za-z0-9]+$',false) then
    raise exception 'Payoff provider publication evidence differs'; end if;
  if pf.stripe_checkout_session_id is not null then
    if pf.stripe_checkout_session_id is distinct from p_session_id then raise exception 'Payoff session cannot be replaced'; end if;
    return false;
  end if;
  if pf.checkout_request is null or pf.checkout_dispatched_at is null or pf.status not in ('checkout_dispatched','review_required') then
    raise exception 'Payoff checkout has no admitted creation'; end if;
  update public.monthly_mentorship_payoffs_v1 set stripe_checkout_session_id=p_session_id,checkout_request_id=p_request_id,status='checkout_ready' where id=pf.id;
  return true;
end;
$$;

create function public.record_monthly_mentorship_payoff_v1(p_payoff_id uuid,p_buyer_id uuid,p_context jsonb,p_ledger_id uuid,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype;
  l public.payment_fee_ledger%rowtype; v_id uuid; f jsonb;
begin
  select agreement_id into v_id from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id and buyer_id=p_buyer_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context then raise exception 'Payoff receipt owner differs'; end if;
  select * into pf from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id for update;
  if pf.status='captured' then
    if pf.ledger_id is distinct from p_ledger_id or pf.provider_proof is distinct from p_proof then raise exception 'Payoff receipt replay differs'; end if;
    return false;
  end if;
  if pf.status='abandoned' or pf.stripe_checkout_session_id is null or a.payoff_hold_at is null or
    a.covered_months<>pf.first_unpaid_month-1 then raise exception 'Payoff capture needs reconciliation against the frozen minimum'; end if;
  select * into l from public.payment_fee_ledger where id=p_ledger_id for update; f:=pf.terms->'fees';
  if not found or l.purchase_id is distinct from a.purchase_id or l.creator_id is distinct from a.creator_id or l.currency is distinct from 'usd' or
    l.status not in ('paid','refunded') or l.earnings_credited_at is not null or l.gross_amount_cents<>pf.amount_cents or
    (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')) or
    l.platform_fee_cents::text is distinct from f->>'platformFeeCents' or l.processing_fee_cents::text is distinct from f->>'processingFeeCents' or
    l.total_creator_deduction_cents::text is distinct from f->>'totalCreatorDeductionCents' or l.creator_net_cents::text is distinct from f->>'creatorNetCents' or
    l.fee_schedule_version is distinct from f->>'feeScheduleVersion' or l.stripe_checkout_session_id is distinct from pf.stripe_checkout_session_id or
    l.stripe_invoice_id is not null or not coalesce(l.stripe_payment_intent_id ~ '^pi_[A-Za-z0-9]+$',false) or
    not coalesce(l.stripe_charge_id ~ '^ch_[A-Za-z0-9]+$',false) or
    p_proof->>'version' is distinct from 'monthly-mentorship-payoff-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    p_proof->>'payoffId' is distinct from pf.id::text or p_proof->>'payoffFingerprint' is distinct from pf.fingerprint or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    p_proof->>'checkoutSessionId' is distinct from pf.stripe_checkout_session_id or p_proof->>'destinationId' is distinct from a.terms->>'destinationId' or
    p_proof->>'paymentIntentId' is distinct from l.stripe_payment_intent_id or p_proof->>'chargeId' is distinct from l.stripe_charge_id or
    p_proof->>'capturedAmountCents' is distinct from pf.amount_cents::text or p_proof->>'applicationFeeAmountCents' is distinct from l.total_creator_deduction_cents::text or
    p_proof->>'paymentStatus' is distinct from 'succeeded' or p_proof->>'periodStart' is distinct from pf.period_start::text or
    p_proof->>'periodEnd' is distinct from pf.period_end::text or not coalesce(p_proof->>'paymentMethodId' ~ '^pm_[A-Za-z0-9]+$',false) or
    not coalesce(p_proof->>'paidAt' ~ '^[0-9]+$',false) then raise exception 'Payoff captured-payment evidence differs'; end if;
  if (p_proof->>'paidAt')::bigint<floor(extract(epoch from pf.accepted_at))::bigint or
    (p_proof->>'paidAt')::bigint>extract(epoch from clock_timestamp())::bigint then raise exception 'Payoff capture time differs'; end if;
  update public.profiles set total_earnings_cents=coalesce(total_earnings_cents,0)+greatest(0,l.creator_net_cents-l.earnings_reversed_cents) where id=a.creator_id;
  if not found then raise exception 'Payoff creator profile missing'; end if;
  update public.payment_fee_ledger set earnings_credited_at=clock_timestamp(),updated_at=clock_timestamp() where id=l.id;
  update public.monthly_mentorship_payoffs_v1 set ledger_id=l.id,provider_proof=p_proof,captured_at=clock_timestamp(),status='captured' where id=pf.id;
  update public.monthly_mentorship_agreements_v1 set covered_months=minimum_months,payoff_hold_at=null,
    renewal_stopped_at=coalesce(renewal_stopped_at,clock_timestamp()),revision=revision+1,billing_next_attempt_at='infinity' where id=a.id;
  insert into public.monthly_mentorship_exit_requests_v1(agreement_id,buyer_id,kind,accepted_snapshot)
    values(a.id,a.buyer_id,'stop_renewal',pf.terms) on conflict(agreement_id,kind) do nothing;
  return true;
end;
$$;

create function public.abandon_monthly_mentorship_payoff_v1(p_payoff_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype; v_id uuid;
begin
  select agreement_id into v_id from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id and buyer_id=p_buyer_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id for update;
  if not found or a.buyer_id is distinct from p_buyer_id or a.terms->'paymentContext' is distinct from p_context or
    p_proof->'paymentContext' is distinct from p_context then raise exception 'Payoff abandonment owner differs'; end if;
  select * into pf from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id for update;
  if pf.status='abandoned' then return false; end if;
  if pf.status='captured' or pf.ledger_id is not null or a.covered_months<>pf.first_unpaid_month-1 or exists(
    select 1 from public.payment_fee_ledger l where l.stripe_checkout_session_id=pf.stripe_checkout_session_id) then
    raise exception 'Recorded payoff money cannot be abandoned'; end if;
  if pf.checkout_request is null and pf.checkout_dispatched_at is null and pf.stripe_checkout_session_id is null then
    if p_proof->'neverDispatched' is distinct from 'true'::jsonb then raise exception 'Payoff was not proven undispatched'; end if;
  elsif pf.stripe_checkout_session_id is null or
    p_proof->>'checkoutSessionId' is distinct from pf.stripe_checkout_session_id or p_proof->>'sessionStatus' is distinct from 'expired' or
    p_proof->>'paymentStatus' is distinct from 'unpaid' or not coalesce(p_proof->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) or
    (p_proof->>'paymentIntentId' is not null and (p_proof->>'paymentIntentStatus' is distinct from 'canceled' or
      p_proof->>'amountReceived' is distinct from '0' or not coalesce(p_proof->>'paymentIntentId' ~ '^pi_[A-Za-z0-9]+$',false))) then
    raise exception 'Payoff must be expired and proven uncaptured before release'; end if;
  update public.monthly_mentorship_payoffs_v1 set status='abandoned',abandonment_proof=p_proof,abandoned_at=clock_timestamp() where id=pf.id;
  update public.monthly_mentorship_agreements_v1 set payoff_hold_at=null,revision=revision+1,billing_next_attempt_at=clock_timestamp() where id=a.id;
  -- Existing renewal/debit stops and receipts are preserved. A later payoff
  -- needs a fresh quote/acceptance; elapsed months are not auto-caught-up.
  return true;
end;
$$;

create or replace function public.read_monthly_mentorship_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p public.purchases%rowtype; a public.monthly_mentorship_agreements_v1%rowtype;
  v_until bigint; v_now numeric:=extract(epoch from clock_timestamp()); v_seconds integer;
begin
  select * into p from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id;
  if not found then return jsonb_build_object('allowed',false,'maxAgeSeconds',0); end if;
  if p.monthly_mentorship_id is null then
    return jsonb_build_object('allowed',p.access_granted and p.status<>'refunded','maxAgeSeconds',case when p.access_granted and p.status<>'refunded' then 3600 else 0 end);
  end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=p.monthly_mentorship_id and purchase_id=p.id and buyer_id=p_buyer_id;
  if not found or a.financial_hold_at is not null or p.status='refunded' then return jsonb_build_object('allowed',false,'maxAgeSeconds',0); end if;
  select max(x.period_end) into v_until from (
    select r.period_end from public.monthly_mentorship_receipts_v1 r join public.payment_fee_ledger l on l.id=r.ledger_id
      where r.agreement_id=a.id and r.period_start<=v_now and r.period_end>v_now and l.purchase_id=p.id and l.creator_id=a.creator_id and
        l.earnings_credited_at is not null and l.status='paid' and l.refunded_amount_cents<l.gross_amount_cents and
        (l.dispute_status is null or l.dispute_status in ('won','warning_closed'))
    union all
    select pf.period_end from public.monthly_mentorship_payoffs_v1 pf join public.payment_fee_ledger l on l.id=pf.ledger_id
      where pf.agreement_id=a.id and pf.status='captured' and pf.period_start<=v_now and pf.period_end>v_now and
        l.purchase_id=p.id and l.creator_id=a.creator_id and l.earnings_credited_at is not null and l.status='paid' and
        l.refunded_amount_cents<l.gross_amount_cents and (l.dispute_status is null or l.dispute_status in ('won','warning_closed'))
  ) x;
  v_seconds:=greatest(0,least(3600,floor(coalesce(v_until,v_now)-v_now)::integer));
  return jsonb_build_object('allowed',v_seconds>0,'maxAgeSeconds',v_seconds,'paidThrough',v_until);
end;
$$;
revoke all on function public.reserve_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,jsonb,text,boolean),
  public.claim_monthly_mentorship_payoff_checkout_v1(uuid,uuid,jsonb,jsonb),
  public.bind_monthly_mentorship_payoff_checkout_v1(uuid,uuid,jsonb,text,text),
  public.record_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,uuid,jsonb),
  public.abandon_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.reserve_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,jsonb,text,boolean),
  public.claim_monthly_mentorship_payoff_checkout_v1(uuid,uuid,jsonb,jsonb),
  public.bind_monthly_mentorship_payoff_checkout_v1(uuid,uuid,jsonb,text,text),
  public.record_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,uuid,jsonb),
  public.abandon_monthly_mentorship_payoff_v1(uuid,uuid,jsonb,jsonb) to service_role;
commit;
