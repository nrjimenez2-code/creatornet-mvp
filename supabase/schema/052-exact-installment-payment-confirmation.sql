begin;

-- Prospective Sandbox-only buyer review/consent. None of these functions
-- admits a Stripe request, changes the original card, or releases a hold.
create table public.exact_installment_payment_confirmations (
  id uuid primary key,
  setup_request_id uuid not null references public.exact_installment_card_setups on delete restrict,
  agreement_id uuid not null references public.exact_installment_agreements on delete restrict,
  buyer_id uuid not null,
  stripe_invoice_id text not null references public.exact_installment_invoice_claims(stripe_invoice_id) on delete restrict,
  original_payment_intent_id text not null check(original_payment_intent_id ~ '^pi_[a-zA-Z0-9]+$'),
  replacement_payment_method_id text not null check(replacement_payment_method_id ~ '^pm_[a-zA-Z0-9]+$'),
  setup_intent_id text not null check(setup_intent_id ~ '^seti_[a-zA-Z0-9]+$'),
  authorization_snapshot jsonb not null check(jsonb_typeof(authorization_snapshot)='object'),
  amount_cents bigint not null check(amount_cents between 50 and 99999999),
  application_fee_cents bigint not null check(application_fee_cents between 0 and amount_cents),
  consent_version text not null default 'single-invoice-retry-v1' check(consent_version='single-invoice-retry-v1'),
  created_at timestamptz not null default now(),
  expires_at bigint not null,
  confirmed_at timestamptz
);
create unique index exact_installment_one_confirmed_retry on public.exact_installment_payment_confirmations(stripe_invoice_id)
  where confirmed_at is not null;
alter table public.exact_installment_payment_confirmations enable row level security;
revoke all on public.exact_installment_payment_confirmations from public,anon,authenticated,service_role;
grant select on public.exact_installment_payment_confirmations to service_role;

create function public.quote_exact_installment_retry(p_id uuid,p_setup_id uuid,p_buyer_id uuid)
returns public.exact_installment_payment_confirmations language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.exact_installment_card_setups%rowtype; p public.exact_installment_periods%rowtype;
  q public.exact_installment_payment_confirmations%rowtype; expires bigint;
begin
  if p_id is null then raise exception 'payment review identity required'; end if;
  s:=public.read_current_exact_card_setup(p_setup_id,p_buyer_id);
  if s.verified_at is null or s.stripe_setup_intent_id is null or s.replacement_payment_method_id is null then
    raise exception 'verified replacement card required'; end if;
  select * into p from public.exact_installment_periods where agreement_id=s.agreement_id and
    payment_number=(s.authorization_snapshot->>'paymentNumber')::integer;
  if not found then raise exception 'payment review period unavailable'; end if;
  if exists(select 1 from public.exact_installment_payment_confirmations where stripe_invoice_id=s.stripe_invoice_id and
    confirmed_at is not null and id<>p_id) then raise exception 'payment confirmation already exists'; end if;
  expires:=least(s.expires_at,p.period_end,floor(extract(epoch from now()))::bigint+300);
  if expires<=extract(epoch from now()) then raise exception 'payment review expired'; end if;
  insert into public.exact_installment_payment_confirmations(id,setup_request_id,agreement_id,buyer_id,stripe_invoice_id,
    original_payment_intent_id,replacement_payment_method_id,setup_intent_id,authorization_snapshot,amount_cents,application_fee_cents,expires_at)
    values(p_id,s.id,s.agreement_id,s.buyer_id,s.stripe_invoice_id,s.original_payment_intent_id,s.replacement_payment_method_id,
      s.stripe_setup_intent_id,s.authorization_snapshot,p.amount_cents,p.application_fee_cents,expires) on conflict(id) do nothing;
  select * into q from public.exact_installment_payment_confirmations where id=p_id;
  if q.setup_request_id is distinct from s.id or q.buyer_id is distinct from p_buyer_id or
    q.stripe_invoice_id is distinct from s.stripe_invoice_id or q.original_payment_intent_id is distinct from s.original_payment_intent_id or
    q.replacement_payment_method_id is distinct from s.replacement_payment_method_id or q.setup_intent_id is distinct from s.stripe_setup_intent_id or
    q.authorization_snapshot is distinct from s.authorization_snapshot or q.amount_cents is distinct from p.amount_cents or
    q.application_fee_cents is distinct from p.application_fee_cents then raise exception 'payment review binding changed'; end if;
  if q.confirmed_at is null and extract(epoch from now())>=q.expires_at then raise exception 'payment review expired'; end if;
  return q;
