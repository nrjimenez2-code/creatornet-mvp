-- UNAPPLIED. Locked steps 1/2/4/5/7/8. One explicitly confirmed buyer retry.
-- Same invoice/PI and existing financial ledger; future card choice is conditional on capture.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regclass('public.monthly_mentorship_card_setups_v1') is null or
    to_regclass('public.monthly_mentorship_retry_quotes_v1') is not null then raise exception 'Monthly retry prerequisites differ'; end if;
end; $preflight$;
create table public.monthly_mentorship_retry_quotes_v1 (
  id uuid primary key, setup_id uuid not null references public.monthly_mentorship_card_setups_v1(id),
  operation_id uuid not null references public.monthly_mentorship_operations_v1(id),
  agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id), buyer_id uuid not null,
  invoice_id text not null, month_number integer not null check(month_number>=2), snapshot jsonb not null, quote jsonb not null,
  created_at bigint not null, expires_at bigint not null check(expires_at>created_at and expires_at<=created_at+600),
  confirmed_at timestamptz, use_future_card boolean, consent_version text, future_consent_version text,
  dispatch_consumed_at timestamptz, request jsonb not null,
  check((confirmed_at is null and use_future_card is null and consent_version is null and future_consent_version is null and dispatch_consumed_at is null) or
    (confirmed_at is not null and use_future_card is not null and consent_version='monthly-retry-consent-v1' and
      ((use_future_card and future_consent_version='monthly-future-card-consent-v1') or (not use_future_card and future_consent_version is null))))
);
create unique index monthly_one_confirmed_retry_v1 on public.monthly_mentorship_retry_quotes_v1(operation_id) where confirmed_at is not null;
alter table public.monthly_mentorship_retry_quotes_v1 enable row level security;
revoke all on public.monthly_mentorship_retry_quotes_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_retry_quotes_v1 to service_role;
alter table public.monthly_mentorship_lifecycle_v1 add column payment_recovery_resolved_at timestamptz;
alter table public.monthly_mentorship_lifecycle_v1 add column payment_recovery_receipt_month integer;

create function public.monthly_card_for_service_v1(p_id uuid,p_month integer) returns text
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v text;
begin
  if p_month is null or p_month<2 then raise exception 'Invalid monthly card service period'; end if;
  select coalesce(provider_proof->>'nextPaymentMethodId',provider_proof->>'paymentMethodId') into v
    from public.monthly_mentorship_receipts_v1 where agreement_id=p_id and month_number=p_month-1;
  if not coalesce(v ~ '^pm_[A-Za-z0-9]+$',false) then raise exception 'Prior monthly card authority is missing'; end if;
  return v;
end;
$$;

create function public.monthly_retry_v1(p_action text,p_id uuid,p_setup uuid,p_buyer uuid,p_context jsonb,
  p_accepted boolean,p_consent text,p_future boolean,p_future_consent text) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare s public.monthly_mentorship_card_setups_v1%rowtype; q public.monthly_mentorship_retry_quotes_v1%rowtype;
  a public.monthly_mentorship_agreements_v1%rowtype; b jsonb; v_setup uuid; v_now bigint:=floor(extract(epoch from clock_timestamp()))::bigint; v_exp bigint;
  v_retry text:='I authorize one payment retry for the exact monthly amount and original service period shown, using my verified saved card. This does not change my price, minimum, service dates, or any remaining balance.'; v_future text:='If this retry succeeds using the saved card, use that card for future charges already authorized by this mentorship agreement. The agreed price, minimum and renewal schedule do not change.'; v_month integer; v_title text;
