begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

-- Release a frozen manual payoff only after its own journal proves no provider
-- intent was dispatched, or the bound original is durably canceled with zero
-- money. The hosted payoff abandonment function cannot release this source.
do $preflight$ begin
  if current_user<>'postgres' or
    to_regprocedure('public.record_monthly_manual_payoff_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)') is null or
    to_regclass('public.server_payment_intent_terminal_v1') is null or
    to_regprocedure('public.release_monthly_manual_payoff_v1(uuid,uuid,jsonb,uuid,jsonb)') is not null then
    raise exception 'Monthly manual payoff terminal prerequisites differ'; end if;
end $preflight$;

create function public.monthly_manual_payoff_terminal_v1(p_payoff_id uuid,p_proof jsonb)
returns boolean language plpgsql security invoker set search_path=pg_catalog as $$
declare pf public.monthly_mentorship_payoffs_v1%rowtype;
  a public.monthly_mentorship_agreements_v1%rowtype;
  m public.monthly_manual_payment_selections_v1%rowtype;
  s public.server_payment_protocols_v1%rowtype;
  i public.server_payment_intent_operations_v1%rowtype;
  t public.server_payment_intent_terminal_v1%rowtype;
  expected_context jsonb;
begin
  select * into pf from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=pf.agreement_id;
  select * into m from public.monthly_manual_payment_selections_v1 where payoff_id=p_payoff_id;
  if pf.id is null or a.id is null or m.id is null or m.agreement_id is distinct from a.id or
    m.buyer_id is distinct from a.buyer_id or m.buyer_id is distinct from pf.buyer_id or
    m.kind is distinct from 'payoff' or m.context is distinct from a.terms->'paymentContext' or
    m.source->>'agreementFingerprint' is distinct from a.fingerprint or
    m.source->>'sourceFingerprint' is distinct from pf.fingerprint or
    m.source->'terms' is distinct from pf.terms or
    pf.status<>'accepted' or pf.ledger_id is not null or pf.provider_proof is not null or
    pf.checkout_request is not null or pf.checkout_dispatched_at is not null or
    pf.stripe_checkout_session_id is not null or pf.checkout_request_id is not null or
    a.payoff_hold_at is null or a.covered_months<>pf.first_unpaid_month-1 or
    p_proof is null or jsonb_typeof(p_proof)<>'object' or
    p_proof-array['version','paymentContext','payoffId','selectionId','neverDispatched','paymentIntentId','terminalProof']<>'{}'::jsonb or
    p_proof->>'version' is distinct from 'monthly-manual-payoff-terminal-v1' or
    p_proof->'paymentContext' is distinct from m.context or
    p_proof->>'payoffId' is distinct from p_payoff_id::text or
    p_proof->>'selectionId' is distinct from m.id::text or
    jsonb_typeof(p_proof->'neverDispatched') is distinct from 'boolean' then return false; end if;
  select * into s from public.server_payment_protocols_v1 where attempt_id=m.id;
  select * into i from public.server_payment_intent_operations_v1 where attempt_id=m.id;
  select * into t from public.server_payment_intent_terminal_v1 where attempt_id=m.id;
  if s.attempt_id is null then
    return p_proof->'neverDispatched'='true'::jsonb and
      p_proof->'paymentIntentId'='null'::jsonb and p_proof->'terminalProof'='null'::jsonb and
      i.attempt_id is null and t.attempt_id is null and
      not exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=m.id) and
      not exists(select 1 from public.server_payment_stops_v1 where attempt_id=m.id) and
      not exists(select 1 from public.server_payment_intent_cancellations_v1 where attempt_id=m.id);
  end if;
  expected_context:=jsonb_build_object('version','exact-payment-context-v1',
    'mode',m.context->>'mode','platformAccountId',m.context->>'stripeAccountId',
    'supabaseProjectRef',m.context->>'supabaseProjectRef','siteOrigin',m.context->>'siteOrigin');
  if s.kind is distinct from 'monthly_payoff' or s.reservation_id is not null or
    s.buyer_id is distinct from a.buyer_id or s.product_id is distinct from a.product_id or
    s.context is distinct from expected_context or s.source is distinct from to_jsonb(m) or
    not exists(select 1 from public.server_payment_stops_v1 where attempt_id=m.id) then return false; end if;
  if i.attempt_id is null then
    return p_proof->'neverDispatched'='true'::jsonb and
      p_proof->'paymentIntentId'='null'::jsonb and p_proof->'terminalProof'='null'::jsonb and
      t.attempt_id is null and
      not exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=m.id) and
      not exists(select 1 from public.server_payment_intent_cancellations_v1 where attempt_id=m.id);
  end if;
  if i.bound_at is null or i.payment_intent_id is null or
    i.contract->>'attemptId' is distinct from m.id::text or
    i.contract->>'kind' is distinct from 'monthly_payoff' or
    i.contract->'context' is distinct from expected_context or
    i.contract->>'termsFingerprint' is distinct from pf.fingerprint or
    i.contract->>'customerId' is distinct from a.stripe_customer_id or
    i.contract->>'amountCents' is distinct from pf.amount_cents::text or
    p_proof->'neverDispatched' is distinct from 'false'::jsonb or
    p_proof->>'paymentIntentId' is distinct from i.payment_intent_id or
    t.attempt_id is null or p_proof->'terminalProof' is distinct from t.proof or
    t.proof->>'version' is distinct from 'server-payment-intent-terminal-v1' or
    t.proof->>'paymentIntentId' is distinct from i.payment_intent_id or
    t.proof->>'status' is distinct from 'canceled' or
    t.proof->'amountReceived' is distinct from '0'::jsonb or
    t.proof->'amountCapturable' is distinct from '0'::jsonb or
    exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=i.payment_intent_id) or
    exists(select 1 from public.server_payment_confirmations_v1
      where attempt_id=m.id and latest_observation->>'status'='succeeded') then return false; end if;
  return true;
