begin;

-- Local candidate after 019,021,040-045. Observe Stripe refund state; never
-- create a refund, forgive debt, revoke/grant access or resume collection.
alter table public.exact_installment_collection_holds
  add column stripe_event_id text unique check(stripe_event_id ~ '^evt_[a-zA-Z0-9]+$'),
  add column stripe_payment_intent_id text check(stripe_payment_intent_id ~ '^pi_[a-zA-Z0-9]+$'),
  alter column requested_by drop not null;
alter table public.exact_installment_collection_holds
  drop constraint exact_installment_collection_holds_reason_check,
  drop constraint exact_installment_collection_holds_check;
alter table public.exact_installment_collection_holds
  add constraint exact_installment_collection_holds_reason_check
    check(reason in ('admin_refund','cancellation_review','verified_refund')),
  add constraint exact_installment_collection_holds_source_check check(
    (reason='admin_refund' and requested_by is not null and refund_operation_id is not null and
      request_id=refund_operation_id and stripe_event_id is null and stripe_payment_intent_id is null) or
    (reason='cancellation_review' and requested_by is not null and refund_operation_id is null and
      stripe_event_id is null and stripe_payment_intent_id is null) or
    (reason='verified_refund' and requested_by is null and refund_operation_id is null and
      stripe_event_id is not null and stripe_payment_intent_id is not null));

-- The server retrieves the current captured Charge/PI/balance before calling.
-- All writes are one transaction, using the established agreement -> ledger ->
-- profile order. A first payment has no invoice ID and must not use the latest
-- purchase PI to locate its ledger. Even a closed plan may receive late refunds.
create function public.hold_exact_installment_refund_event(p_agreement_id uuid,p_event_id text,
  p_payment_intent_id text,p_charge_id text,p_gross_cents bigint)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  r public.exact_installment_receipts%rowtype;
  l public.payment_fee_ledger%rowtype;
  h public.exact_installment_collection_holds%rowtype;
begin
  if p_event_id is null or p_event_id !~ '^evt_[a-zA-Z0-9]+$' or
    p_payment_intent_id is null or p_payment_intent_id !~ '^pi_[a-zA-Z0-9]+$' or
    p_charge_id is null or p_charge_id !~ '^ch_[a-zA-Z0-9]+$' or
    p_gross_cents is null or p_gross_cents not between 1 and 99999999 then
    raise exception 'invalid exact refund evidence'; end if;
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.purchase_id is null then raise exception 'refund agreement missing'; end if;
  select * into r from public.exact_installment_receipts where agreement_id=a.id and stripe_payment_intent_id=p_payment_intent_id;
  if not found or r.counted_at is null or r.ledger_id is null then raise exception 'refund receipt not credited yet'; end if;
  select * into l from public.payment_fee_ledger where id=r.ledger_id for update;
  if not found or l.earnings_credited_at is null or l.stripe_payment_intent_id is distinct from p_payment_intent_id or
    l.stripe_charge_id is distinct from p_charge_id or l.stripe_invoice_id is distinct from r.stripe_invoice_id or
    l.gross_amount_cents is distinct from p_gross_cents or r.amount_cents is distinct from p_gross_cents or
    l.total_creator_deduction_cents is distinct from r.application_fee_cents or l.purchase_id is distinct from a.purchase_id or
    l.creator_id::text is distinct from a.terms->>'creatorId' or l.booking_payment_id is distinct from a.booking_payment_id or
    l.currency is distinct from 'usd' or l.status not in ('paid','refunded') then
    raise exception 'refund ledger identity mismatch'; end if;
  insert into public.exact_installment_collection_holds(agreement_id,reason,request_id,stripe_event_id,stripe_payment_intent_id)
    values(a.id,'verified_refund',gen_random_uuid(),p_event_id,p_payment_intent_id) on conflict(stripe_event_id) do nothing;
  select * into h from public.exact_installment_collection_holds where stripe_event_id=p_event_id;
  if not found or h.agreement_id is distinct from a.id or h.reason<>'verified_refund' or
    h.stripe_payment_intent_id is distinct from p_payment_intent_id then raise exception 'refund event identity changed'; end if;
  -- A verified refund EVENT is not necessarily a successful refund. Pending,
  -- failed/canceled or inconsistent external state only installs this hold.
  return l.id;
end;
$$;

create function public.apply_exact_installment_refund_event(p_agreement_id uuid,p_event_id text,
  p_payment_intent_id text,p_charge_id text,p_gross_cents bigint,p_refunded_cents bigint)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare
  ledger_id uuid;
  prior public.payment_refund_state%rowtype;
  cumulative bigint;
begin
  if p_refunded_cents is null or p_refunded_cents not between 1 and p_gross_cents then
    raise exception 'invalid exact refund evidence'; end if;
  ledger_id:=public.hold_exact_installment_refund_event(p_agreement_id,p_event_id,p_payment_intent_id,p_charge_id,p_gross_cents);
  select * into prior from public.payment_refund_state where stripe_payment_intent_id=p_payment_intent_id for update;
  if found and (prior.stripe_charge_id is distinct from p_charge_id or prior.charge_amount_cents is distinct from p_gross_cents) then
    raise exception 'prior refund identity mismatch'; end if;
  cumulative:=public.record_payment_refund_state(p_payment_intent_id,p_charge_id,p_gross_cents,p_refunded_cents);
  if cumulative is null or cumulative<p_refunded_cents or cumulative>p_gross_cents then
    raise exception 'invalid cumulative refund result'; end if;
  perform public.apply_payment_fee_ledger_refund(ledger_id,cumulative);
  -- No write to purchases, bookings or agreement status. The existing refund
  -- RPC owns reversal arithmetic; replay cannot debit creator earnings twice.
  return cumulative;
end;
$$;
revoke all on function public.apply_exact_installment_refund_event(uuid,text,text,text,bigint,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.apply_exact_installment_refund_event(uuid,text,text,text,bigint,bigint) to service_role;
revoke all on function public.hold_exact_installment_refund_event(uuid,text,text,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.hold_exact_installment_refund_event(uuid,text,text,text,bigint) to service_role;
commit;