begin
  if p_action is null or p_action not in ('review','confirm','consume','read') or p_id is null then raise exception 'Invalid monthly retry action'; end if;
  if p_action='review' then v_setup:=p_setup;
  else select setup_id into v_setup from public.monthly_mentorship_retry_quotes_v1 where id=p_id and buyer_id=p_buyer; end if;
  select agreement_id into s.agreement_id from public.monthly_mentorship_card_setups_v1 where id=v_setup and buyer_id=p_buyer;
  select * into a from public.monthly_mentorship_agreements_v1 where id=s.agreement_id and buyer_id=p_buyer for update;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Monthly retry owner differs'; end if;
  select * into s from public.monthly_mentorship_card_setups_v1 where id=v_setup for update;
  if p_action<>'review' then
    select * into q from public.monthly_mentorship_retry_quotes_v1 where id=p_id for update;
    if not found or q.agreement_id<>a.id or q.snapshot->'paymentContext' is distinct from p_context or p_setup is not null then raise exception 'Monthly retry identity differs'; end if;
  end if;
  v_now:=floor(extract(epoch from clock_timestamp()))::bigint;
  if p_action='read' then
    if p_accepted is distinct from false or p_future is distinct from false or p_consent is not null or p_future_consent is not null then
      raise exception 'Monthly retry read is not new consent'; end if;
    return to_jsonb(q);
  end if;
  if p_action='confirm' and q.confirmed_at is not null then
    if p_accepted is distinct from true or p_consent is distinct from q.consent_version or p_future is distinct from q.use_future_card or
      p_future_consent is distinct from q.future_consent_version then raise exception 'Accepted monthly retry choice cannot change'; end if;
    return to_jsonb(q);
  end if;
  if p_action='consume' and (p_accepted is distinct from false or p_future is distinct from false or p_consent is not null or p_future_consent is not null) then
    raise exception 'Monthly dispatch cannot manufacture consent'; end if;
  if p_action='consume' and q.dispatch_consumed_at is not null then return jsonb_build_object('dispatch',false,'retry',to_jsonb(q)); end if;
  b:=public.monthly_card_setup_basis_v1(s.operation_id,p_buyer,p_context);
  if s.verified_at is null or s.setup_intent_id is null or s.payment_method_id is null or s.session_id is null or
    s.closed_at is not null or s.expires_at<=v_now or s.snapshot is distinct from b then raise exception 'Monthly retry requires its current verified setup'; end if;
  if exists(select 1 from public.monthly_mentorship_retry_quotes_v1 other where other.operation_id=s.operation_id and other.confirmed_at is not null and other.id<>p_id) then
    raise exception 'Original monthly buyer retry already accepted; reconcile or review'; end if;
  v_month:=a.covered_months+1;
  if p_action='review' then
    if p_accepted is distinct from false or p_future is distinct from false or p_consent is not null or p_future_consent is not null then
      raise exception 'Monthly review cannot manufacture consent'; end if;
    select * into q from public.monthly_mentorship_retry_quotes_v1 where setup_id=s.id and confirmed_at is null and expires_at>v_now
      order by created_at desc limit 1 for update;
    if found then return to_jsonb(q); end if;
    v_exp:=least(v_now+600,s.expires_at,(b->>'periodEnd')::bigint);
    if v_exp<=v_now+30 then raise exception 'Monthly retry quote window is too short'; end if;
    select title into v_title from public.products where id=a.product_id;
    b:=b||jsonb_build_object('setupId',s.id,'setupIntentId',s.setup_intent_id,'replacementPaymentMethodId',s.payment_method_id);
    insert into public.monthly_mentorship_retry_quotes_v1(id,setup_id,operation_id,agreement_id,buyer_id,invoice_id,month_number,snapshot,quote,created_at,expires_at,request)
      values(p_id,s.id,s.operation_id,a.id,p_buyer,b->>'invoiceId',v_month,b,
        jsonb_build_object('version','monthly-retry-quote-v1','id',p_id,'membershipId',a.id,'setupId',s.id,'title',coalesce(v_title,'Monthly mentorship'),
          'amountCents',a.monthly_price_cents,'currency','usd','month',v_month,'periodStart',(b->>'periodStart')::bigint,
          'periodEnd',(b->>'periodEnd')::bigint,'expiresAt',v_exp,'minimumMonths',a.minimum_months,'autoRenew',a.auto_renew,
          'canUseForFuture',a.auto_renew or v_month<a.minimum_months,'consentVersion','monthly-retry-consent-v1','consentText',v_retry,
          'futureConsentVersion','monthly-future-card-consent-v1','futureConsentText',v_future),v_now,v_exp,
        jsonb_build_object('payment_method',s.payment_method_id,'off_session',false,'forgive',false,'paid_out_of_band',false))
      returning * into q;
    return to_jsonb(q);
  end if;
  if q.expires_at<=v_now or q.snapshot is distinct from (b||jsonb_build_object('setupId',s.id,'setupIntentId',s.setup_intent_id,'replacementPaymentMethodId',s.payment_method_id)) then
    raise exception 'Monthly retry quote expired or changed'; end if;
  if p_action='confirm' then
    if p_accepted is distinct from true or p_consent is distinct from 'monthly-retry-consent-v1' or p_future is null or
      (p_future and (p_future_consent is distinct from 'monthly-future-card-consent-v1' or (q.quote->>'canUseForFuture')::boolean is distinct from true)) or
      (not p_future and p_future_consent is not null) then raise exception 'Explicit monthly retry and future-card choices are required'; end if;
    update public.monthly_mentorship_retry_quotes_v1 set confirmed_at=clock_timestamp(),use_future_card=p_future,consent_version=p_consent,
      future_consent_version=p_future_consent where id=q.id returning * into q;
    return to_jsonb(q);
  end if;
  if q.confirmed_at is null or p_accepted is distinct from false or p_future is distinct from false or p_consent is not null or p_future_consent is not null then
    raise exception 'Monthly dispatch requires existing explicit confirmation'; end if;
  update public.monthly_mentorship_retry_quotes_v1 set dispatch_consumed_at=clock_timestamp() where id=q.id returning * into q;
  return jsonb_build_object('dispatch',true,'retry',to_jsonb(q));
