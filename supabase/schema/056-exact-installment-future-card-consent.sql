begin;

-- Prospective Preview candidate only. No Stripe default, automatic advance,
-- agreement, schedule, existing invoice claim, or past consent is rewritten.
alter table public.exact_installment_payment_confirmations add column future_card_option boolean not null default false;
alter table public.exact_installment_payment_confirmations add column future_card_periods jsonb,
  add column future_card_accepted boolean;
create table public.exact_installment_future_card_choices (
  confirmation_id uuid primary key references public.exact_installment_payment_confirmations on delete restrict,
  agreement_id uuid not null references public.exact_installment_agreements on delete restrict,
  accepted boolean not null,
  consent_version text not null check(consent_version='same-plan-remaining-card-v1'),
  consent_text text not null,
  first_payment_number integer not null check(first_payment_number>=3),
  remaining_periods jsonb not null check(jsonb_typeof(remaining_periods)='array'),
  created_at timestamptz not null default now()
);
create table public.exact_installment_invoice_cards (
  stripe_invoice_id text primary key references public.exact_installment_invoice_claims(stripe_invoice_id) on delete restrict,
  confirmation_id uuid not null references public.exact_installment_future_card_choices on delete restrict,
  authorization_snapshot jsonb not null check(jsonb_typeof(authorization_snapshot)='object'),
  created_at timestamptz not null default now()
);
-- An invoice recovery hold may be resolved only after the matching retry is
-- credited and all renewal checks pass. Archive its FULL row; never delete an
-- admin/refund/dispute/subscription hold or erase its audit evidence.
create table public.exact_installment_resolved_card_holds (
  hold_id uuid primary key,
  confirmation_id uuid not null references public.exact_installment_future_card_choices on delete restrict,
  hold_snapshot jsonb not null check(jsonb_typeof(hold_snapshot)='object'),
  resolved_at timestamptz not null default now()
);
alter table public.exact_installment_future_card_choices enable row level security;
alter table public.exact_installment_invoice_cards enable row level security;
alter table public.exact_installment_resolved_card_holds enable row level security;
revoke all on public.exact_installment_future_card_choices,public.exact_installment_invoice_cards,
  public.exact_installment_resolved_card_holds from public,anon,authenticated,service_role;
grant select on public.exact_installment_future_card_choices,public.exact_installment_invoice_cards,
  public.exact_installment_resolved_card_holds to service_role;

create function public.quote_exact_installment_future_card(p_id uuid,p_setup_id uuid,p_buyer_id uuid)
returns public.exact_installment_payment_confirmations language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.exact_installment_payment_confirmations%rowtype; existed boolean; periods jsonb;
begin
  -- Serialize quote creation/upgrade with confirmation on the same agreement.
  perform 1 from public.exact_installment_agreements a join public.exact_installment_card_setups s on s.agreement_id=a.id
    where s.id=p_setup_id and s.buyer_id=p_buyer_id for update of a;
  if not found then raise exception 'payment review unavailable'; end if;
  existed:=exists(select 1 from public.exact_installment_payment_confirmations where id=p_id);
  q:=public.quote_exact_installment_retry(p_id,p_setup_id,p_buyer_id,'single-invoice-pay-now-v1');
  if (q.authorization_snapshot->>'paymentNumber')::integer >= (q.authorization_snapshot->>'paymentCount')::integer then
    raise exception 'no remaining installments'; end if;
  if existed and not q.future_card_option then raise exception 'old review cannot gain future card consent'; end if;
  select jsonb_agg(jsonb_build_object('paymentNumber',payment_number,'amountCents',amount_cents,
    'dueAt',due_at,'periodEnd',period_end) order by payment_number) into periods from public.exact_installment_periods
    where agreement_id=q.agreement_id and payment_number>(q.authorization_snapshot->>'paymentNumber')::integer;
  if periods is null then raise exception 'remaining schedule unavailable'; end if;
  if existed and q.future_card_periods is distinct from periods then raise exception 'reviewed schedule changed'; end if;
  if not existed then update public.exact_installment_payment_confirmations set future_card_option=true,future_card_periods=periods
    where id=q.id returning * into q; end if;
  return q;
