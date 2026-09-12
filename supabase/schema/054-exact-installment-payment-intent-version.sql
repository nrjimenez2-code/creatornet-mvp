begin;

-- Bind record-only versus pay-now intent permanently to the reviewed quote.
-- Existing record-only confirmations must NEVER become deferred charge consent.
alter table public.exact_installment_payment_confirmations
  drop constraint exact_installment_payment_confirmations_consent_version_check;
alter table public.exact_installment_payment_confirmations
  add constraint exact_installment_payment_confirmations_consent_version_check
  check(consent_version in ('single-invoice-retry-v1','single-invoice-pay-now-v1'));

create function public.quote_exact_installment_retry(p_id uuid,p_setup_id uuid,p_buyer_id uuid,p_consent_version text)
returns public.exact_installment_payment_confirmations language plpgsql security definer set search_path=public,pg_temp as $$
declare s public.exact_installment_card_setups%rowtype; p public.exact_installment_periods%rowtype;
  q public.exact_installment_payment_confirmations%rowtype; expires bigint;
begin
  if p_id is null or p_consent_version is null or p_consent_version not in ('single-invoice-retry-v1','single-invoice-pay-now-v1') then raise exception 'payment review identity required'; end if;
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
    original_payment_intent_id,replacement_payment_method_id,setup_intent_id,authorization_snapshot,amount_cents,application_fee_cents,expires_at,consent_version)
    values(p_id,s.id,s.agreement_id,s.buyer_id,s.stripe_invoice_id,s.original_payment_intent_id,s.replacement_payment_method_id,
      s.stripe_setup_intent_id,s.authorization_snapshot,p.amount_cents,p.application_fee_cents,expires,p_consent_version) on conflict(id) do nothing;
  select * into q from public.exact_installment_payment_confirmations where id=p_id;
  if q.consent_version is distinct from p_consent_version or q.setup_request_id is distinct from s.id or q.buyer_id is distinct from p_buyer_id or
    q.stripe_invoice_id is distinct from s.stripe_invoice_id or q.original_payment_intent_id is distinct from s.original_payment_intent_id or
    q.replacement_payment_method_id is distinct from s.replacement_payment_method_id or q.setup_intent_id is distinct from s.stripe_setup_intent_id or
    q.authorization_snapshot is distinct from s.authorization_snapshot or q.amount_cents is distinct from p.amount_cents or
    q.application_fee_cents is distinct from p.application_fee_cents then raise exception 'payment review binding changed'; end if;
  if q.confirmed_at is null and extract(epoch from now())>=q.expires_at then raise exception 'payment review expired'; end if;
  return q;
end;
$$;

-- Preserve the original three-argument RPC as strictly RECORD ONLY. It cannot
-- return a pay-now quote under an old caller's review/consent wording.
create or replace function public.quote_exact_installment_retry(p_id uuid,p_setup_id uuid,p_buyer_id uuid)
returns public.exact_installment_payment_confirmations language sql security definer set search_path=public,pg_temp as $$
  select public.quote_exact_installment_retry(p_id,p_setup_id,p_buyer_id,'single-invoice-retry-v1');
$$;

create or replace function public.confirm_exact_installment_retry(p_id uuid,p_buyer_id uuid,p_consent_version text)
returns public.exact_installment_payment_confirmations language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.exact_installment_payment_confirmations%rowtype; fresh public.exact_installment_payment_confirmations%rowtype;
begin
  if p_buyer_id is null or (p_consent_version is null or p_consent_version not in ('single-invoice-retry-v1','single-invoice-pay-now-v1')) then raise exception 'payment confirmation required'; end if;
  select * into q from public.exact_installment_payment_confirmations where id=p_id and buyer_id=p_buyer_id;
  if not found then raise exception 'payment review unavailable'; end if;
  perform 1 from public.exact_installment_agreements where id=q.agreement_id and terms->>'buyerId'=p_buyer_id::text for update;
  if not found then raise exception 'payment review unavailable'; end if;
  select * into q from public.exact_installment_payment_confirmations where id=p_id for update;
  if q.consent_version is distinct from p_consent_version then raise exception 'payment execution mode changed'; end if;
  -- Repeating the exact consent after a lost response returns saved evidence,
  -- never a new dispatch. A future collector must separately admit the request.
  if q.confirmed_at is not null then return q; end if;
  fresh:=public.quote_exact_installment_retry(q.id,q.setup_request_id,p_buyer_id,p_consent_version);
  update public.exact_installment_payment_confirmations set confirmed_at=now() where id=q.id returning * into q;
  return q;
end;
$$;

revoke all on function public.quote_exact_installment_retry(uuid,uuid,uuid,text),
  public.quote_exact_installment_retry(uuid,uuid,uuid),public.confirm_exact_installment_retry(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.quote_exact_installment_retry(uuid,uuid,uuid,text),
  public.quote_exact_installment_retry(uuid,uuid,uuid),public.confirm_exact_installment_retry(uuid,uuid,text) to service_role;
commit;

