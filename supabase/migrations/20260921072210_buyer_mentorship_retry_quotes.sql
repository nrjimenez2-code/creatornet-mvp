begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_retry_quotes_v1 (
  id uuid primary key,
  setup_id uuid not null references public.buyer_mentorship_saved_card_proofs_v1(setup_id),
  reservation_id uuid not null,
  buyer_id uuid not null,
  payment_number integer not null,
  invoice_id text not null,
  original_payment_intent_id text not null,
  replacement_payment_method_id text not null,
  setup_intent_id text not null,
  authorization_snapshot jsonb not null,
  recovery_basis jsonb not null,
  amount_cents bigint not null check(amount_cents>0),
  created_at timestamptz not null,
  expires_at bigint not null,
  consent_version text not null check(consent_version='single-invoice-pay-now-v1'),
  future_card_option boolean not null,
  future_card_periods jsonb,
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_payment_admissions_v1(reservation_id,payment_number)
);
create table public.buyer_mentorship_retry_consents_v1 (
  quote_id uuid primary key references public.buyer_mentorship_retry_quotes_v1(id),
  confirmed_at timestamptz not null default clock_timestamp(),
  future_card_accepted boolean not null
);
alter table public.buyer_mentorship_retry_quotes_v1 enable row level security;
alter table public.buyer_mentorship_retry_consents_v1 enable row level security;
revoke all on public.buyer_mentorship_retry_quotes_v1,public.buyer_mentorship_retry_consents_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_retry_quotes_v1,public.buyer_mentorship_retry_consents_v1 to service_role;

create function public.quote_buyer_mentorship_retry_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_setup_id uuid,p_quote_id uuid,p_future boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare saved jsonb; ctx jsonb; s public.buyer_mentorship_card_setup_requests_v1%rowtype;
  card public.buyer_mentorship_saved_card_proofs_v1%rowtype; q public.buyer_mentorship_retry_quotes_v1%rowtype;
  p public.buyer_mentorship_collection_periods_v1%rowtype; created timestamptz; expiry bigint; remaining jsonb;
begin
  if p_quote_id is null or p_future is null then raise exception 'Buyer retry quote identity required'; end if;
  saved:=public.read_buyer_mentorship_card_setup_v1(p_request_id,p_buyer_id,p_context,p_setup_id);
  select * into s from public.buyer_mentorship_card_setup_requests_v1 where id=p_setup_id;
  ctx:=public.read_buyer_mentorship_recovery_action_context_v1(p_request_id,p_buyer_id,p_context,s.invoice_id,'payment_method_required');
  select * into card from public.buyer_mentorship_saved_card_proofs_v1 where setup_id=s.id;
  select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=s.reservation_id and payment_number=s.payment_number;
  if card.setup_id is null or card.session_id is distinct from saved#>>'{binding,session_id}' or card.billing_country is distinct from 'US' or
    p.invoice_id is distinct from s.invoice_id or p.counted_at is not null then raise exception 'Buyer retry requires original saved card and unpaid period'; end if;
  select * into q from public.buyer_mentorship_retry_quotes_v1 where id=p_quote_id;
  if found then
    if q.setup_id is distinct from s.id or q.buyer_id is distinct from p_buyer_id or q.future_card_option is distinct from p_future then
      raise exception 'Original buyer retry quote differs'; end if;
    return jsonb_build_object('quote',to_jsonb(q),'paymentAllowed',false);
  end if;
  created:=date_trunc('second',clock_timestamp());expiry:=least(extract(epoch from created)::bigint+300,s.expires_at,p.period_end);
  if created<to_timestamp(p.due_at) or expiry<=extract(epoch from created)::bigint then raise exception 'Buyer retry review window expired'; end if;
  if p_future then
    select jsonb_agg(jsonb_build_object('paymentNumber',payment_number,'amountCents',amount_cents,'dueAt',due_at,'periodEnd',period_end) order by payment_number)
      into remaining from public.buyer_mentorship_collection_periods_v1 where reservation_id=s.reservation_id and payment_number>s.payment_number;
    if remaining is null or jsonb_array_length(remaining)<>(s.authorization_snapshot->>'paymentCount')::integer-s.payment_number then
      raise exception 'Buyer remaining schedule unavailable'; end if;
  end if;
  insert into public.buyer_mentorship_retry_quotes_v1 values(p_quote_id,s.id,s.reservation_id,p_buyer_id,s.payment_number,s.invoice_id,
    s.original_payment_intent_id,card.payment_method_id,card.setup_intent_id,s.authorization_snapshot,ctx,p.amount_cents,created,expiry,
    'single-invoice-pay-now-v1',p_future,remaining) returning * into q;
  return jsonb_build_object('quote',to_jsonb(q),'paymentAllowed',false);
end $$;

-- Consent recording alone never admits a debit. An executor must separately
-- revalidate original provider evidence and consume once-only payment admission.
create function public.confirm_buyer_mentorship_retry_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_quote_id uuid,p_consent jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare q public.buyer_mentorship_retry_quotes_v1%rowtype; c public.buyer_mentorship_retry_consents_v1%rowtype;
  ctx jsonb; future boolean;
begin
  select * into q from public.buyer_mentorship_retry_quotes_v1 where id=p_quote_id and buyer_id=p_buyer_id;
  if not found then raise exception 'Owned buyer retry quote unavailable'; end if;
  ctx:=public.read_buyer_mentorship_recovery_action_context_v1(p_request_id,p_buyer_id,p_context,q.invoice_id,'payment_method_required');
  if ctx->>'reservationId' is distinct from q.reservation_id::text then raise exception 'Buyer retry reservation differs'; end if;
  future:=p_consent='{"accepted":true,"consentVersion":"single-invoice-pay-now-v1","futureCardConsentVersion":"same-plan-remaining-card-v1"}'::jsonb;
  if p_consent is null or (not coalesce(future,false) and p_consent is distinct from '{"accepted":true,"consentVersion":"single-invoice-pay-now-v1"}'::jsonb) or
    (future and not q.future_card_option) then raise exception 'Explicit buyer retry consent required'; end if;
  select * into c from public.buyer_mentorship_retry_consents_v1 where quote_id=q.id;
  if found then
    if c.future_card_accepted is distinct from future then raise exception 'Original buyer retry consent cannot change'; end if;
    return jsonb_build_object('quote',to_jsonb(q),'consent',to_jsonb(c),'paymentAllowed',false);
  end if;
  if ctx is distinct from q.recovery_basis or clock_timestamp()>=to_timestamp(q.expires_at) or clock_timestamp()<q.created_at then
    raise exception 'Buyer retry quote is stale'; end if;
  insert into public.buyer_mentorship_retry_consents_v1(quote_id,future_card_accepted) values(q.id,future) returning * into c;
  return jsonb_build_object('quote',to_jsonb(q),'consent',to_jsonb(c),'paymentAllowed',false);
end $$;
revoke all on function public.quote_buyer_mentorship_retry_v1(uuid,uuid,jsonb,uuid,uuid,boolean),public.confirm_buyer_mentorship_retry_v1(uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.quote_buyer_mentorship_retry_v1(uuid,uuid,jsonb,uuid,uuid,boolean),public.confirm_buyer_mentorship_retry_v1(uuid,uuid,jsonb,uuid,jsonb) to service_role;
commit;