end;
$$;

create function public.confirm_exact_installment_future_card(p_id uuid,p_buyer_id uuid,p_accepted boolean,p_consent_version text)
returns public.exact_installment_payment_confirmations language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.exact_installment_payment_confirmations%rowtype; c public.exact_installment_future_card_choices%rowtype;
  periods jsonb; first_number integer;
begin
  if p_accepted is null or p_consent_version is distinct from 'same-plan-remaining-card-v1' then raise exception 'explicit future card choice required'; end if;
  select * into q from public.exact_installment_payment_confirmations where id=p_id and buyer_id=p_buyer_id;
  if not found then raise exception 'payment review unavailable'; end if;
  perform 1 from public.exact_installment_agreements where id=q.agreement_id and terms->>'buyerId'=p_buyer_id::text for update;
  if not found then raise exception 'payment review unavailable'; end if;
  select * into q from public.exact_installment_payment_confirmations where id=p_id for update;
  if not q.future_card_option or q.consent_version<>'single-invoice-pay-now-v1' then raise exception 'future option not reviewed'; end if;
  select * into c from public.exact_installment_future_card_choices where confirmation_id=q.id;
  if q.confirmed_at is not null then
    if not found or c.accepted is distinct from p_accepted or c.consent_version is distinct from p_consent_version then
      raise exception 'confirmed future card choice cannot change'; end if;
    return q;
  end if;
  first_number:=(q.authorization_snapshot->>'paymentNumber')::integer+1;
  select jsonb_agg(jsonb_build_object('paymentNumber',payment_number,'amountCents',amount_cents,
    'dueAt',due_at,'periodEnd',period_end) order by payment_number) into periods
    from public.exact_installment_periods where agreement_id=q.agreement_id and payment_number>=first_number;
  if periods is null or jsonb_array_length(periods)<>(q.authorization_snapshot->>'paymentCount')::integer-first_number+1 then
    raise exception 'remaining schedule unavailable'; end if;
  if periods is distinct from q.future_card_periods then raise exception 'reviewed schedule changed'; end if;
  -- Atomic with one-invoice consent. Neither consent itself can admit a charge.
  q:=public.confirm_exact_installment_retry(q.id,p_buyer_id,'single-invoice-pay-now-v1');
  insert into public.exact_installment_future_card_choices(confirmation_id,agreement_id,accepted,consent_version,consent_text,first_payment_number,remaining_periods)
    values(q.id,q.agreement_id,p_accepted,p_consent_version,
      'Optional: Use this replacement card for the remaining scheduled installments on this plan only, after this payment is verified and the account checks pass. The original amounts, dates, and fixed end stay unchanged. This does not collect the remaining balance now or authorize payments for other purchases.',
      first_number,periods);
  update public.exact_installment_payment_confirmations set future_card_accepted=p_accepted where id=q.id returning * into q;
  return q;
end;
$$;

