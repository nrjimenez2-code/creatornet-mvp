begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_invoice_claims_v1 (
  reservation_id uuid not null,
  payment_number integer not null,
  invoice_id text not null unique check(invoice_id ~ '^in_[A-Za-z0-9]+$'),
  authorization_snapshot jsonb not null check(jsonb_typeof(authorization_snapshot)='object'),
  idempotency_prefix text not null unique default ('cn-buyer-invoice-v1:'||gen_random_uuid()::text),
  first_preparation_at timestamptz not null default clock_timestamp(),
  lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default clock_timestamp()+interval '75 seconds',
  primary key(reservation_id,payment_number),
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_collection_periods_v1(reservation_id,payment_number)
);
alter table public.buyer_mentorship_invoice_claims_v1 enable row level security;
revoke all on public.buyer_mentorship_invoice_claims_v1 from public,anon,authenticated,service_role;
grant select,insert,update on public.buyer_mentorship_invoice_claims_v1 to service_role;
grant update(invoice_id) on public.buyer_mentorship_collection_periods_v1 to service_role;
create function public.guard_buyer_mentorship_invoice_claim_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if (to_jsonb(new)-'lease_token'-'lease_until') is distinct from (to_jsonb(old)-'lease_token'-'lease_until') then
    raise exception 'Original buyer invoice claim is immutable'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_invoice_claim_v1 before update on public.buyer_mentorship_invoice_claims_v1
  for each row execute function public.guard_buyer_mentorship_invoice_claim_v1();
revoke all on function public.guard_buyer_mentorship_invoice_claim_v1() from public,anon,authenticated;
create function public.guard_buyer_mentorship_period_invoice_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if (to_jsonb(new)-'invoice_id') is distinct from (to_jsonb(old)-'invoice_id') or
    (old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id) or
    (new.invoice_id is not null and not exists(select 1 from public.buyer_mentorship_invoice_claims_v1 c
      where c.reservation_id=new.reservation_id and c.payment_number=new.payment_number and c.invoice_id=new.invoice_id)) then
    raise exception 'Buyer period requires its original invoice claim'; end if;
  return new;
end $$;
create trigger guard_buyer_mentorship_period_invoice_v1 before update on public.buyer_mentorship_collection_periods_v1
  for each row execute function public.guard_buyer_mentorship_period_invoice_v1();
revoke all on function public.guard_buyer_mentorship_period_invoice_v1() from public,anon,authenticated;

-- Preparation only. Does not admit pay(), remove any hold, or count a receipt.
create function public.claim_buyer_mentorship_invoice_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_payment_number integer,p_invoice jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  a public.buyer_mentorship_activation_operations_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype;
  p public.buyer_mentorship_collection_periods_v1%rowtype; c public.buyer_mentorship_invoice_claims_v1%rowtype;
  identity jsonb; now_seconds bigint:=floor(extract(epoch from clock_timestamp()));
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer invoice unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id,73591));
  select * into a from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id and completed_at is not null;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=p_payment_number;
  if f.reservation_id is null or a.reservation_id is null or b.reservation_id is null or p.reservation_id is null or
    b.collection_hold_at is not null or b.financial_hold_at is not null or b.debit_revoked_at is not null or
    b.paid_count<>p_payment_number-1 or p.counted_at is not null or
    (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb or
    exists(select 1 from public.buyer_mentorship_collection_periods_v1 prior where prior.reservation_id=r.id and
      prior.payment_number<p_payment_number and prior.counted_at is null) then raise exception 'Buyer invoice collection state requires review'; end if;
  if p.admitted_at is not null then return jsonb_build_object('status','reconcile_admitted','invoiceId',p.invoice_id); end if;
  if now_seconds<p.due_at or now_seconds>=p.period_end then return jsonb_build_object('status','review_required'); end if;
  if coalesce(p_invoice->>'id','') !~ '^in_[A-Za-z0-9]+$' or p_invoice->>'object' is distinct from 'invoice' or
    p_invoice->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    p_invoice->>'customer' is distinct from f.proof->>'customerId' or
    p_invoice#>>'{parent,subscription_details,subscription}' is distinct from f.proof->>'subscriptionId' or
    p_invoice->>'currency' is distinct from 'usd' or p_invoice->>'billing_reason' is distinct from 'subscription_cycle' or
    coalesce(p_invoice->>'status','') not in ('draft','open') or p_invoice->'auto_advance' is distinct from 'false'::jsonb or
    p_invoice->'amount_paid' is distinct from '0'::jsonb or p_invoice->'attempted' is distinct from 'false'::jsonb or
    p_invoice->'attempt_count' is distinct from '0'::jsonb or p_invoice#>'{lines,has_more}' is distinct from 'false'::jsonb or
    p_invoice#>'{lines,data,0,period,start}' is distinct from to_jsonb(p.due_at) or
    p_invoice#>'{lines,data,0,period,end}' is distinct from to_jsonb(p.period_end) or
    p_invoice#>>'{lines,data,0,parent,subscription_item_details,subscription_item}' is distinct from a.item_id then
    raise exception 'Buyer invoice provider identity differs'; end if;
  identity:=jsonb_build_object('protocol','buyer-mentorship-installments-v1','planId',r.id,'buyerReservationId',r.id,'buyerRequestId',r.request_id,
    'invoiceId',p_invoice->>'id','subscriptionId',f.proof->>'subscriptionId','subscriptionItemId',a.item_id,
    'customerId',f.proof->>'customerId','destinationId',r.destination_id,'currency','usd','totalCents',(r.terms->>'amountCents')::bigint,
    'paymentCount',(r.terms->>'paymentCount')::integer,'paymentNumber',p_payment_number,'periodStart',p.due_at,'periodEnd',p.period_end,
    'cancelAt',(a.request#>>'{params,cancel_at}')::bigint,'feeSchedule',p.fee_schedule);
  select * into c from public.buyer_mentorship_invoice_claims_v1 where reservation_id=r.id and payment_number=p_payment_number;
  if found then
    if c.invoice_id is distinct from p_invoice->>'id' or c.authorization_snapshot is distinct from identity then raise exception 'Original buyer invoice differs'; end if;
    if c.first_preparation_at<=clock_timestamp()-interval '23 hours' then return jsonb_build_object('status','review_required'); end if;
    if c.lease_until>clock_timestamp() then return jsonb_build_object('status','busy'); end if;
    update public.buyer_mentorship_invoice_claims_v1 set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '75 seconds'
      where reservation_id=r.id and payment_number=p_payment_number returning * into c;
  else
    if p.invoice_id is not null then raise exception 'Buyer invoice cannot adopt another claim'; end if;
    insert into public.buyer_mentorship_invoice_claims_v1(reservation_id,payment_number,invoice_id,authorization_snapshot)
      values(r.id,p_payment_number,p_invoice->>'id',identity) returning * into c;
    update public.buyer_mentorship_collection_periods_v1 set invoice_id=c.invoice_id where reservation_id=r.id and payment_number=p_payment_number;
  end if;
  return jsonb_build_object('status','claimed','claim',to_jsonb(c),'paymentAllowed',false);
end $$;
revoke all on function public.claim_buyer_mentorship_invoice_v1(uuid,uuid,jsonb,integer,jsonb) from public,anon,authenticated;
grant execute on function public.claim_buyer_mentorship_invoice_v1(uuid,uuid,jsonb,integer,jsonb) to service_role;
commit;
