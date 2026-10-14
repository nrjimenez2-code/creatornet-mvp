begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_invoice_cards_v1 (
  reservation_id uuid not null,
  payment_number integer not null,
  invoice_id text not null unique,
  payment_method_id text not null,
  original_default_payment_method_id text not null,
  authorization_quote_id uuid references public.buyer_mentorship_future_card_authorizations_v1(quote_id),
  primary key(reservation_id,payment_number),
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_invoice_claims_v1(reservation_id,payment_number)
);
alter table public.buyer_mentorship_invoice_cards_v1 enable row level security;
revoke all on public.buyer_mentorship_invoice_cards_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_invoice_cards_v1 to service_role;

-- Pin card authority when the original invoice claim is inserted, never on
-- replay. Defaults remain original; this record does not release collection.
create function public.bind_buyer_mentorship_invoice_card_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
declare first public.buyer_mentorship_first_receipts_v1%rowtype;
  authorized public.buyer_mentorship_future_card_authorizations_v1%rowtype;
  period public.buyer_mentorship_collection_periods_v1%rowtype; method text;
begin
  select * into first from public.buyer_mentorship_first_receipts_v1 where reservation_id=new.reservation_id;
  select * into period from public.buyer_mentorship_collection_periods_v1 where reservation_id=new.reservation_id and payment_number=new.payment_number;
  if first.reservation_id is null or period.reservation_id is null then raise exception 'Buyer invoice card requires original purchase'; end if;
  method:=first.proof->>'paymentMethodId';
  select * into authorized from public.buyer_mentorship_future_card_authorizations_v1
    where reservation_id=new.reservation_id and after_payment_number<new.payment_number order by after_payment_number desc limit 1;
  if found then
    if authorized.original_default_payment_method_id is distinct from method or not exists(
      select 1 from jsonb_array_elements(authorized.remaining_periods) value where
        value=jsonb_build_object('paymentNumber',period.payment_number,'amountCents',period.amount_cents,'dueAt',period.due_at,'periodEnd',period.period_end)) then
      raise exception 'Buyer future card does not cover original period'; end if;
    method:=authorized.payment_method_id;
  end if;
  insert into public.buyer_mentorship_invoice_cards_v1(reservation_id,payment_number,invoice_id,payment_method_id,
    original_default_payment_method_id,authorization_quote_id) values(new.reservation_id,new.payment_number,new.invoice_id,
    method,first.proof->>'paymentMethodId',authorized.quote_id);
  return new;
end $$;
revoke all on function public.bind_buyer_mentorship_invoice_card_v1() from public,anon,authenticated;
create trigger bind_buyer_mentorship_invoice_card_v1 after insert on public.buyer_mentorship_invoice_claims_v1
  for each row execute function public.bind_buyer_mentorship_invoice_card_v1();

-- Claims already saved before this migration retain their ORIGINAL card. No
-- future authorization can be applied retrospectively to a prepared operation.
insert into public.buyer_mentorship_invoice_cards_v1(reservation_id,payment_number,invoice_id,payment_method_id,original_default_payment_method_id)
  select c.reservation_id,c.payment_number,c.invoice_id,f.proof->>'paymentMethodId',f.proof->>'paymentMethodId'
  from public.buyer_mentorship_invoice_claims_v1 c join public.buyer_mentorship_first_receipts_v1 f using(reservation_id);

