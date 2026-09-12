-- UNAPPLIED. Locked steps 1/2/5/8/10. Existing-payment bank authentication only.
-- This read gate cannot revoke an already released Stripe client secret.
-- Keep BANK_VERIFICATION_READY and BANK_STOP_COORDINATION_READY disabled until
-- hosted challenge/stop ordering is accepted. Never store or log client secrets.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regclass('public.monthly_mentorship_retry_quotes_v1') is null or
    to_regprocedure('public.read_monthly_mentorship_bank_context_v1(uuid,uuid,text,jsonb)') is not null then
    raise exception 'Monthly bank verification prerequisites differ'; end if;
end; $preflight$;
create function public.read_monthly_mentorship_bank_context_v1(p_id uuid,p_buyer uuid,p_invoice text,p_context jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype;
  r public.monthly_mentorship_renewal_recoveries_v1%rowtype; q public.monthly_mentorship_retry_quotes_v1%rowtype;
  v_now bigint; v_card text; v_admitted bigint; v_start bigint; v_end bigint;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer for update;
  if not found or a.terms->'paymentContext' is distinct from p_context or not coalesce(p_invoice ~ '^in_[A-Za-z0-9]+$',false) then
    raise exception 'Monthly bank context owner differs'; end if;
  select * into o from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='collect'
    and request->>'path'='/v1/invoices/'||p_invoice||'/pay' for update;
  select * into r from public.monthly_mentorship_renewal_recoveries_v1 where operation_id=o.id for update;
  v_now:=floor(extract(epoch from clock_timestamp()))::bigint;
  v_start:=public.monthly_mentorship_boundary_v1(a.anchor_at,a.covered_months);
  v_end:=public.monthly_mentorship_boundary_v1(a.anchor_at,a.covered_months+1);
  if o.id is null or o.status not in ('dispatched','review_required') or o.scope_key is distinct from (a.covered_months+1)::text or
    a.covered_months<1 or a.anchor_at is null or (not a.auto_renew and a.covered_months>=a.minimum_months) or
    a.financial_hold_at is not null or a.payoff_hold_at is not null or a.debit_revoked_at is not null or a.renewal_stopped_at is not null or
    r.operation_id is null or r.agreement_id is distinct from a.id or r.invoice_id is distinct from p_invoice or
    r.month_number is distinct from a.covered_months+1 or r.outcome is distinct from 'action_required' or
    r.latest_observation->>'invoiceStatus' is distinct from 'open' or r.latest_observation->>'paymentStatus' is distinct from 'requires_action' or
    r.latest_observation->>'paymentIntentId' is distinct from r.payment_intent_id or
    r.latest_observation->>'originalPaymentMethodId' is distinct from o.request->'params'->>'payment_method' or
    r.latest_observation->>'amountDueCents' is distinct from a.monthly_price_cents::text or
    r.latest_observation->>'amountPaidCents' is distinct from '0' or r.latest_observation->>'amountReceivedCents' is distinct from '0' or
    r.latest_observation->>'amountCapturableCents' is distinct from '0' or
    r.latest_observation->>'periodStart' is distinct from v_start::text or r.latest_observation->>'periodEnd' is distinct from v_end::text or
    not coalesce(r.latest_observation->>'observedAt' ~ '^[0-9]{1,12}$',false) or
    (r.latest_observation->>'observedAt')::bigint<v_now-60 or (r.latest_observation->>'observedAt')::bigint>v_now+1 or
    v_start>v_now or v_end<=v_now or
    exists(select 1 from public.payment_fee_ledger where stripe_invoice_id=p_invoice or stripe_payment_intent_id=r.payment_intent_id) or
    exists(select 1 from public.monthly_mentorship_receipts_v1 mr join public.payment_fee_ledger l on l.id=mr.ledger_id
      where mr.agreement_id=a.id and (l.status<>'paid' or l.refunded_amount_cents<>0 or
        (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')))) then
    raise exception 'Monthly bank verification requires fresh eligible original unpaid action'; end if;
  if (a.billing_review_at is not null and not exists(select 1 from public.monthly_mentorship_lifecycle_v1 e
    where e.event_id=a.billing_review_reason and e.agreement_id=a.id and e.object_id=p_invoice and
      e.event_type in ('invoice.payment_failed','invoice.payment_action_required'))) or
    exists(select 1 from public.monthly_mentorship_lifecycle_v1 e where e.agreement_id=a.id and e.outcome='review_required' and
      e.payment_recovery_resolved_at is null and (e.object_id<>p_invoice or e.event_type not in ('invoice.payment_failed','invoice.payment_action_required'))) then
    raise exception 'Unrelated monthly billing review cannot release bank authentication'; end if;
  v_card:=o.request->'params'->>'payment_method';
  if o.request is distinct from jsonb_build_object('method','POST','path','/v1/invoices/'||p_invoice||'/pay',
    'params',jsonb_build_object('payment_method',v_card,'off_session',true,'forgive',false,'paid_out_of_band',false)) then
    raise exception 'Monthly bank original collection request differs'; end if;
  v_admitted:=floor(extract(epoch from o.dispatched_at))::bigint;
  select * into q from public.monthly_mentorship_retry_quotes_v1 where operation_id=o.id and dispatch_consumed_at is not null for update;
  if found then
    if q.confirmed_at is null or q.agreement_id is distinct from a.id or q.buyer_id is distinct from p_buyer or
      q.invoice_id is distinct from p_invoice or q.month_number is distinct from r.month_number or
      q.snapshot->'paymentContext' is distinct from p_context or q.snapshot->>'fingerprint' is distinct from a.fingerprint or
      q.snapshot->>'paymentIntentId' is distinct from r.payment_intent_id or q.snapshot->>'originalPaymentMethodId' is distinct from v_card or
      q.snapshot->>'monthlyPriceCents' is distinct from a.monthly_price_cents::text or
      q.snapshot->>'periodStart' is distinct from v_start::text or q.snapshot->>'periodEnd' is distinct from v_end::text then
      raise exception 'Monthly bank retry admission differs'; end if;
    v_card:=q.snapshot->>'replacementPaymentMethodId'; v_admitted:=floor(extract(epoch from q.dispatch_consumed_at))::bigint;
  end if;
  if not coalesce(v_card ~ '^pm_[A-Za-z0-9]+$',false) or v_admitted is null or v_admitted<v_start or v_admitted>v_now then
    raise exception 'Monthly bank card or admission time differs'; end if;
  return jsonb_build_object('version','monthly-bank-context-v1','membershipId',a.id,'buyerId',p_buyer,'operationId',o.id,
    'invoiceId',p_invoice,'paymentIntentId',r.payment_intent_id,'paymentMethodId',v_card,'originalPaymentMethodId',o.request->'params'->>'payment_method',
    'customerId',a.stripe_customer_id,'subscriptionId',a.stripe_subscription_id,'paymentContext',p_context,'fingerprint',a.fingerprint,
    'revision',a.revision,'month',r.month_number,'amountCents',a.monthly_price_cents,'periodStart',v_start,'periodEnd',v_end,
    'admittedAt',v_admitted,'retryQuoteId',q.id);
end;
$$;
revoke all on function public.read_monthly_mentorship_bank_context_v1(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.read_monthly_mentorship_bank_context_v1(uuid,uuid,text,jsonb) to service_role;
commit;
