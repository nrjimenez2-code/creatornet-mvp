begin;

-- Internal, administrator-approved stop of FUTURE collection only. This is not
-- a public cancellation policy, debt waiver, refund, or access/booking change.
create table public.exact_installment_billing_stops (
  agreement_id uuid primary key references public.exact_installment_agreements on delete restrict,
  request_id uuid not null unique references public.exact_installment_collection_holds(request_id) on delete restrict,
  actor_id uuid not null references public.profiles on delete restrict,
  status text not null check(status in ('running','complete')),
  claim_token uuid not null,
  lease_until timestamptz not null,
  completed_at timestamptz,
  stripe_canceled_at bigint,
  checkout_terminal_status text check(checkout_terminal_status in ('expired','complete')),
  check((status='complete')=(completed_at is not null)),
  check(status<>'complete' or (stripe_canceled_at is not null and stripe_canceled_at>0 and checkout_terminal_status is not null))
);
alter table public.exact_installment_billing_stops enable row level security;
revoke all on public.exact_installment_billing_stops from public,anon,authenticated,service_role;
grant select on public.exact_installment_billing_stops to service_role;

-- A hold blocks a NEW activation. An already-admitted activation may finish or
-- reconcile its same saved operation: billing-stop completion waits for it.
-- Checking only activation completion would strand the admitted worker.
create function public.guard_exact_installment_activation_hold()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.exact_installment_agreements where id=new.agreement_id for update;
  if not exists(select 1 from public.exact_installment_activations where agreement_id=new.agreement_id) and
    exists(select 1 from public.exact_installment_collection_holds where agreement_id=new.agreement_id) then
    raise exception 'new activation held for review'; end if;
  return new;
end;
$$;
create trigger exact_installment_activation_hold before insert on public.exact_installment_activations
  for each row execute function public.guard_exact_installment_activation_hold();

-- Caller holds the agreement lock. Expired dispatch leases are never treated
-- as proof that no charge happened. Late success can still use the original
-- receipt/accounting path, then this stop can be retried without another pay.
create function public.exact_installment_stop_is_quiescent(p_agreement_id uuid)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  select not exists(select 1 from public.exact_installment_operations where agreement_id=p_agreement_id and status<>'complete')
    and not exists(select 1 from public.exact_installment_activations where agreement_id=p_agreement_id and status<>'complete')
    and not exists(select 1 from public.exact_installment_invoice_claims c where c.agreement_id=p_agreement_id and
      ((c.status in ('preparing','prepared') and c.lease_until>now()) or
       (c.dispatch_started_at is not null and (c.status<>'paid' or not exists(
         select 1 from public.exact_installment_receipts r join public.payment_fee_ledger l on l.id=r.ledger_id
         where r.agreement_id=c.agreement_id and r.payment_number=c.payment_number and
           r.stripe_invoice_id=c.stripe_invoice_id and r.stripe_payment_intent_id=c.stripe_payment_intent_id and
           r.counted_at is not null and l.earnings_credited_at is not null and
           l.stripe_payment_intent_id=r.stripe_payment_intent_id and l.stripe_invoice_id=r.stripe_invoice_id)))))
    and not exists(select 1 from public.exact_installment_receipts r left join public.payment_fee_ledger l on l.id=r.ledger_id
      join public.exact_installment_agreements a on a.id=r.agreement_id where r.agreement_id=p_agreement_id and
        (r.counted_at is null or l.earnings_credited_at is null or l.purchase_id is distinct from a.purchase_id or
         l.stripe_payment_intent_id is distinct from r.stripe_payment_intent_id or
         l.stripe_invoice_id is distinct from r.stripe_invoice_id or l.booking_payment_id is distinct from a.booking_payment_id or
         l.creator_id::text is distinct from a.terms->>'creatorId' or l.gross_amount_cents is distinct from r.amount_cents or
         l.total_creator_deduction_cents is distinct from r.application_fee_cents or l.currency is distinct from 'usd' or
         l.status not in ('paid','refunded')));
$$;

