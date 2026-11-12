begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

-- Extend only the source adapter for the existing cancellation/terminal
-- journal. Stops, requests, leases, keys and proof validators remain shared.
-- This grants no subscription cancellation, agreement release or debt waiver.
do $copy$
declare body text; needle text:='FUNCTION public.read_server_payment_cancellation_source_v1(';
begin
  if current_user<>'postgres' or to_regprocedure('public.register_monthly_manual_source_v1(uuid,uuid,jsonb)') is null or
    to_regprocedure('public.read_nonmonthly_server_payment_cancellation_source_v1(uuid,uuid,jsonb)') is not null then
    raise exception 'Monthly manual cancellation prerequisites differ'; end if;
  body:=pg_get_functiondef('public.read_server_payment_cancellation_source_v1(uuid,uuid,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
    raise exception 'Original cancellation source differs'; end if;
  execute replace(body,needle,'FUNCTION public.read_nonmonthly_server_payment_cancellation_source_v1(');
end $copy$;
revoke all on function public.read_nonmonthly_server_payment_cancellation_source_v1(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.read_server_payment_cancellation_source_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare s public.server_payment_protocols_v1%rowtype; m public.monthly_manual_payment_selections_v1%rowtype;
  a public.monthly_mentorship_agreements_v1%rowtype; pf public.monthly_mentorship_payoffs_v1%rowtype;
  original public.server_payment_intent_operations_v1%rowtype;
begin
  select * into s from public.server_payment_protocols_v1 where attempt_id=p_attempt_id;
  if not found or s.kind not in ('monthly_first','monthly_payoff') then
    return public.read_nonmonthly_server_payment_cancellation_source_v1(p_attempt_id,p_buyer_id,p_context);
  end if;
  -- The existing source adapter validates exact provenance and owner/context,
  -- then takes the buyer/product advisory lock and agreement row lock. Read
  -- recovery deliberately survives expiry, revision changes and debit stops.
  s:=public.read_server_payment_source_v1(p_attempt_id,p_buyer_id,p_context,false);
  if not exists(select 1 from public.server_payment_stops_v1 where attempt_id=s.attempt_id) then
    raise exception 'Original stop must be persisted first'; end if;
  select * into m from public.monthly_manual_payment_selections_v1 where id=s.attempt_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=m.agreement_id;
  if m.kind='first' then
    if a.covered_months<>0 or a.anchor_at is not null or a.stripe_checkout_session_id is not null or
      a.initial_abandoned_at is not null or
      exists(select 1 from public.monthly_mentorship_receipts_v1 where agreement_id=a.id) or
      exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind in ('checkout','activate','collect')) or
      exists(select 1 from public.payment_fee_ledger where purchase_id=a.purchase_id) then
      raise exception 'Monthly first payment requires financial reconciliation'; end if;
  else
    select * into pf from public.monthly_mentorship_payoffs_v1 where id=m.payoff_id and agreement_id=a.id for update;
    if not found or pf.buyer_id is distinct from p_buyer_id or pf.fingerprint is distinct from m.source->>'sourceFingerprint' or
      pf.status<>'accepted' or pf.checkout_request is not null or pf.checkout_dispatched_at is not null or
      pf.stripe_checkout_session_id is not null or pf.checkout_request_id is not null or
      pf.ledger_id is not null or pf.provider_proof is not null or pf.captured_at is not null or
      pf.abandoned_at is not null or pf.abandonment_proof is not null or a.payoff_hold_at is null then
      raise exception 'Monthly payoff requires financial reconciliation'; end if;
  end if;
  select * into original from public.server_payment_intent_operations_v1 where attempt_id=s.attempt_id;
  -- A missing or unbound response is not evidence of an absent provider intent.
  if not found or original.bound_at is null then return null; end if;
  if original.contract->>'attemptId' is distinct from s.attempt_id::text or original.contract->>'kind' is distinct from s.kind or
    original.contract->>'buyerId' is distinct from p_buyer_id::text or original.contract->'context' is distinct from p_context or
    exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=original.payment_intent_id) then
    raise exception 'Original monthly payment requires financial reconciliation'; end if;
  return to_jsonb(original);
end $$;
revoke all on function public.read_server_payment_cancellation_source_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_server_payment_cancellation_source_v1(uuid,uuid,jsonb) to service_role;
commit;
