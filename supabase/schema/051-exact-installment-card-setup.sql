begin;

-- Prospective, gated Sandbox candidate. This is permission to SAVE a card,
-- never permission to retry a debit or change an existing authorization.
create table public.exact_installment_card_setups (
  id uuid primary key,
  agreement_id uuid not null references public.exact_installment_agreements on delete restrict,
  stripe_invoice_id text not null unique references public.exact_installment_invoice_claims(stripe_invoice_id) on delete restrict,
  buyer_id uuid not null,
  original_payment_intent_id text not null check(original_payment_intent_id ~ '^pi_[a-zA-Z0-9]+$'),
  authorization_snapshot jsonb not null check(jsonb_typeof(authorization_snapshot)='object'),
  consent_version text not null check(consent_version='replacement-card-setup-v1'),
  created_at timestamptz not null default now(),
  expires_at bigint not null default (floor(extract(epoch from now()))::bigint+3600),
  stripe_checkout_session_id text unique check(stripe_checkout_session_id ~ '^cs_test_[a-zA-Z0-9]+$'),
  stripe_setup_intent_id text unique check(stripe_setup_intent_id ~ '^seti_[a-zA-Z0-9]+$'),
  replacement_payment_method_id text check(replacement_payment_method_id ~ '^pm_[a-zA-Z0-9]+$'),
  verified_at timestamptz,
  check((stripe_setup_intent_id is null)=(replacement_payment_method_id is null)),
  check((verified_at is null)=(stripe_setup_intent_id is null)),
  check(stripe_setup_intent_id is null or stripe_checkout_session_id is not null)
);
alter table public.exact_installment_card_setups enable row level security;
revoke all on public.exact_installment_card_setups from public,anon,authenticated,service_role;
grant select on public.exact_installment_card_setups to service_role;

-- All callers lock agreement first. Any stop/refund/dispute/other-invoice hold
-- blocks this setup. No hold is removed, even after verification succeeds.
create function public.assert_exact_card_setup_eligible(p_agreement_id uuid,p_invoice_id text,p_buyer_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; c public.exact_installment_invoice_claims%rowtype;
  r public.exact_installment_payment_recoveries%rowtype; p public.exact_installment_periods%rowtype; result jsonb;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or p_buyer_id is null or a.terms->>'buyerId' is distinct from p_buyer_id::text or a.status<>'active' then
    raise exception 'card setup unavailable'; end if;
  select * into c from public.exact_installment_invoice_claims where agreement_id=a.id and stripe_invoice_id=p_invoice_id for update;
  if not found or c.status<>'dispatching' or c.dispatch_started_at is null or c.stripe_payment_intent_id is null then
    raise exception 'card setup requires original unpaid admission'; end if;
  select * into r from public.exact_installment_payment_recoveries where agreement_id=a.id and stripe_invoice_id=c.stripe_invoice_id;
  if not found or r.stripe_payment_intent_id is distinct from c.stripe_payment_intent_id or r.outcome is distinct from 'payment_method_required' then
    raise exception 'card setup requires observed decline'; end if;
  if not exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id and reason='invoice_recovery' and
      stripe_object_id=c.stripe_invoice_id and stripe_payment_intent_id=c.stripe_payment_intent_id) or
    exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id and
      (reason<>'invoice_recovery' or stripe_object_id is distinct from c.stripe_invoice_id or stripe_payment_intent_id is distinct from c.stripe_payment_intent_id)) or
    exists(select 1 from public.exact_installment_billing_stops where agreement_id=a.id) or
    exists(select 1 from public.exact_installment_receipts where agreement_id=a.id and payment_number>=c.payment_number) then
    raise exception 'card setup requires review'; end if;
  if not exists(select 1 from public.purchases where id=a.purchase_id and buyer_id=p_buyer_id and status='active' and
      access_granted=true and is_refund=false and is_suspect=false and paid_count=c.payment_number-1) then
    raise exception 'card setup purchase unavailable'; end if;
  select * into p from public.exact_installment_periods where agreement_id=a.id and payment_number=c.payment_number;
  if not found or extract(epoch from now())<p.due_at or extract(epoch from now())>=p.period_end then
    raise exception 'card setup outside scheduled period'; end if;
  result:=public.claim_exact_installment_invoice(a.id,c.stripe_invoice_id,a.stripe_subscription_id,p.due_at,p.period_end,gen_random_uuid());
  if result->>'status' is distinct from 'reconcile' or result->>'paymentIntentId' is distinct from c.stripe_payment_intent_id then
    raise exception 'card setup admission changed'; end if;
  return result;
end;
$$;

