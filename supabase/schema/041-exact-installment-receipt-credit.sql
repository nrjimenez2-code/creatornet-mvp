begin;

-- Prospective exact-cents-held-v1 only. Requires 019 and 040. Nothing invokes
-- these RPCs from an enabled route yet. No legacy records are backfilled.
alter table public.exact_installment_agreements
  add column purchase_id uuid unique references public.purchases(id) on delete restrict;
alter table public.exact_installment_receipts
  add column ledger_id uuid unique references public.payment_fee_ledger(id) on delete restrict,
  add column counted_at timestamptz,
  add constraint exact_receipt_counted_link check ((counted_at is null) = (ledger_id is null));

create function public.bind_exact_installment_purchase(p_agreement_id uuid, p_purchase_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  p public.purchases%rowtype;
begin
  select * into a from public.exact_installment_agreements where id = p_agreement_id for update;
  if not found or a.status not in ('awaiting_first', 'active', 'complete') then
    raise exception 'agreement is not bound to Checkout';
  end if;
  select * into p from public.purchases where id = p_purchase_id for update;
  if not found or p.buyer_id::text is distinct from a.terms->>'buyerId' or
     p.creator_id::text is distinct from a.terms->>'creatorId' or
     p.post_id::text is distinct from a.terms->>'postId' or
     p.product_id::text is distinct from a.terms->>'productId' or
     p.booking_id::text is distinct from a.terms->>'bookingId' or
     p.session_id is distinct from a.stripe_checkout_session_id or
     p.subscription_id is distinct from a.stripe_subscription_id or
     p.target_months is distinct from (a.terms->>'paymentCount')::integer or
     lower(p.currency) is distinct from 'usd' then raise exception 'purchase agreement mismatch'; end if;
  if a.purchase_id is not null then
    if a.purchase_id is distinct from p.id then raise exception 'purchase already bound'; end if;
    return;
  end if;
  if a.status <> 'awaiting_first' or coalesce(p.paid_count, 0) <> 0 or p.access_granted or
     p.status not in ('pending', 'processing') or p.earnings_credited_at is not null or
     p.earnings_credited_cents is not null then raise exception 'cannot adopt an existing paid purchase'; end if;
  update public.exact_installment_agreements set purchase_id = p.id, updated_at = now() where id = a.id;
end;
$$;

-- The server must verify a captured Stripe receipt and its balance transaction
-- before calling. This transaction derives all economics from immutable terms,
-- not caller-provided net/fees. It links a receipt, credits only un-reversed net,
-- advances the existing purchase count and marks both claims atomically.
create function public.credit_exact_installment_receipt(p_agreement_id uuid, p_payment_number integer,
  p_charge_id text, p_balance_transaction_id text, p_actual_stripe_fee_cents bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  r public.exact_installment_receipts%rowtype;
  l public.payment_fee_ledger%rowtype;
  p public.purchases%rowtype;
  f public.payment_refund_state%rowtype;
  n integer;
  total bigint;
  gross bigint;
  platform bigint;
  processing bigint;
  net bigint;
  schedule jsonb;
  prior_count integer;
  audit_conflict boolean;
begin
  select * into a from public.exact_installment_agreements where id = p_agreement_id for update;
  if not found or a.purchase_id is null or a.status not in ('awaiting_first', 'active', 'complete') then
    raise exception 'agreement purchase not ready';
  end if;
  n := (a.terms->>'paymentCount')::integer;
  total := (a.terms->>'totalCents')::bigint;
  if p_payment_number is null or p_payment_number not between 1 and n or
     p_charge_id is null or p_charge_id !~ '^ch_[a-zA-Z0-9]+$' or
     p_balance_transaction_id is null or p_balance_transaction_id !~ '^txn_[a-zA-Z0-9]+$' or
     p_actual_stripe_fee_cents is null or p_actual_stripe_fee_cents not between 0 and 99999999 then
    raise exception 'invalid exact receipt audit input';
  end if;
  select * into r from public.exact_installment_receipts
    where agreement_id = a.id and payment_number = p_payment_number for update;
  if not found then raise exception 'verified receipt missing'; end if;
  gross := total / n + case when p_payment_number = n then total % n else 0 end;
  schedule := case when p_payment_number = 1 then a.terms->'firstPaymentFeeSchedule' else a.terms->'renewalFeeSchedule' end;
  platform := round(gross::numeric * 1200 / 10000)::bigint;
  processing := case when (schedule->>'enabled')::boolean then
    round(gross::numeric * (schedule->>'basisPoints')::integer / 10000)::bigint + (schedule->>'fixedCents')::bigint else 0 end;
  net := gross - platform - processing;
  if r.amount_cents <> gross or r.application_fee_cents <> platform + processing or net < 0 then
    raise exception 'receipt economics mismatch';
  end if;

  -- Serialize on the agreement, then the ledger. Existing refund RPCs never
  -- lock this new agreement table and keep ownership of reversal arithmetic.
  select * into l from public.payment_fee_ledger where stripe_payment_intent_id = r.stripe_payment_intent_id for update;
  if found then
    if l.purchase_id is distinct from a.purchase_id or l.creator_id::text is distinct from a.terms->>'creatorId' or
       l.booking_payment_id is distinct from a.booking_payment_id or l.stripe_invoice_id is distinct from r.stripe_invoice_id or
       l.currency is distinct from 'usd' or l.gross_amount_cents <> gross or
       l.platform_fee_cents <> platform or l.processing_fee_cents <> processing or
       l.total_creator_deduction_cents <> platform + processing or l.creator_net_cents <> net or
       l.fee_schedule_version is distinct from schedule->>'version' or l.status not in ('paid', 'refunded') or
       (p_payment_number = 1 and l.stripe_checkout_session_id is distinct from a.stripe_checkout_session_id) then
      raise exception 'existing ledger identity/economics mismatch';
    end if;
    audit_conflict := (l.stripe_charge_id is not null and l.stripe_charge_id <> p_charge_id) or
      (l.stripe_balance_transaction_id is not null and l.stripe_balance_transaction_id <> p_balance_transaction_id) or
      (l.actual_stripe_fee_cents is not null and l.actual_stripe_fee_cents <> p_actual_stripe_fee_cents);
    if audit_conflict then raise exception 'existing Stripe audit evidence differs'; end if;
  else
    insert into public.payment_fee_ledger(creator_id, purchase_id, booking_payment_id,
      stripe_checkout_session_id, stripe_payment_intent_id, stripe_invoice_id,
      gross_amount_cents, platform_fee_cents, processing_fee_cents, total_creator_deduction_cents,
      creator_net_cents, currency, fee_schedule_version, status)
    values ((a.terms->>'creatorId')::uuid, a.purchase_id, a.booking_payment_id,
      case when p_payment_number = 1 then a.stripe_checkout_session_id else null end,
      r.stripe_payment_intent_id, r.stripe_invoice_id, gross, platform, processing, platform + processing,
      net, 'usd', schedule->>'version', 'paid') returning * into l;
  end if;
  -- A later retry may carry newer cumulative refund evidence even after this
  -- receipt was counted. Reconcile before returning the no-new-credit result.
  -- The existing refund RPC owns both the monotonic reversal and its one-time
  -- earnings debit; a transaction failure below rolls this reconciliation back.
  select * into f from public.payment_refund_state where stripe_payment_intent_id = r.stripe_payment_intent_id;
  if found then
    if f.stripe_charge_id is distinct from p_charge_id or f.charge_amount_cents <> gross then
      raise exception 'refund evidence identity mismatch';
    end if;
    perform public.apply_payment_fee_ledger_refund(l.id, f.refunded_amount_cents);
  end if;
  if r.counted_at is not null then
    if r.ledger_id is distinct from l.id or l.earnings_credited_at is null then
      raise exception 'receipt credit evidence inconsistent';
    end if;
    return false;
  end if;
  if l.earnings_credited_at is not null then raise exception 'ledger credited outside exact receipt'; end if;

  -- Lock the creator before the purchase, matching the existing invoice credit
  -- function's lock order. Rollback retains neither a new ledger nor a credit.
  perform 1 from public.profiles where id = (a.terms->>'creatorId')::uuid for update;
  if not found then raise exception 'creator profile missing'; end if;
  select * into p from public.purchases where id = a.purchase_id for update;
  if not found or p.subscription_id is distinct from a.stripe_subscription_id or
     p.session_id is distinct from a.stripe_checkout_session_id or
     p.buyer_id::text is distinct from a.terms->>'buyerId' or p.creator_id::text is distinct from a.terms->>'creatorId' or
     p.post_id::text is distinct from a.terms->>'postId' or p.product_id::text is distinct from a.terms->>'productId' or
     p.booking_id::text is distinct from a.terms->>'bookingId' or p.target_months is distinct from n or
     p.earnings_credited_at is not null or p.earnings_credited_cents is not null or
     p.status not in ('pending', 'processing', 'active', 'complete') then
    raise exception 'purchase not eligible for exact credit';
  end if;
  select count(*) into prior_count from public.exact_installment_receipts
    where agreement_id = a.id and counted_at is not null;
  if prior_count <> p_payment_number - 1 or coalesce(p.paid_count, 0) <> prior_count or
     (p_payment_number > 1 and a.status <> 'active') then raise exception 'prior installment not credited'; end if;

  update public.payment_fee_ledger set stripe_charge_id = p_charge_id,
    stripe_balance_transaction_id = p_balance_transaction_id, actual_stripe_fee_cents = p_actual_stripe_fee_cents,
    processing_fee_variance_cents = processing - p_actual_stripe_fee_cents, updated_at = now() where id = l.id;
  -- A refund can already be mirrored by an earlier handler. Re-read its
  -- cumulative reversal while retaining the ledger lock; never credit it twice.
  select * into l from public.payment_fee_ledger where id = l.id;
  if l.earnings_reversed_cents < 0 or l.earnings_reversed_cents > net then raise exception 'invalid prior reversal'; end if;
  update public.profiles set total_earnings_cents = coalesce(total_earnings_cents, 0) + net - l.earnings_reversed_cents
    where id = p.creator_id;
  update public.purchases set paid_count = prior_count + 1, access_granted = true,
    status = case when prior_count + 1 = n then 'complete' else 'active' end,
    payment_intent_id = r.stripe_payment_intent_id, amount_cents = gross,
    platform_fee_cents = platform, processing_fee_cents = processing,
    total_creator_deduction_cents = platform + processing, creator_net_cents = net,
    fee_schedule_version = schedule->>'version'
    where id = p.id;
  update public.payment_fee_ledger set earnings_credited_at = now(), updated_at = now() where id = l.id;
  update public.exact_installment_receipts set ledger_id = l.id, counted_at = now()
    where agreement_id = a.id and payment_number = p_payment_number;
  -- Counting a receipt never activates/resumes Stripe collection. First-payment
  -- activation and final schedule termination remain separate acceptance gates.
  return true;
end;
$$;

revoke all on function public.bind_exact_installment_purchase(uuid, uuid),
  public.credit_exact_installment_receipt(uuid, integer, text, text, bigint) from public, anon, authenticated;
grant execute on function public.bind_exact_installment_purchase(uuid, uuid),
  public.credit_exact_installment_receipt(uuid, integer, text, text, bigint) to service_role;

commit;
