begin;

-- Private audit and collection fencing only. No dispute cost allocation,
-- customer refund, access revocation, debt waiver, or collection resumption.
alter table public.exact_installment_collection_holds add column stripe_object_id text;
alter table public.exact_installment_collection_holds
  drop constraint exact_installment_collection_holds_reason_check,
  drop constraint exact_installment_collection_holds_source_check;
alter table public.exact_installment_collection_holds
  add constraint exact_installment_collection_holds_reason_check
    check(reason in ('admin_refund','cancellation_review','verified_refund','verified_dispute','subscription_review')),
  add constraint exact_installment_collection_holds_source_check check(
    (reason='admin_refund' and requested_by is not null and refund_operation_id is not null and request_id=refund_operation_id and
      stripe_event_id is null and stripe_payment_intent_id is null and stripe_object_id is null) or
    (reason='cancellation_review' and requested_by is not null and refund_operation_id is null and
      stripe_event_id is null and stripe_payment_intent_id is null and stripe_object_id is null) or
    (reason='verified_refund' and requested_by is null and refund_operation_id is null and stripe_event_id is not null and
      stripe_payment_intent_id is not null and stripe_object_id is null) or
    (reason='verified_dispute' and requested_by is null and refund_operation_id is null and stripe_event_id is not null and
      stripe_payment_intent_id is not null and stripe_object_id is not null and stripe_object_id ~ '^du_[a-zA-Z0-9]+$') or
    (reason='subscription_review' and requested_by is null and refund_operation_id is null and stripe_event_id is not null and
      stripe_payment_intent_id is null and stripe_object_id is not null and stripe_object_id ~ '^sub_[a-zA-Z0-9]+$'));

create table public.exact_installment_lifecycle_observations (
  stripe_object_id text primary key check(stripe_object_id ~ '^(du|sub)_[a-zA-Z0-9]+$'),
  agreement_id uuid not null references public.exact_installment_agreements on delete restrict,
  revision bigint not null check(revision>0),
  stripe_event_id text not null check(stripe_event_id ~ '^evt_[a-zA-Z0-9]+$'),
  disposition text not null check(disposition in ('dispute_observed','expected_held_schedule','billing_stop_observed','scheduled_end_observed','review_required')),
  details jsonb not null check(jsonb_typeof(details)='object'),
  updated_at timestamptz not null default now()
);
alter table public.exact_installment_lifecycle_observations enable row level security;
revoke all on public.exact_installment_lifecycle_observations from public,anon,authenticated,service_role;
grant select on public.exact_installment_lifecycle_observations to service_role;

-- Compare-and-swap against both the last observation and the LOCAL lifecycle
-- used before the Stripe reads. Two different events cannot publish stale
-- concurrent reads over each other; a changed basis requires a fresh retrieve.
create function public.exact_installment_lifecycle_basis(p_agreement_id uuid)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select jsonb_build_object('agreementStatus',a.status,'activationStatus',act.status,
    'activation',act.activation_snapshot,'stopStatus',s.status,'stopCanceledAt',s.stripe_canceled_at)
  from public.exact_installment_agreements a
    left join public.exact_installment_activations act on act.agreement_id=a.id
    left join public.exact_installment_billing_stops s on s.agreement_id=a.id where a.id=p_agreement_id;