create function public.reserve_exact_card_setup(p_id uuid,p_agreement_id uuid,p_invoice_id text,p_buyer_id uuid,p_consent_version text)
returns public.exact_installment_card_setups language plpgsql security definer set search_path=public,pg_temp as $$
declare snapshot jsonb; saved public.exact_installment_card_setups%rowtype;
begin
  if p_id is null or p_consent_version is distinct from 'replacement-card-setup-v1' then raise exception 'card setup consent required'; end if;
  snapshot:=public.assert_exact_card_setup_eligible(p_agreement_id,p_invoice_id,p_buyer_id);
  insert into public.exact_installment_card_setups(id,agreement_id,stripe_invoice_id,buyer_id,original_payment_intent_id,authorization_snapshot,consent_version)
    values(p_id,p_agreement_id,p_invoice_id,p_buyer_id,snapshot->>'paymentIntentId',snapshot->'authorization',p_consent_version)
    on conflict(stripe_invoice_id) do nothing;
  select * into saved from public.exact_installment_card_setups where stripe_invoice_id=p_invoice_id;
  if saved.id is distinct from p_id or saved.buyer_id is distinct from p_buyer_id or saved.agreement_id is distinct from p_agreement_id or
    saved.authorization_snapshot is distinct from snapshot->'authorization' or saved.original_payment_intent_id is distinct from snapshot->>'paymentIntentId' then
    raise exception 'card setup request identity changed'; end if;
  if extract(epoch from now())>=saved.expires_at then raise exception 'card setup expired; review required'; end if;
  return saved;
end;
$$;

create function public.read_current_exact_card_setup(p_id uuid,p_buyer_id uuid)
returns public.exact_installment_card_setups language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.exact_installment_card_setups%rowtype; snapshot jsonb;
begin
  select * into saved from public.exact_installment_card_setups where id=p_id and buyer_id=p_buyer_id;
  if not found then raise exception 'card setup unavailable'; end if;
  snapshot:=public.assert_exact_card_setup_eligible(saved.agreement_id,saved.stripe_invoice_id,p_buyer_id);
  if snapshot->'authorization' is distinct from saved.authorization_snapshot or snapshot->>'paymentIntentId' is distinct from saved.original_payment_intent_id or
    extract(epoch from now())>=saved.expires_at then raise exception 'card setup stale; review required'; end if;
  select * into saved from public.exact_installment_card_setups where id=p_id for update;
  return saved;
end;
$$;

create function public.bind_exact_card_setup(p_id uuid,p_buyer_id uuid,p_session_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.exact_installment_card_setups%rowtype;
begin
  saved:=public.read_current_exact_card_setup(p_id,p_buyer_id);
  if p_session_id is null or p_session_id !~ '^cs_test_[a-zA-Z0-9]+$' or
    (saved.stripe_checkout_session_id is not null and saved.stripe_checkout_session_id<>p_session_id) then
    raise exception 'card setup session differs'; end if;
  update public.exact_installment_card_setups set stripe_checkout_session_id=p_session_id where id=p_id;
end;
$$;

create function public.verify_exact_card_setup(p_id uuid,p_buyer_id uuid,p_session_id text,p_setup_intent_id text,p_payment_method_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare saved public.exact_installment_card_setups%rowtype;
begin
  saved:=public.read_current_exact_card_setup(p_id,p_buyer_id);
  if saved.stripe_checkout_session_id is null or saved.stripe_checkout_session_id is distinct from p_session_id or
    p_setup_intent_id is null or p_setup_intent_id !~ '^seti_[a-zA-Z0-9]+$' or
    p_payment_method_id is null or p_payment_method_id !~ '^pm_[a-zA-Z0-9]+$' or
    (saved.stripe_setup_intent_id is not null and (saved.stripe_setup_intent_id<>p_setup_intent_id or
      saved.replacement_payment_method_id<>p_payment_method_id)) then raise exception 'card setup result differs'; end if;
  update public.exact_installment_card_setups set stripe_setup_intent_id=p_setup_intent_id,
    replacement_payment_method_id=p_payment_method_id,verified_at=coalesce(verified_at,now()) where id=p_id;
  -- No update to activation_snapshot, invoice claim, subscription defaults,
  -- recoveries, holds, purchases, ledger, dispatch or original payment method.
end;
$$;

revoke all on function public.assert_exact_card_setup_eligible(uuid,text,uuid),
  public.reserve_exact_card_setup(uuid,uuid,text,uuid,text),public.read_current_exact_card_setup(uuid,uuid),
  public.bind_exact_card_setup(uuid,uuid,text),public.verify_exact_card_setup(uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.reserve_exact_card_setup(uuid,uuid,text,uuid,text),public.read_current_exact_card_setup(uuid,uuid),
  public.bind_exact_card_setup(uuid,uuid,text),public.verify_exact_card_setup(uuid,uuid,text,text,text) to service_role;
commit;