end;
$$;
create or replace function public.guard_monthly_mentorship_billing_request_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_first jsonb; v_params jsonb; v_metadata jsonb;
begin
  if new.kind not in ('activate','collect') then return new; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=new.agreement_id;
  select provider_proof into v_first from public.monthly_mentorship_receipts_v1 where agreement_id=a.id and month_number=1;
  if not coalesce(v_first->>'paymentMethodId' ~ '^pm_[A-Za-z0-9_]+$',false) or a.anchor_at is null then
    raise exception 'Monthly billing requires the captured owned card and anchor'; end if;
  if new.kind='collect' then
    v_params:=jsonb_build_object('payment_method',public.monthly_card_for_service_v1(a.id,new.scope_key::integer),'off_session',true,'forgive',false,'paid_out_of_band',false);
    if new.request->'params' is distinct from v_params then raise exception 'Monthly collection request differs from captured-card authority'; end if;
  else
    v_metadata:=jsonb_build_object('creatornet_membership_version','monthly-mentorship-stripe-v1','creatornet_membership_id',a.id::text,
      'creatornet_membership_fingerprint',a.fingerprint,'buyer_id',a.buyer_id::text,'creator_id',a.creator_id::text,
      'product_id',a.product_id::text,'post_id',a.post_id::text,'creator_stripe_account_id',a.terms->>'destinationId',
      'kind','monthly_mentorship','operation_kind','subscription','creatornet_membership_activation','monthly-held-renewals-v1');
    v_params:=jsonb_build_object('trial_end',public.monthly_mentorship_boundary_v1(a.anchor_at,1),
      'cancel_at',case when a.auto_renew then to_jsonb(''::text) else to_jsonb(public.monthly_mentorship_boundary_v1(a.anchor_at,a.minimum_months)) end,
      'proration_behavior','none','default_payment_method',v_first->>'paymentMethodId',
      'pause_collection',jsonb_build_object('behavior','keep_as_draft'),
      'payment_settings',jsonb_build_object('payment_method_types',jsonb_build_array('card'),'save_default_payment_method','off'),
      'metadata',v_metadata);
    if new.request->>'path' is distinct from '/v1/subscriptions/'||a.stripe_subscription_id or
      new.request->'params' is distinct from v_params then raise exception 'Monthly activation differs from owned held schedule'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.guard_monthly_mentorship_collection_receipt_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype; v_first jsonb; v_invoice text; v_base text; v_next text; q public.monthly_mentorship_retry_quotes_v1%rowtype;
