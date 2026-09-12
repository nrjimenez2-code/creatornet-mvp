-- UNAPPLIED. Requires 021 and monthly proposals through 094.
-- Reuses the existing billing-review hold and operation/receipt journals.
-- No refund allocation, debt, service date, or paid-access changes.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create or replace function public.admit_monthly_mentorship_admin_refund_v1(p_operation_id uuid,p_processing_token uuid)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare o public.refund_operations%rowtype; a public.monthly_mentorship_agreements_v1%rowtype;
  l public.payment_fee_ledger%rowtype; v_agreement uuid;
begin
  select * into o from public.refund_operations where id=p_operation_id;
  if not found or p_processing_token is null then raise exception 'Refund operation missing'; end if;
  select m.id into v_agreement from public.payment_fee_ledger ledger
    join public.monthly_mentorship_agreements_v1 m on m.purchase_id=ledger.purchase_id where ledger.id=o.payment_fee_ledger_id;
  if v_agreement is null then return 'not_applicable'; end if;
  -- Same first lock as monthly collection, retry, payoff and bank admission.
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_agreement for update;
  select * into o from public.refund_operations where id=p_operation_id for update;
  if o.processing_token is distinct from p_processing_token or o.processing_claimed_at is null or
    o.processing_claimed_at<=clock_timestamp()-interval '5 minutes' or o.status in ('failed','completed') or
    not exists(select 1 from public.profiles where id=o.initiated_by and role='admin') then
    raise exception 'Monthly refund claim or administrator invalid'; end if;
  select * into l from public.payment_fee_ledger where id=o.payment_fee_ledger_id for update;
  if not found or l.purchase_id is distinct from a.purchase_id or l.creator_id is distinct from a.creator_id or
    o.creator_id is distinct from a.creator_id or l.stripe_payment_intent_id is distinct from o.stripe_payment_intent_id or
    l.earnings_credited_at is null or not (
      exists(select 1 from public.monthly_mentorship_receipts_v1 r where r.agreement_id=a.id and r.ledger_id=l.id) or
      exists(select 1 from public.monthly_mentorship_payoffs_v1 p where p.agreement_id=a.id and p.ledger_id=l.id and p.status='captured')) then
    raise exception 'Monthly refund lacks its credited owned receipt'; end if;

  -- Persist even if an already dispatched payment needs reconciliation. Do not
  -- raise after this write: rolling back the hold would reopen collection.
  -- A recoverable invoice-event reason can be cleared automatically when its
  -- receipt arrives. Retain that reason as context, but make this hold distinct
  -- so receipt reconciliation cannot reopen collection during the refund.
  if a.billing_review_reason is null or a.billing_review_reason not like 'admin_refund:%' then
    update public.monthly_mentorship_agreements_v1 set billing_review_at=coalesce(billing_review_at,clock_timestamp()),
      billing_review_reason='admin_refund:'||o.id::text||coalesce(';prior:'||billing_review_reason,''),
      revision=revision+1 where id=a.id;
  end if;
  if exists(select 1 from public.monthly_mentorship_operations_v1 c where c.agreement_id=a.id and c.kind='collect' and
    not exists(select 1 from public.monthly_mentorship_receipts_v1 r join public.payment_fee_ledger receipt_ledger on receipt_ledger.id=r.ledger_id
      where r.agreement_id=a.id and r.month_number::text=c.scope_key and
        c.request->>'path'='/v1/invoices/'||(r.provider_proof->>'invoiceId')||'/pay' and receipt_ledger.earnings_credited_at is not null)) or
    exists(select 1 from public.monthly_mentorship_payoffs_v1 p where p.agreement_id=a.id and p.status not in ('captured','abandoned')) then
    return 'reconciliation_required';
  end if;
  return 'held';
end;
$$;
revoke all on function public.admit_monthly_mentorship_admin_refund_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.admit_monthly_mentorship_admin_refund_v1(uuid,uuid) to service_role;
commit;
-- Retain review holds on rollback. Clearing them needs reconciliation; it is
-- never an automatic consequence of refund failure or a worker lease expiring.