alter function public.admit_exact_installment_retry(uuid,uuid) rename to admit_exact_installment_retry_original;
revoke all on function public.admit_exact_installment_retry_original(uuid,uuid) from public,anon,authenticated,service_role;
create function public.admit_exact_installment_retry(p_confirmation_id uuid,p_buyer_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare q public.exact_installment_payment_confirmations%rowtype;
begin
  select * into q from public.exact_installment_payment_confirmations where id=p_confirmation_id and buyer_id=p_buyer_id;
  if not found then raise exception 'retry confirmation unavailable'; end if;
  perform 1 from public.exact_installment_agreements where id=q.agreement_id for update;
  select * into q from public.exact_installment_payment_confirmations where id=p_confirmation_id;
  if q.future_card_option and not exists(select 1 from public.exact_installment_future_card_choices c
    where c.confirmation_id=q.id and c.agreement_id=q.agreement_id and c.accepted=q.future_card_accepted and
      c.consent_version='same-plan-remaining-card-v1' and c.remaining_periods=q.future_card_periods) then
    raise exception 'future card decision not recorded'; end if;
  return public.admit_exact_installment_retry_original(p_confirmation_id,p_buyer_id);
end;
$$;

-- Keep the old implementation private, preserving ALL prior locks/admission
-- checks. Only a brand-new period can acquire a different card authorization.
alter function public.claim_exact_installment_invoice(uuid,text,text,bigint,bigint,uuid) rename to claim_exact_installment_invoice_original;
revoke all on function public.claim_exact_installment_invoice_original(uuid,text,text,bigint,bigint,uuid) from public,anon,authenticated,service_role;
create function public.claim_exact_installment_invoice(p_agreement_id uuid,p_invoice_id text,p_subscription_id text,
  p_period_start bigint,p_period_end bigint,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype; period public.exact_installment_periods%rowtype;
  c public.exact_installment_future_card_choices%rowtype; q public.exact_installment_payment_confirmations%rowtype;
  existing public.exact_installment_invoice_claims%rowtype; binding public.exact_installment_invoice_cards%rowtype;
  result jsonb; authorized jsonb; periods jsonb;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  select * into period from public.exact_installment_periods where agreement_id=a.id and due_at=p_period_start and period_end=p_period_end;
  select * into existing from public.exact_installment_invoice_claims where agreement_id=a.id and payment_number=period.payment_number;
  select * into binding from public.exact_installment_invoice_cards where stripe_invoice_id=existing.stripe_invoice_id;
  if binding.stripe_invoice_id is not null and existing.status in ('dispatching','paid','review_required') then
    -- A later refund/stop must not prevent accounting for an already-admitted
    -- charge. Use the permanently bound card, never reauthorize or pay again.
    result:=public.claim_exact_installment_invoice_original(p_agreement_id,p_invoice_id,p_subscription_id,p_period_start,p_period_end,p_claim_token);
    if result->>'status'<>'reconcile' or binding.stripe_invoice_id<>p_invoice_id then raise exception 'admitted card binding differs'; end if;
    return jsonb_set(result,'{authorization}',binding.authorization_snapshot);
  end if;
  if binding.stripe_invoice_id is not null then
    select * into c from public.exact_installment_future_card_choices where confirmation_id=binding.confirmation_id;
  elsif existing.stripe_invoice_id is null then
    select * into c from public.exact_installment_future_card_choices where agreement_id=a.id and accepted
      and first_payment_number<=period.payment_number order by first_payment_number desc,created_at desc limit 1;
  end if;
  if c.confirmation_id is not null then
    select * into q from public.exact_installment_payment_confirmations where id=c.confirmation_id;
    if not c.accepted or q.agreement_id is distinct from a.id or q.buyer_id::text is distinct from a.terms->>'buyerId' or
      q.consent_version<>'single-invoice-pay-now-v1' or not q.future_card_option or q.confirmed_at is null then
      raise exception 'future card binding invalid'; end if;
    select jsonb_agg(jsonb_build_object('paymentNumber',payment_number,'amountCents',amount_cents,
      'dueAt',due_at,'periodEnd',period_end) order by payment_number) into periods from public.exact_installment_periods
      where agreement_id=a.id and payment_number>=c.first_payment_number;
    if periods is distinct from c.remaining_periods then raise exception 'remaining schedule changed'; end if;
    -- Admission + paid/credited evidence must refer to this exact consent and
    -- the original retry PI. A checkbox, setup success, or succeeded UI is not proof.
    if not exists(select 1 from public.exact_installment_retry_admissions d
      join public.exact_installment_receipts r on r.agreement_id=d.agreement_id and r.stripe_payment_intent_id=q.original_payment_intent_id
      join public.payment_fee_ledger l on l.id=r.ledger_id
      where d.confirmation_id=q.id and d.agreement_id=a.id and d.stripe_invoice_id=q.stripe_invoice_id and
      r.payment_number=c.first_payment_number-1 and r.counted_at is not null and l.earnings_credited_at is not null and
      l.status='paid' and l.purchase_id=a.purchase_id and l.stripe_payment_intent_id=r.stripe_payment_intent_id) then
      raise exception 'replacement payment not credited'; end if;
    if existing.stripe_invoice_id is null or existing.status in ('preparing','prepared') then
      -- These writes are in the SAME transaction as the original renewal
      -- readiness assertion. Any other hold/refund/stop/period failure rolls
      -- everything back. Repeated recovery observations can only block again.
      insert into public.exact_installment_resolved_card_holds(hold_id,confirmation_id,hold_snapshot)
        select h.id,q.id,to_jsonb(h) from public.exact_installment_collection_holds h where h.agreement_id=a.id and
          h.reason='invoice_recovery' and h.stripe_object_id=q.stripe_invoice_id and h.stripe_payment_intent_id=q.original_payment_intent_id
        on conflict(hold_id) do nothing;
      delete from public.exact_installment_collection_holds h where h.agreement_id=a.id and h.reason='invoice_recovery' and
        h.stripe_object_id=q.stripe_invoice_id and h.stripe_payment_intent_id=q.original_payment_intent_id and
        exists(select 1 from public.exact_installment_resolved_card_holds x where x.hold_id=h.id and x.confirmation_id=q.id and x.hold_snapshot=to_jsonb(h));
      perform public.assert_exact_installment_renewal_ready(a.id,period.payment_number);
    end if;
  end if;
  result:=public.claim_exact_installment_invoice_original(p_agreement_id,p_invoice_id,p_subscription_id,p_period_start,p_period_end,p_claim_token);
  if binding.stripe_invoice_id is not null and result->>'status'<>'busy' then
    if binding.stripe_invoice_id<>p_invoice_id then raise exception 'future invoice binding changed'; end if;
    return jsonb_set(result,'{authorization}',binding.authorization_snapshot);
  end if;
  if c.confirmation_id is not null and existing.stripe_invoice_id is null and result->>'status'='prepare' then
    authorized:=result->'authorization';
    authorized:=authorized || jsonb_build_object('defaultPaymentMethodId',authorized->>'paymentMethodId',
      'paymentMethodId',q.replacement_payment_method_id,'cardAuthorizationId',q.id);
    insert into public.exact_installment_invoice_cards(stripe_invoice_id,confirmation_id,authorization_snapshot)
      values(p_invoice_id,q.id,authorized);
    result:=jsonb_set(result,'{authorization}',authorized);
  end if;
  return result;
end;
$$;

alter function public.read_exact_buyer_recovery(uuid,uuid) rename to read_exact_buyer_recovery_original;
revoke all on function public.read_exact_buyer_recovery_original(uuid,uuid) from public,anon,authenticated,service_role;
create function public.read_exact_buyer_recovery(p_agreement_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; choice boolean;
begin
  result:=public.read_exact_buyer_recovery_original(p_agreement_id,p_buyer_id);
  select c.accepted into choice from public.exact_installment_future_card_choices c
    join public.exact_installment_payment_confirmations q on q.id=c.confirmation_id
    where q.id::text=result->>'confirmedQuoteId' and q.agreement_id=p_agreement_id and q.buyer_id=p_buyer_id and q.confirmed_at is not null;
  if found then result:=result||jsonb_build_object('futureCardAccepted',choice); end if;
  return result;
end;
$$;

revoke all on function public.quote_exact_installment_future_card(uuid,uuid,uuid),
  public.confirm_exact_installment_future_card(uuid,uuid,boolean,text),
  public.admit_exact_installment_retry(uuid,uuid),
  public.read_exact_buyer_recovery(uuid,uuid),
  public.claim_exact_installment_invoice(uuid,text,text,bigint,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function public.quote_exact_installment_future_card(uuid,uuid,uuid),
  public.confirm_exact_installment_future_card(uuid,uuid,boolean,text),
  public.admit_exact_installment_retry(uuid,uuid),
  public.read_exact_buyer_recovery(uuid,uuid),
  public.claim_exact_installment_invoice(uuid,text,text,bigint,bigint,uuid) to service_role;
commit;