begin
  if new.month_number=1 then return new; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=new.agreement_id;
  select provider_proof into v_first from public.monthly_mentorship_receipts_v1 where agreement_id=a.id and month_number=1;
  v_invoice:=new.provider_proof->>'invoiceId';
  select * into o from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='collect'
    and scope_key=new.month_number::text for update;
  if not found or o.request->>'path' is distinct from '/v1/invoices/'||v_invoice||'/pay' or
    (o.status='complete' and o.provider_id is distinct from v_invoice) or
    not coalesce(new.provider_proof->>'collectionRequestId' ~ '^req_[A-Za-z0-9]+$',false) or
    (new.provider_proof->>'providerPeriodStart')::bigint is distinct from
      public.monthly_mentorship_boundary_v1(public.monthly_mentorship_boundary_v1(a.anchor_at,1),new.month_number-2) or
    (new.provider_proof->>'providerPeriodEnd')::bigint is distinct from
      public.monthly_mentorship_boundary_v1(public.monthly_mentorship_boundary_v1(a.anchor_at,1),new.month_number-1) then
    raise exception 'Monthly renewal receipt lacks its owned collection admission'; end if;
  if exists(select 1 from public.monthly_mentorship_renewal_recoveries_v1 recovery where recovery.operation_id=o.id and
    recovery.payment_intent_id is distinct from new.provider_proof->>'paymentIntentId') then
    raise exception 'Monthly receipt cannot replace the original recovery payment'; end if;
  v_base:=o.request->'params'->>'payment_method'; v_next:=v_base;
  if new.provider_proof->>'retryQuoteId' is not null then
    select * into q from public.monthly_mentorship_retry_quotes_v1 where id=(new.provider_proof->>'retryQuoteId')::uuid and operation_id=o.id for update;
    if not found or q.dispatch_consumed_at is null or q.confirmed_at is null or
      q.snapshot->>'paymentIntentId' is distinct from new.provider_proof->>'paymentIntentId' or
      q.snapshot->>'replacementPaymentMethodId' is distinct from new.provider_proof->>'paymentMethodId' or
      q.invoice_id is distinct from v_invoice or q.agreement_id is distinct from a.id or
      not coalesce(new.provider_proof->>'paidAt' ~ '^[0-9]{1,12}$',false) or
      (new.provider_proof->>'paidAt')::bigint<floor(extract(epoch from q.dispatch_consumed_at))::bigint then
      raise exception 'Monthly replacement capture lacks its exact retry admission'; end if;
    if q.use_future_card then v_next:=q.snapshot->>'replacementPaymentMethodId'; end if;
  elsif new.provider_proof->>'paymentMethodId' is distinct from v_base then
    raise exception 'Monthly captured card differs from its original admission'; end if;
  if new.provider_proof->>'nextPaymentMethodId' is distinct from v_next and
    (new.provider_proof ? 'nextPaymentMethodId' or v_next is distinct from v_base) then
    raise exception 'Monthly future-card authority lacks its accepted successful retry'; end if;
  -- A delayed captured result may finish an old/review operation. This is
  -- observation only; no expired idempotency key is reused and no debit sent.
  if o.status<>'complete' then
    update public.monthly_mentorship_operations_v1 set status='complete',provider_id=v_invoice,
      provider_request_id=new.provider_proof->>'collectionRequestId',completed_at=clock_timestamp() where id=o.id;
  end if;
  return new;
end;
$$;

