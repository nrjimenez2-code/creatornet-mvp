-- UNAPPLIED. Locked steps 1/5/8. Original renewal attempt observation only.
-- No card setup, new payment authority, balance waiver or parallel money ledger.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or to_regprocedure('public.reconcile_monthly_mentorship_activation_v1(uuid,uuid,jsonb,jsonb)') is null or
    to_regclass('public.monthly_mentorship_renewal_recoveries_v1') is not null then raise exception 'Monthly recovery prerequisites differ'; end if;
end;
$preflight$;
create table public.monthly_mentorship_renewal_recoveries_v1 (
  operation_id uuid primary key references public.monthly_mentorship_operations_v1(id),
  agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  invoice_id text not null unique check(invoice_id ~ '^in_[A-Za-z0-9]+$'),
  payment_intent_id text not null unique check(payment_intent_id ~ '^pi_[A-Za-z0-9]+$'),
  month_number integer not null check(month_number>=2),
  outcome text not null check(outcome in ('payment_method_required','action_required','payment_pending','terminal_unpaid','paid_accounted','review_required')),
  first_observation jsonb not null, latest_observation jsonb not null,
  first_observed_at timestamptz not null default clock_timestamp(),
  last_observed_at timestamptz not null default clock_timestamp(),
  unique(agreement_id,month_number)
);
alter table public.monthly_mentorship_renewal_recoveries_v1 enable row level security;
revoke all on public.monthly_mentorship_renewal_recoveries_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_renewal_recoveries_v1 to service_role;