end;
$$;

create function public.confirm_exact_installment_retry(p_id uuid,p_buyer_id uuid,p_consent_version text)
returns public.exact_installment_payment_confirmations language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.exact_installment_payment_confirmations%rowtype; fresh public.exact_installment_payment_confirmations%rowtype;
begin
  if p_buyer_id is null or p_consent_version is distinct from 'single-invoice-retry-v1' then raise exception 'payment confirmation required'; end if;
  select * into q from public.exact_installment_payment_confirmations where id=p_id and buyer_id=p_buyer_id;
  if not found then raise exception 'payment review unavailable'; end if;
  perform 1 from public.exact_installment_agreements where id=q.agreement_id and terms->>'buyerId'=p_buyer_id::text for update;
  if not found then raise exception 'payment review unavailable'; end if;
  select * into q from public.exact_installment_payment_confirmations where id=p_id for update;
  -- Repeating the exact consent after a lost response returns saved evidence,
  -- never a new dispatch. A future collector must separately admit the request.
  if q.confirmed_at is not null then return q; end if;
  fresh:=public.quote_exact_installment_retry(q.id,q.setup_request_id,p_buyer_id);
  update public.exact_installment_payment_confirmations set confirmed_at=now() where id=q.id returning * into q;
  return q;
end;
$$;

-- Owner-filtered view with a small allowlisted shape. No customer, PI, card,
-- email, payment link, raw terms or provider error leaves this function.
create function public.read_exact_buyer_recovery(p_agreement_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; r public.exact_installment_payment_recoveries%rowtype;
  s public.exact_installment_card_setups%rowtype; q public.exact_installment_payment_confirmations%rowtype;
  p public.exact_installment_periods%rowtype; eligible boolean:=false;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id and terms->>'buyerId'=p_buyer_id::text;
  if not found then raise exception 'payment recovery unavailable'; end if;
  select * into r from public.exact_installment_payment_recoveries where agreement_id=a.id order by observed_at desc nulls last,stripe_invoice_id limit 1;
  if r.stripe_invoice_id is not null then
    select x.* into p from public.exact_installment_periods x join public.exact_installment_invoice_claims c on
      c.agreement_id=x.agreement_id and c.payment_number=x.payment_number where c.stripe_invoice_id=r.stripe_invoice_id;
    select * into s from public.exact_installment_card_setups where stripe_invoice_id=r.stripe_invoice_id and buyer_id=p_buyer_id;
    select * into q from public.exact_installment_payment_confirmations where setup_request_id=s.id and confirmed_at is not null limit 1;
    if r.outcome='payment_method_required' then
      begin
        perform public.assert_exact_card_setup_eligible(a.id,r.stripe_invoice_id,p_buyer_id);
        eligible:=s.id is null or extract(epoch from now())<s.expires_at;
      exception when raise_exception then eligible:=false;
      end;
    end if;
  end if;
  return jsonb_build_object('agreementId',a.id,'title',a.terms->>'title','totalCents',(a.terms->>'totalCents')::bigint,
    'paymentCount',(a.terms->>'paymentCount')::integer,'paymentNumber',p.payment_number,'amountCents',p.amount_cents,
    'outcome',r.outcome,'observedAt',r.observed_at,'setupRequestId',s.id,
    'setupState',case when s.id is null then 'not_started' when s.verified_at is not null then 'verified'
      when s.stripe_checkout_session_id is not null then 'started' else 'reserved' end,
    'setupEligible',eligible and q.id is null,'confirmedQuoteId',q.id);
end;
$$;

revoke all on function public.quote_exact_installment_retry(uuid,uuid,uuid),public.confirm_exact_installment_retry(uuid,uuid,text),
  public.read_exact_buyer_recovery(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.quote_exact_installment_retry(uuid,uuid,uuid),public.confirm_exact_installment_retry(uuid,uuid,text),
  public.read_exact_buyer_recovery(uuid,uuid) to service_role;
commit;