create or replace function public.monthly_card_setup_basis_v1(p_operation uuid,p_buyer uuid,p_context jsonb) returns jsonb
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
    exists(select 1 from public.monthly_mentorship_retry_quotes_v1 q where q.operation_id=o.id and q.dispatch_consumed_at is not null) or
    exists(select 1 from public.payment_fee_ledger where stripe_invoice_id=r.invoice_id or stripe_payment_intent_id=r.payment_intent_id) or
    exists(select 1 from public.monthly_mentorship_receipts_v1 mr join public.payment_fee_ledger l on l.id=mr.ledger_id
      where mr.agreement_id=a.id and (l.status<>'paid' or l.refunded_amount_cents<>0 or
        (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')))) then
    raise exception 'Monthly card setup requires a fresh eligible unpaid attempt'; end if;
  if (a.billing_review_at is not null and not exists(select 1 from public.monthly_mentorship_lifecycle_v1 e
    where e.event_id=a.billing_review_reason and e.agreement_id=a.id and e.object_id=r.invoice_id and
      e.event_type in ('invoice.payment_failed','invoice.payment_action_required'))) or
    exists(select 1 from public.monthly_mentorship_lifecycle_v1 e where e.agreement_id=a.id and e.outcome='review_required' and e.payment_recovery_resolved_at is null and
      (e.object_id<>r.invoice_id or e.event_type not in ('invoice.payment_failed','invoice.payment_action_required'))) then
    raise exception 'Unrelated monthly billing review cannot authorize card setup'; end if;
  return jsonb_build_object('membershipId',a.id,'operationId',o.id,'invoiceId',r.invoice_id,'paymentIntentId',r.payment_intent_id,
    'customerId',a.stripe_customer_id,'subscriptionId',a.stripe_subscription_id,'originalPaymentMethodId',o.request->'params'->>'payment_method',
    'monthlyPriceCents',a.monthly_price_cents,'periodStart',(r.latest_observation->>'periodStart')::bigint,
    'periodEnd',(r.latest_observation->>'periodEnd')::bigint,'revision',a.revision,'fingerprint',a.fingerprint,'paymentContext',p_context);
end;
$$;


create function public.resolve_paid_monthly_failure_review_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare r public.monthly_mentorship_receipts_v1%rowtype; l public.payment_fee_ledger%rowtype; v_invoice text;
begin
  if new.covered_months<=old.covered_months or new.billing_review_at is null or new.financial_hold_at is not null then return new; end if;
  select * into r from public.monthly_mentorship_receipts_v1 where agreement_id=new.id and month_number=new.covered_months;
  select * into l from public.payment_fee_ledger where id=r.ledger_id;
  v_invoice:=r.provider_proof->>'invoiceId';
  if v_invoice is null or l.earnings_credited_at is null or l.status<>'paid' or l.refunded_amount_cents<>0 or
    (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')) or
    not exists(select 1 from public.monthly_mentorship_lifecycle_v1 e where e.event_id=new.billing_review_reason and e.agreement_id=new.id and
      e.object_id=v_invoice and e.event_type in ('invoice.payment_failed','invoice.payment_action_required')) or
    exists(select 1 from public.monthly_mentorship_lifecycle_v1 e where e.agreement_id=new.id and e.outcome='review_required' and
      e.payment_recovery_resolved_at is null and (e.object_id<>v_invoice or e.event_type not in ('invoice.payment_failed','invoice.payment_action_required'))) then return new; end if;
  update public.monthly_mentorship_lifecycle_v1 set payment_recovery_resolved_at=clock_timestamp(),payment_recovery_receipt_month=new.covered_months
    where agreement_id=new.id and object_id=v_invoice and event_type in ('invoice.payment_failed','invoice.payment_action_required') and payment_recovery_resolved_at is null;
  update public.monthly_mentorship_agreements_v1 set billing_review_at=null,billing_review_reason=null,revision=revision+1,
    billing_next_attempt_at=case when renewal_stopped_at is not null or debit_revoked_at is not null then 'infinity'::timestamptz
      else to_timestamp(public.monthly_mentorship_boundary_v1(anchor_at,covered_months)) end where id=new.id;
  return new;
end;
$$;
create trigger resolve_paid_monthly_failure_review_v1 after update of covered_months on public.monthly_mentorship_agreements_v1
  for each row execute function public.resolve_paid_monthly_failure_review_v1();
revoke all on function public.monthly_card_for_service_v1(uuid,integer),public.monthly_retry_v1(text,uuid,uuid,uuid,jsonb,boolean,text,boolean,text),
  public.resolve_paid_monthly_failure_review_v1() from public,anon,authenticated,service_role;
grant execute on function public.monthly_retry_v1(text,uuid,uuid,uuid,jsonb,boolean,text,boolean,text) to service_role;
commit;