create function public.record_monthly_mentorship_renewal_recovery_v1(p_id uuid,p_buyer_id uuid,p_operation_id uuid,p_context jsonb,
  p_revision bigint,p_outcome text,p_proof jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype;
  r public.monthly_mentorship_renewal_recoveries_v1%rowtype; receipt public.monthly_mentorship_receipts_v1%rowtype;
  v_month integer; v_invoice text; v_now bigint:=floor(extract(epoch from clock_timestamp()))::bigint;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or p_context is distinct from a.terms->'paymentContext' then raise exception 'Monthly recovery owner differs'; end if;
  select * into o from public.monthly_mentorship_operations_v1 where id=p_operation_id and agreement_id=a.id and kind='collect' for update;
  if not found or not coalesce(o.scope_key ~ '^[1-9][0-9]{0,8}$',false) or o.scope_key::integer<2 or
    not coalesce(o.request->>'path' ~ '^/v1/invoices/in_[A-Za-z0-9]+/pay$',false) then
    raise exception 'Monthly recovery requires its original collection operation'; end if;
  v_month:=o.scope_key::integer; v_invoice:=split_part(o.request->>'path','/',4);
  if p_outcome is null or p_outcome not in ('payment_method_required','action_required','payment_pending','terminal_unpaid','paid_accounted','review_required') or
    p_proof->>'version' is distinct from 'monthly-renewal-recovery-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    p_proof->>'operationId' is distinct from o.id::text or p_proof->>'invoiceId' is distinct from v_invoice or
    p_proof->>'customerId' is distinct from a.stripe_customer_id or p_proof->>'subscriptionId' is distinct from a.stripe_subscription_id or
    p_proof->>'originalPaymentMethodId' is distinct from o.request->'params'->>'payment_method' or
    p_proof->>'month' is distinct from v_month::text or
    p_proof->>'periodStart' is distinct from public.monthly_mentorship_boundary_v1(a.anchor_at,v_month-1)::text or
    p_proof->>'periodEnd' is distinct from public.monthly_mentorship_boundary_v1(a.anchor_at,v_month)::text or
    p_proof->>'amountDueCents' is distinct from a.monthly_price_cents::text or p_proof->>'amountCapturableCents' is distinct from '0' or
    not coalesce(p_proof->>'paymentIntentId' ~ '^pi_[A-Za-z0-9]+$',false) or
    not coalesce(p_proof->>'invoiceRequestId' ~ '^req_[A-Za-z0-9]+$',false) or
    not coalesce(p_proof->>'paymentRequestId' ~ '^req_[A-Za-z0-9]+$',false) or
    not coalesce(p_proof->>'attemptCount' ~ '^[0-9]{1,8}$',false) or
    not coalesce(p_proof->>'observedAt' ~ '^[0-9]{1,12}$',false) or
    (p_proof->>'observedAt')::bigint<v_now-300 or (p_proof->>'observedAt')::bigint>v_now+1 then
    raise exception 'Monthly recovery provider proof differs'; end if;
  select * into receipt from public.monthly_mentorship_receipts_v1 where agreement_id=a.id and month_number=v_month;
  if p_outcome='paid_accounted' then
    if receipt.ledger_id is null or receipt.provider_proof->>'invoiceId' is distinct from v_invoice or
      receipt.provider_proof->>'paymentIntentId' is distinct from p_proof->>'paymentIntentId' or
      p_proof->>'invoiceStatus' is distinct from 'paid' or p_proof->>'paymentStatus' is distinct from 'succeeded' or
      p_proof->>'amountPaidCents' is distinct from a.monthly_price_cents::text or
      p_proof->>'amountReceivedCents' is distinct from a.monthly_price_cents::text then
      raise exception 'Monthly paid recovery requires its existing ledger receipt'; end if;
  else
    if receipt.ledger_id is not null or exists(select 1 from public.payment_fee_ledger where stripe_invoice_id=v_invoice or stripe_payment_intent_id=p_proof->>'paymentIntentId') or
      a.revision is distinct from p_revision or o.status='complete' or
      p_proof->>'invoiceStatus' is distinct from 'open' or p_proof->>'amountPaidCents' is distinct from '0' or
      p_proof->>'amountReceivedCents' is distinct from '0' then raise exception 'Monthly unpaid recovery state changed'; end if;
    if p_outcome<>'review_required' and (a.financial_hold_at is not null or a.debit_revoked_at is not null or a.renewal_stopped_at is not null or
      (p_proof->>'periodStart')::bigint>v_now or (p_proof->>'periodEnd')::bigint<=v_now) then
      raise exception 'Monthly stopped or elapsed recovery requires review'; end if;
    if not coalesce(case p_outcome
      when 'payment_method_required' then p_proof->>'paymentStatus'='requires_payment_method' and (p_proof->>'attemptCount')::integer>0
      when 'action_required' then p_proof->>'paymentStatus'='requires_action' and (p_proof->>'attemptCount')::integer>0
      when 'payment_pending' then p_proof->>'paymentStatus' in ('processing','requires_confirmation','requires_payment_method')
      when 'terminal_unpaid' then p_proof->>'paymentStatus'='canceled'
      when 'review_required' then true else false end,false) then raise exception 'Monthly recovery outcome differs'; end if;
  end if;
  select * into r from public.monthly_mentorship_renewal_recoveries_v1 where operation_id=o.id for update;
  if found and (r.agreement_id<>a.id or r.invoice_id<>v_invoice or r.month_number<>v_month or
    r.payment_intent_id is distinct from p_proof->>'paymentIntentId') then raise exception 'Original monthly recovery binding cannot change'; end if;
  if r.operation_id is not null and r.outcome='paid_accounted' and p_outcome<>'paid_accounted' then
    raise exception 'Captured monthly recovery cannot regress'; end if;
  if r.operation_id is null then
    insert into public.monthly_mentorship_renewal_recoveries_v1(operation_id,agreement_id,invoice_id,payment_intent_id,month_number,outcome,first_observation,latest_observation)
      values(o.id,a.id,v_invoice,p_proof->>'paymentIntentId',v_month,p_outcome,p_proof,p_proof) returning * into r;
  else
    update public.monthly_mentorship_renewal_recoveries_v1 set outcome=p_outcome,latest_observation=p_proof,last_observed_at=clock_timestamp()
      where operation_id=o.id returning * into r;
  end if;
  -- Original age, parameters, agreement revision and every stop flag survive.
  -- A reviewed attempt is observation-only until separately accepted recovery.
  if p_outcome<>'paid_accounted' and o.status='dispatched' then
    update public.monthly_mentorship_operations_v1 set status='review_required',review_reason='buyer_renewal_recovery' where id=o.id;
  end if;
  return to_jsonb(r);
end;
$$;
revoke all on function public.record_monthly_mentorship_renewal_recovery_v1(uuid,uuid,uuid,jsonb,bigint,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_monthly_mentorship_renewal_recovery_v1(uuid,uuid,uuid,jsonb,bigint,text,jsonb) to service_role;
commit;