create or replace function public.admit_buyer_mentorship_payment_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_payment_number integer,p_token uuid,
  p_invoice jsonb,p_intent jsonb,p_method jsonb,p_link jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  b public.buyer_mentorship_billing_state_v1%rowtype; p public.buyer_mentorship_collection_periods_v1%rowtype;
  c public.buyer_mentorship_invoice_claims_v1%rowtype; a public.buyer_mentorship_payment_admissions_v1%rowtype;
  card public.buyer_mentorship_invoice_cards_v1%rowtype;
  expected jsonb; fee bigint; now_seconds bigint:=floor(extract(epoch from clock_timestamp()));
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer payment unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  select * into c from public.buyer_mentorship_invoice_claims_v1 where reservation_id=r.id and payment_number=p_payment_number;
  select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=p_payment_number;
  if f.reservation_id is null or c.reservation_id is null or p.reservation_id is null then raise exception 'Original buyer payment preparation unavailable'; end if;
  select * into card from public.buyer_mentorship_invoice_cards_v1 where reservation_id=r.id and payment_number=p_payment_number;
  if card.invoice_id is distinct from c.invoice_id or card.original_default_payment_method_id is distinct from f.proof->>'paymentMethodId' then
    raise exception 'Original buyer invoice card binding unavailable'; end if;
  expected:=jsonb_build_object('apiVersion','2025-10-29.clover','method','POST','path','/v1/invoices/'||c.invoice_id||'/pay',
    'params',jsonb_build_object('payment_method',card.payment_method_id,'off_session',true));
  if p_request is distinct from expected then raise exception 'Buyer payment request differs'; end if;
  select * into a from public.buyer_mentorship_payment_admissions_v1 where reservation_id=r.id and payment_number=p_payment_number;
  if found then
    if a.request is distinct from expected or a.invoice_id is distinct from c.invoice_id then raise exception 'Original buyer payment differs'; end if;
    return jsonb_build_object('status','reconcile_admitted','admission',to_jsonb(a));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(f.payment_intent_id,73591));
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  if b.reservation_id is null or b.collection_hold_at is not null or b.financial_hold_at is not null or b.debit_revoked_at is not null or
    b.paid_count<>p_payment_number-1 or p.admitted_at is not null or p.counted_at is not null or p.invoice_id is distinct from c.invoice_id or
    c.lease_token is distinct from p_token or c.lease_until<=clock_timestamp() or c.first_preparation_at<=clock_timestamp()-interval '23 hours' or
    now_seconds<p.due_at or now_seconds>=p.period_end or
    (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb then
    raise exception 'Buyer payment admission requires review'; end if;
  fee:=round(p.amount_cents::numeric*1200/10000)::bigint+case when (p.fee_schedule->>'enabled')::boolean then
    round(p.amount_cents::numeric*(p.fee_schedule->>'basisPoints')::integer/10000)::bigint+(p.fee_schedule->>'fixedCents')::bigint else 0 end;
  if p_invoice->>'object' is distinct from 'invoice' or p_invoice->>'id' is distinct from c.invoice_id or p_invoice->>'status' is distinct from 'open' or
    p_invoice->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or p_invoice->>'customer' is distinct from f.proof->>'customerId' or
    p_invoice#>>'{parent,subscription_details,subscription}' is distinct from f.proof->>'subscriptionId' or
    p_invoice->>'currency' is distinct from 'usd' or p_invoice->'auto_advance' is distinct from 'false'::jsonb or
    p_invoice->'attempted' is distinct from 'false'::jsonb or p_invoice->'attempt_count' is distinct from '0'::jsonb or
    p_invoice->'amount_paid' is distinct from '0'::jsonb or p_invoice->'amount_due' is distinct from to_jsonb(p.amount_cents) or
    p_invoice->'amount_remaining' is distinct from to_jsonb(p.amount_cents) or
    p_invoice#>>'{metadata,creatornet_installment_reservation_id}' is distinct from r.id::text or
    p_invoice#>>'{metadata,creatornet_installment_request_id}' is distinct from r.request_id::text or
    p_invoice#>>'{metadata,installment_number}' is distinct from p_payment_number::text or
    p_intent->>'object' is distinct from 'payment_intent' or coalesce(p_intent->>'id','') !~ '^pi_[A-Za-z0-9]+$' or
    p_intent->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or p_intent->>'customer' is distinct from f.proof->>'customerId' or
    p_intent->>'currency' is distinct from 'usd' or p_intent->'amount' is distinct from to_jsonb(p.amount_cents) or
    p_intent->'amount_received' is distinct from '0'::jsonb or p_intent->>'latest_charge' is not null or
    coalesce(p_intent->>'status','') not in ('requires_payment_method','requires_confirmation') or
    p_intent->'application_fee_amount' is distinct from to_jsonb(fee) or p_intent#>>'{transfer_data,destination}' is distinct from r.destination_id or
    p_intent#>>'{transfer_data,amount}' is not null or p_intent->'payment_method_types' is distinct from '["card"]'::jsonb or
    p_method->>'object' is distinct from 'payment_method' or p_method->>'id' is distinct from card.payment_method_id or
    p_method->>'customer' is distinct from f.proof->>'customerId' or p_method->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or
    p_method->>'type' is distinct from 'card' or p_method#>>'{billing_details,address,country}' is distinct from 'US' or
    p_link->>'invoice' is distinct from c.invoice_id or p_link->'is_default' is distinct from 'true'::jsonb or
    p_link->'livemode' is distinct from to_jsonb(p_context->>'mode'='live') or p_link->>'currency' is distinct from 'usd' or
    p_link->>'status' is distinct from 'open' or p_link->'amount_requested' is distinct from to_jsonb(p.amount_cents) or p_link->>'amount_paid' is not null or
    p_link#>>'{payment,type}' is distinct from 'payment_intent' or p_link#>>'{payment,payment_intent}' is distinct from p_intent->>'id' then
    raise exception 'Buyer payment provider evidence differs'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_intent->>'id',73591));
  if exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=p_intent->>'id') or
    exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=p_intent->>'id') or
    exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=p_intent->>'id') then
    raise exception 'Buyer payment cannot adopt prior financial activity'; end if;
  insert into public.buyer_mentorship_payment_admissions_v1(reservation_id,payment_number,invoice_id,payment_intent_id,payment_method_id,request,dispatch_before)
    values(r.id,p_payment_number,c.invoice_id,p_intent->>'id',p_method->>'id',expected,
      least(clock_timestamp()+interval '25 seconds',c.lease_until,c.first_preparation_at+interval '23 hours',to_timestamp(p.period_end))) returning * into a;
  update public.buyer_mentorship_collection_periods_v1 set admitted_at=a.admitted_at where reservation_id=r.id and payment_number=p_payment_number;
  return jsonb_build_object('status','dispatch_once','admission',to_jsonb(a));
end $$;
revoke all on function public.admit_buyer_mentorship_payment_v1(uuid,uuid,jsonb,integer,uuid,jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.admit_buyer_mentorship_payment_v1(uuid,uuid,jsonb,integer,uuid,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;
commit;
