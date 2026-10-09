-- Read-only aggregate. Requires the existing SQL078/085/087 monthly schema.
-- Service role only; the app must authenticate an administrator before calling.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create function public.read_monthly_mentorship_billing_backlog_v1(p_context jsonb)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
  with agreements as materialized (
    select a.*, exists(select 1 from public.monthly_mentorship_operations_v1 o
      where o.agreement_id=a.id and o.kind='activate' and o.status='complete') activated
    from public.monthly_mentorship_agreements_v1 a where a.terms->'paymentContext'=p_context
  ), billing_due as (
    select greatest(a.billing_next_attempt_at,case when a.activated then
      to_timestamp(public.monthly_mentorship_boundary_v1(a.anchor_at,a.covered_months)) else a.billing_next_attempt_at end) due_at
    from agreements a where a.covered_months>=1 and a.anchor_at is not null and
      a.billing_review_at is null and a.payoff_hold_at is null and a.financial_hold_at is null and
      a.renewal_stopped_at is null and a.debit_revoked_at is null and a.billing_next_attempt_at<=statement_timestamp() and
      (a.billing_lease_until is null or a.billing_lease_until<=statement_timestamp()) and
      (not a.activated or ((a.auto_renew or a.covered_months<a.minimum_months) and
        public.monthly_mentorship_boundary_v1(a.anchor_at,a.covered_months)<=extract(epoch from statement_timestamp())::bigint))
  ), exits as materialized (
    select e.*,a.renewal_stopped_at,a.debit_revoked_at from public.monthly_mentorship_exit_requests_v1 e
      join agreements a on a.id=e.agreement_id
  ), exit_due as (
    select e.provider_next_attempt_at due_at from exits e where e.status<>'provider_stopped' and
      e.provider_next_attempt_at<=statement_timestamp() and (e.provider_lease_until is null or e.provider_lease_until<=statement_timestamp()) and
      ((e.kind='stop_renewal' and e.renewal_stopped_at is not null) or (e.kind='revoke_debits' and e.debit_revoked_at is not null)) and
      not exists(select 1 from exits active where active.agreement_id=e.agreement_id and
        active.status<>'provider_stopped' and active.provider_lease_until>statement_timestamp())
  ) select jsonb_build_object(
    'context',p_context,'observedAt',statement_timestamp(),
    'agreementCount',(select count(*) from agreements),
    'billingDueCount',(select count(*) from billing_due),
    'billingOldestDueAt',(select min(due_at) from billing_due),
    'billingReviewCount',(select count(*) from agreements where billing_review_at is not null),
    'financialHoldCount',(select count(*) from agreements where financial_hold_at is not null),
    'billingRetryCount',(select count(*) from agreements where billing_worker_status='retry_required'),
    'billingLeasedCount',(select count(*) from agreements where billing_lease_until>statement_timestamp()),
    'exitCount',(select count(*) from exits),
    'exitDueCount',(select count(*) from exit_due),
    'exitOldestDueAt',(select min(due_at) from exit_due),
    'exitReviewCount',(select count(*) from exits where status<>'provider_stopped' and provider_worker_status='provider_review_required'),
    'exitRetryCount',(select count(*) from exits where status<>'provider_stopped' and provider_worker_status='retry_required'),
    'exitLeasedCount',(select count(*) from exits where status<>'provider_stopped' and provider_lease_until>statement_timestamp())
  );
$$;
revoke all on function public.read_monthly_mentorship_billing_backlog_v1(jsonb) from public,anon,authenticated;
grant execute on function public.read_monthly_mentorship_billing_backlog_v1(jsonb) to service_role;
commit;
