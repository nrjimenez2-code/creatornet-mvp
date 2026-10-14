begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.buyer_mentorship_future_card_authorizations_v1 (
  quote_id uuid primary key references public.buyer_mentorship_retry_admissions_v1(quote_id),
  reservation_id uuid not null references public.buyer_mentorship_installment_reservations_v1(id),
  after_payment_number integer not null,
  payment_method_id text not null,
  original_default_payment_method_id text not null,
  remaining_periods jsonb not null,
  verified_basis jsonb not null,
  authorized_at timestamptz not null default clock_timestamp(),
  unique(reservation_id,after_payment_number)
);
alter table public.buyer_mentorship_future_card_authorizations_v1 enable row level security;
revoke all on public.buyer_mentorship_future_card_authorizations_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_future_card_authorizations_v1 to service_role;

-- This is a held, receipt-backed authorization context, not collection release.
-- Runtime must surround fresh provider/card/history verification with this read.
create function public.read_buyer_mentorship_future_card_context_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_quote_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; q public.buyer_mentorship_retry_quotes_v1%rowtype;
  c public.buyer_mentorship_retry_consents_v1%rowtype; a public.buyer_mentorship_retry_admissions_v1%rowtype;
  b public.buyer_mentorship_billing_state_v1%rowtype; f public.buyer_mentorship_first_receipts_v1%rowtype;
  remaining jsonb; receipt jsonb; prior jsonb:='[]'::jsonb; pi text; n integer;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer future card unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into q from public.buyer_mentorship_retry_quotes_v1 where id=p_quote_id and reservation_id=r.id and buyer_id=p_buyer_id;
  select * into c from public.buyer_mentorship_retry_consents_v1 where quote_id=q.id;
  select * into a from public.buyer_mentorship_retry_admissions_v1 where quote_id=q.id;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  if q.id is null or c.future_card_accepted is distinct from true or q.future_card_option is distinct from true or
    a.reservation_id is distinct from r.id or a.payment_number is distinct from q.payment_number or
    a.payment_method_id is distinct from q.replacement_payment_method_id or a.payment_intent_id is distinct from q.original_payment_intent_id or
    a.invoice_id is distinct from q.invoice_id or b.reservation_id is null or b.paid_count<>q.payment_number or
    q.payment_number>=(r.terms->>'paymentCount')::integer or b.collection_hold_at is null or b.debit_revoked_at is not null or
    b.financial_hold_at is not null or f.reservation_id is null or
    (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb then
    raise exception 'Buyer future card requires separate consent and clean paid state'; end if;
  receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,a.payment_intent_id);
  if receipt is null or receipt->>'invoiceId' is distinct from a.invoice_id or
    receipt#>>'{proof,paymentMethodId}' is distinct from a.payment_method_id or receipt#>>'{proof,buyerCountry}' is distinct from 'US' or
    receipt#>'{proof,paymentNumber}' is distinct from to_jsonb(q.payment_number) then
    raise exception 'Buyer future card requires credited replacement capture'; end if;
  for n in 1..q.payment_number loop
    if n=1 then pi:=f.payment_intent_id;
    else select payment_intent_id into pi from public.buyer_mentorship_later_receipts_v1 where reservation_id=r.id and payment_number=n; end if;
    receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,pi);
    if receipt is null or receipt#>'{proof,paymentNumber}' is distinct from to_jsonb(n) or
      exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=pi) then
      raise exception 'Buyer future card history requires review'; end if;
    prior:=prior||jsonb_build_array(jsonb_build_object('paymentNumber',n,'paymentIntentId',pi));
  end loop;
  select jsonb_agg(jsonb_build_object('paymentNumber',payment_number,'amountCents',amount_cents,'dueAt',due_at,'periodEnd',period_end) order by payment_number)
    into remaining from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number>q.payment_number;
  if remaining is distinct from q.future_card_periods or jsonb_array_length(remaining)<>(r.terms->>'paymentCount')::integer-q.payment_number or
    exists(select 1 from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number>q.payment_number and
      (counted_at is not null or admitted_at is not null or invoice_id is not null or due_at<=extract(epoch from clock_timestamp()))) or
    exists(select 1 from public.buyer_mentorship_invoice_claims_v1 where reservation_id=r.id and payment_number>q.payment_number) then
    raise exception 'Buyer future card remaining schedule changed'; end if;
  return jsonb_build_object('reservationId',r.id,'quoteId',q.id,'afterPaymentNumber',q.payment_number,
    'paymentMethodId',a.payment_method_id,'originalDefaultPaymentMethodId',f.proof->>'paymentMethodId',
    'remainingPayments',remaining,'billing',to_jsonb(b),'prior',prior,'firstProof',f.proof);
end $$;
revoke all on function public.read_buyer_mentorship_future_card_context_v1(uuid,uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.read_buyer_mentorship_future_card_context_v1(uuid,uuid,jsonb,uuid) to service_role;

-- Internal verified-provider handoff only. Never changes defaults or clears a hold.
create function public.authorize_buyer_mentorship_future_card_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_quote_id uuid,p_basis jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare basis jsonb; saved public.buyer_mentorship_future_card_authorizations_v1%rowtype;
begin
  basis:=public.read_buyer_mentorship_future_card_context_v1(p_request_id,p_buyer_id,p_context,p_quote_id);
  if p_basis is distinct from basis then raise exception 'Buyer future card verification became stale'; end if;
  insert into public.buyer_mentorship_future_card_authorizations_v1(quote_id,reservation_id,after_payment_number,payment_method_id,
    original_default_payment_method_id,remaining_periods,verified_basis) values(p_quote_id,(basis->>'reservationId')::uuid,
    (basis->>'afterPaymentNumber')::integer,basis->>'paymentMethodId',basis->>'originalDefaultPaymentMethodId',basis->'remainingPayments',basis)
    on conflict(quote_id) do nothing;
  select * into saved from public.buyer_mentorship_future_card_authorizations_v1 where quote_id=p_quote_id;
  if saved.verified_basis is distinct from basis then raise exception 'Original buyer future card authorization differs'; end if;
  return jsonb_build_object('status','authorized_held','quoteId',saved.quote_id,'reservationId',saved.reservation_id);
end $$;
revoke all on function public.authorize_buyer_mentorship_future_card_v1(uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.authorize_buyer_mentorship_future_card_v1(uuid,uuid,jsonb,uuid,jsonb) to service_role;
commit;