create function public.claim_exact_installment_billing_stop(p_agreement_id uuid,p_request_id uuid,p_actor_id uuid,p_claim_token uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; op public.exact_installment_billing_stops%rowtype;
begin
  if p_claim_token is null then raise exception 'billing stop claim missing'; end if;
  perform public.hold_exact_installment_for_cancellation(p_agreement_id,p_request_id,p_actor_id);
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  select * into op from public.exact_installment_billing_stops where agreement_id=a.id for update;
  if found then
    if op.request_id is distinct from p_request_id or op.actor_id is distinct from p_actor_id then
      raise exception 'billing stop identity changed'; end if;
    if op.status='complete' then return 'complete'; end if;
    if op.lease_until>now() then return 'busy'; end if;
  end if;
  if a.stripe_customer_id is null or a.stripe_subscription_id is null or a.stripe_checkout_session_id is null or
    not public.exact_installment_stop_is_quiescent(a.id) then return 'reconciliation_required'; end if;
  insert into public.exact_installment_billing_stops(agreement_id,request_id,actor_id,status,claim_token,lease_until)
    values(a.id,p_request_id,p_actor_id,'running',p_claim_token,now()+interval '3 minutes')
    on conflict(agreement_id) do update set claim_token=excluded.claim_token,lease_until=excluded.lease_until;
  return 'ready';
end;
$$;

-- Revalidate authorization immediately before an external mutation. Losing a
-- lease only stops the worker; it never authorizes a payment retry or unhold.
create function public.assert_exact_installment_billing_stop(p_agreement_id uuid,p_request_id uuid,p_actor_id uuid,p_claim_token uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or not exists(select 1 from public.profiles where id=p_actor_id and role='admin') or
    not exists(select 1 from public.exact_installment_billing_stops where agreement_id=p_agreement_id and
      request_id=p_request_id and actor_id=p_actor_id and claim_token=p_claim_token and status='running' and lease_until>now()) or
    not exists(select 1 from public.exact_installment_collection_holds where agreement_id=p_agreement_id and
      request_id=p_request_id and requested_by=p_actor_id and reason='cancellation_review') then
    raise exception 'billing stop authorization lost'; end if;
  if not public.exact_installment_stop_is_quiescent(p_agreement_id) then raise exception 'billing stop needs reconciliation'; end if;
end;
$$;

create function public.complete_exact_installment_billing_stop(p_agreement_id uuid,p_request_id uuid,p_actor_id uuid,p_claim_token uuid,
  p_subscription_id text,p_session_id text,p_canceled_at bigint,p_checkout_status text,p_first_payment_intent_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype;
begin
  perform public.assert_exact_installment_billing_stop(p_agreement_id,p_request_id,p_actor_id,p_claim_token);
  select * into a from public.exact_installment_agreements where id=p_agreement_id;
  if a.stripe_subscription_id is distinct from p_subscription_id or a.stripe_checkout_session_id is distinct from p_session_id or
    p_canceled_at is null or p_canceled_at<=0 or p_canceled_at<floor(extract(epoch from a.created_at)) or
    p_canceled_at>extract(epoch from now()) or
    p_checkout_status is null or p_checkout_status not in ('expired','complete') then raise exception 'invalid stopped Stripe identity'; end if;
  if p_checkout_status='complete' then
    if p_first_payment_intent_id is null or not exists(select 1 from public.exact_installment_receipts r
      join public.payment_fee_ledger l on l.id=r.ledger_id where r.agreement_id=a.id and r.payment_number=1 and
        r.stripe_payment_intent_id=p_first_payment_intent_id and r.counted_at is not null and
        l.earnings_credited_at is not null and l.purchase_id=a.purchase_id) then
      raise exception 'first payment not accounted'; end if;
  elsif p_first_payment_intent_id is not null or exists(select 1 from public.exact_installment_receipts where agreement_id=a.id) then
    raise exception 'expired Checkout conflicts with receipts'; end if;
  update public.exact_installment_billing_stops set status='complete',completed_at=now(),stripe_canceled_at=p_canceled_at,
    checkout_terminal_status=p_checkout_status where agreement_id=a.id;
  -- Retain the hold and original agreement/purchase/count/booking/accounting.
  -- Stopping Stripe billing is not forgiveness of the contract or access policy.
end;
$$;
revoke all on function public.guard_exact_installment_activation_hold(),public.exact_installment_stop_is_quiescent(uuid),
  public.claim_exact_installment_billing_stop(uuid,uuid,uuid,uuid),public.assert_exact_installment_billing_stop(uuid,uuid,uuid,uuid),
  public.complete_exact_installment_billing_stop(uuid,uuid,uuid,uuid,text,text,bigint,text,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_exact_installment_billing_stop(uuid,uuid,uuid,uuid),
  public.assert_exact_installment_billing_stop(uuid,uuid,uuid,uuid),
  public.complete_exact_installment_billing_stop(uuid,uuid,uuid,uuid,text,text,bigint,text,text) to service_role;
commit;