end $$;
revoke all on function public.monthly_manual_payoff_terminal_v1(uuid,jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.guard_monthly_manual_payoff_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if not exists(select 1 from public.monthly_manual_payment_selections_v1 where payoff_id=old.id) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then raise exception 'Original manual payoff cannot be deleted'; end if;
  if new.id is distinct from old.id or new.agreement_id is distinct from old.agreement_id or
    new.buyer_id is distinct from old.buyer_id or new.terms is distinct from old.terms or
    new.fingerprint is distinct from old.fingerprint or new.amount_cents is distinct from old.amount_cents or
    new.remaining_months is distinct from old.remaining_months or new.first_unpaid_month is distinct from old.first_unpaid_month or
    new.period_start is distinct from old.period_start or new.period_end is distinct from old.period_end or
    new.accepted_at is distinct from old.accepted_at or new.checkout_request is not null or
    new.checkout_dispatched_at is not null or new.stripe_checkout_session_id is not null or
    new.checkout_request_id is not null then
    raise exception 'Original manual payoff immutable source differs'; end if;
  if new.status='abandoned' or new.abandoned_at is not null or new.abandonment_proof is not null then
    if old.status<>'accepted' or new.status<>'abandoned' or new.abandoned_at is null or
      new.abandonment_proof is null or not public.monthly_manual_payoff_terminal_v1(old.id,new.abandonment_proof) then
      raise exception 'Original manual payoff requires verified terminal recovery'; end if;
  end if;
  return new;
end $$;

create function public.release_monthly_manual_payoff_v1(
  p_payoff_id uuid,p_buyer_id uuid,p_context jsonb,p_selection_id uuid,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
  pf public.monthly_mentorship_payoffs_v1%rowtype;
  m public.monthly_manual_payment_selections_v1%rowtype;
  agreement uuid;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_proof is null or
    jsonb_typeof(p_proof)<>'object' or octet_length(p_proof::text)>100000 then
    raise exception 'Original manual payoff release input differs'; end if;
  select agreement_id into agreement from public.monthly_mentorship_payoffs_v1
    where id=p_payoff_id and buyer_id=p_buyer_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=agreement for update;
  select * into pf from public.monthly_mentorship_payoffs_v1 where id=p_payoff_id for update;
  select * into m from public.monthly_manual_payment_selections_v1 where id=p_selection_id;
  if a.id is null or pf.id is null or m.id is null or pf.agreement_id is distinct from a.id or
    a.buyer_id is distinct from p_buyer_id or pf.buyer_id is distinct from p_buyer_id or
    m.payoff_id is distinct from pf.id or m.agreement_id is distinct from a.id or
    a.terms->'paymentContext' is distinct from m.context or
    p_proof->'paymentContext' is distinct from m.context or
    p_context is distinct from jsonb_build_object('version','exact-payment-context-v1',
      'mode',m.context->>'mode','platformAccountId',m.context->>'stripeAccountId',
      'supabaseProjectRef',m.context->>'supabaseProjectRef','siteOrigin',m.context->>'siteOrigin') then
    raise exception 'Original manual payoff release owner differs'; end if;
  if pf.status='abandoned' then
    if pf.abandonment_proof is distinct from p_proof then
      raise exception 'Original manual payoff release replay differs'; end if;
    return false;
  end if;
  if not public.monthly_manual_payoff_terminal_v1(pf.id,p_proof) then
    raise exception 'Original manual payoff terminal evidence is incomplete'; end if;
  update public.monthly_mentorship_payoffs_v1 set status='abandoned',
    abandonment_proof=p_proof,abandoned_at=clock_timestamp() where id=pf.id;
  update public.monthly_mentorship_agreements_v1 set payoff_hold_at=null,
    revision=revision+1,billing_next_attempt_at=clock_timestamp() where id=a.id;
  return true;
end $$;
revoke all on function public.release_monthly_manual_payoff_v1(uuid,uuid,jsonb,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.release_monthly_manual_payoff_v1(uuid,uuid,jsonb,uuid,jsonb)
  to service_role;
commit;