$$;
create function public.read_exact_installment_lifecycle(p_agreement_id uuid,p_object_id text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare o public.exact_installment_lifecycle_observations%rowtype; basis jsonb;
begin
  if p_object_id is null or p_object_id !~ '^(du|sub)_[a-zA-Z0-9]+$' then raise exception 'invalid lifecycle object'; end if;
  basis:=public.exact_installment_lifecycle_basis(p_agreement_id);
  if basis is null then raise exception 'lifecycle agreement missing'; end if;
  select * into o from public.exact_installment_lifecycle_observations where stripe_object_id=p_object_id;
  if found and o.agreement_id is distinct from p_agreement_id then raise exception 'lifecycle object owner differs'; end if;
  return jsonb_build_object('revision',coalesce(o.revision,0),'basis',basis);
end;
$$;
create function public.hold_exact_installment_lifecycle_event(p_agreement_id uuid,p_event_id text,p_object_id text,p_payment_intent_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; h public.exact_installment_collection_holds%rowtype; why text;
begin
  if p_event_id is null or p_event_id !~ '^evt_[a-zA-Z0-9]+$' or p_object_id is null then raise exception 'invalid lifecycle event'; end if;
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found then raise exception 'lifecycle agreement missing'; end if;
  if p_object_id ~ '^sub_[a-zA-Z0-9]+$' then
    if p_object_id is distinct from a.stripe_subscription_id or p_payment_intent_id is not null then
      raise exception 'subscription hold identity differs'; end if;
    why:='subscription_review';
  elsif p_object_id ~ '^du_[a-zA-Z0-9]+$' then
    if p_payment_intent_id is null or not (
      exists(select 1 from public.exact_installment_receipts where agreement_id=a.id and stripe_payment_intent_id=p_payment_intent_id) or
      exists(select 1 from public.exact_installment_invoice_claims where agreement_id=a.id and stripe_payment_intent_id=p_payment_intent_id)) then
      raise exception 'dispute payment binding missing'; end if;
    why:='verified_dispute';
  else raise exception 'invalid lifecycle object'; end if;
  insert into public.exact_installment_collection_holds(agreement_id,reason,request_id,stripe_event_id,stripe_object_id,stripe_payment_intent_id)
    values(a.id,why,gen_random_uuid(),p_event_id,p_object_id,p_payment_intent_id) on conflict(stripe_event_id) do nothing;
  select * into h from public.exact_installment_collection_holds where stripe_event_id=p_event_id;
  if h.agreement_id is distinct from a.id or h.reason is distinct from why or h.stripe_object_id is distinct from p_object_id or
    h.stripe_payment_intent_id is distinct from p_payment_intent_id then raise exception 'lifecycle event identity differs'; end if;
end;
$$;
create function public.finish_exact_installment_lifecycle(p_agreement_id uuid,p_event_id text,p_object_id text,
  p_revision bigint,p_basis jsonb,p_disposition text,p_details jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; o public.exact_installment_lifecycle_observations%rowtype; saved boolean;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or p_revision is null or p_revision<0 or p_event_id is null or p_event_id !~ '^evt_[a-zA-Z0-9]+$' then
    raise exception 'invalid lifecycle observation'; end if;
  if p_object_id is null or p_object_id !~ '^(du|sub)_[a-zA-Z0-9]+$' or
    (p_object_id ~ '^sub_' and p_object_id is distinct from a.stripe_subscription_id) then raise exception 'lifecycle object differs'; end if;
  select * into o from public.exact_installment_lifecycle_observations where stripe_object_id=p_object_id for update;
  if found and o.agreement_id is distinct from a.id then raise exception 'lifecycle owner differs'; end if;
  if coalesce(o.revision,0)<>p_revision or p_basis is distinct from public.exact_installment_lifecycle_basis(a.id) then return false; end if;
  if (p_disposition='review_required' or p_object_id ~ '^du_') and not exists(select 1 from public.exact_installment_collection_holds
    where agreement_id=a.id and stripe_event_id=p_event_id and stripe_object_id=p_object_id) then raise exception 'lifecycle hold missing'; end if;
  insert into public.exact_installment_lifecycle_observations(stripe_object_id,agreement_id,revision,stripe_event_id,disposition,details)
    values(p_object_id,a.id,p_revision+1,p_event_id,p_disposition,p_details)
    on conflict(stripe_object_id) do update set revision=excluded.revision,stripe_event_id=excluded.stripe_event_id,
      disposition=excluded.disposition,details=excluded.details,updated_at=now()
      where exact_installment_lifecycle_observations.agreement_id=excluded.agreement_id
        and exact_installment_lifecycle_observations.revision=p_revision
      returning true into saved;
  -- A concurrently inserted object owned by another agreement cannot be adopted.
  return coalesce(saved,false);
end;
$$;

-- Receipt replay must use the same lock/priority as the event observer. A
-- read-then-PATCH through the legacy mirror could overwrite a newer audit.
create function public.reconcile_exact_installment_dispute_audit(p_payment_intent_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; r public.exact_installment_receipts%rowtype;
  l public.payment_fee_ledger%rowtype; chosen public.payment_dispute_state%rowtype;
begin
  select * into r from public.exact_installment_receipts where stripe_payment_intent_id=p_payment_intent_id;
  if not found or r.counted_at is null then raise exception 'dispute receipt not credited'; end if;
  select * into a from public.exact_installment_agreements where id=r.agreement_id for update;
  select * into l from public.payment_fee_ledger where id=r.ledger_id for update;
  if not found or l.earnings_credited_at is null or l.purchase_id is distinct from a.purchase_id or
    l.booking_payment_id is distinct from a.booking_payment_id or l.creator_id::text is distinct from a.terms->>'creatorId' or
    l.stripe_payment_intent_id is distinct from p_payment_intent_id or l.stripe_invoice_id is distinct from r.stripe_invoice_id or
    l.gross_amount_cents is distinct from r.amount_cents or l.total_creator_deduction_cents is distinct from r.application_fee_cents or
    l.currency is distinct from 'usd' then raise exception 'dispute mirror ledger differs'; end if;
  select * into chosen from public.payment_dispute_state where stripe_payment_intent_id=p_payment_intent_id
    order by (status not in ('won','warning_closed','prevented')) desc,stripe_event_created desc,stripe_dispute_id limit 1;
  if not found then return; end if;
  if chosen.stripe_charge_id is distinct from l.stripe_charge_id or chosen.currency is distinct from 'usd' then
    raise exception 'dispute mirror identity differs'; end if;
  update public.payment_fee_ledger set stripe_dispute_id=chosen.stripe_dispute_id,disputed_amount_cents=chosen.disputed_amount_cents,
    dispute_status=chosen.status,updated_at=now() where id=l.id;
end;
$$;

create function public.apply_exact_installment_dispute_event(p_agreement_id uuid,p_event_id text,p_dispute_id text,
  p_revision bigint,p_basis jsonb,p_payment_intent_id text,p_charge_id text,p_gross_cents bigint,
  p_disputed_cents bigint,p_status text,p_event_created bigint)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; r public.exact_installment_receipts%rowtype;
  l public.payment_fee_ledger%rowtype; prior public.payment_dispute_state%rowtype;
  disposition text:='dispute_observed';
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or p_dispute_id is null or p_dispute_id !~ '^du_[a-zA-Z0-9]+$' or p_status is null or
    p_status not in ('warning_needs_response','warning_under_review','warning_closed','needs_response','under_review','won','lost','prevented') or
    p_disputed_cents is null or p_disputed_cents not between 1 and 99999999 or p_event_created is null or p_event_created<=0 then
    raise exception 'invalid exact dispute evidence'; end if;
  perform public.hold_exact_installment_lifecycle_event(a.id,p_event_id,p_dispute_id,p_payment_intent_id);
  select * into r from public.exact_installment_receipts where agreement_id=a.id and stripe_payment_intent_id=p_payment_intent_id;
  if not found or r.counted_at is null then raise exception 'dispute receipt not credited'; end if;
  select * into l from public.payment_fee_ledger where id=r.ledger_id for update;
  if not found or l.earnings_credited_at is null or l.purchase_id is distinct from a.purchase_id or
    l.booking_payment_id is distinct from a.booking_payment_id or l.creator_id::text is distinct from a.terms->>'creatorId' or
    l.stripe_payment_intent_id is distinct from p_payment_intent_id or l.stripe_charge_id is distinct from p_charge_id or
    l.stripe_invoice_id is distinct from r.stripe_invoice_id or l.gross_amount_cents is distinct from p_gross_cents or
    r.amount_cents is distinct from p_gross_cents or l.total_creator_deduction_cents is distinct from r.application_fee_cents or
    l.currency is distinct from 'usd' then raise exception 'dispute ledger differs'; end if;
  select * into prior from public.payment_dispute_state where stripe_dispute_id=p_dispute_id for update;
  if found then
    if prior.stripe_payment_intent_id is distinct from p_payment_intent_id or prior.stripe_charge_id is distinct from p_charge_id or
      prior.currency is distinct from 'usd' then raise exception 'prior dispute identity differs'; end if;
    -- Never silently reopen/reverse a terminal decision; keep the audit and
    -- collection hold for review even if Stripe later returns a different state.
    if prior.status in ('won','lost','prevented') and prior.status<>p_status then disposition:='review_required'; end if;
  end if;
  if not public.finish_exact_installment_lifecycle(a.id,p_event_id,p_dispute_id,p_revision,p_basis,disposition,
    jsonb_build_object('status',p_status,'paymentIntentId',p_payment_intent_id,'chargeId',p_charge_id,'disputedCents',p_disputed_cents)) then
    return 'reconciliation_required'; end if;
  if disposition='review_required' then return 'lifecycle_review_recorded'; end if;
  -- Current Stripe was retrieved AFTER the revision/basis. Preserve the largest
  -- actual event timestamp as a watermark, not a fabricated observation time.
  perform public.record_payment_dispute_state(p_dispute_id,p_payment_intent_id,p_charge_id,p_disputed_cents,'usd',p_status,
    greatest(coalesce(prior.stripe_event_created,0),p_event_created));
  perform public.reconcile_exact_installment_dispute_audit(p_payment_intent_id);
  return 'lifecycle_observed';
end;
$$;
revoke all on function public.exact_installment_lifecycle_basis(uuid),public.read_exact_installment_lifecycle(uuid,text),
  public.hold_exact_installment_lifecycle_event(uuid,text,text,text),
  public.reconcile_exact_installment_dispute_audit(text),
  public.finish_exact_installment_lifecycle(uuid,text,text,bigint,jsonb,text,jsonb),
  public.apply_exact_installment_dispute_event(uuid,text,text,bigint,jsonb,text,text,bigint,bigint,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.read_exact_installment_lifecycle(uuid,text),public.hold_exact_installment_lifecycle_event(uuid,text,text,text),
  public.reconcile_exact_installment_dispute_audit(text),
  public.finish_exact_installment_lifecycle(uuid,text,text,bigint,jsonb,text,jsonb),
  public.apply_exact_installment_dispute_event(uuid,text,text,bigint,jsonb,text,text,bigint,bigint,text,bigint) to service_role;
commit;
