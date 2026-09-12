-- UNAPPLIED. #2/#3: read-only persisted event routing before/after first credit.
-- A metadata hint can quarantine an event; it cannot bind a provider identity,
-- acknowledge delivery, create a purchase or grant access.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.run_exact_context_admin_refund_v2(uuid,uuid,jsonb,uuid,text,jsonb)') is null then
    raise exception 'Context event routing prerequisites differ'; end if;
end;
$preflight$;
create function public.resolve_exact_context_event_v2(p_kind text,p_provider_id text,p_hint uuid default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare target uuid; r public.exact_installment_context_reservations_v2%rowtype; session_id text; subscription_id text;
  customer_id text; first_intent text; invoice_id text; payment_number integer; credited boolean; a public.exact_installment_agreements%rowtype;
begin
  if p_kind is null or p_kind not in ('session','subscription','intent') or p_provider_id is null or length(p_provider_id)>200 or
    p_provider_id !~ (case p_kind when 'session' then '^cs_[A-Za-z0-9_]+$' when 'subscription' then '^sub_[A-Za-z0-9_]+$' else '^pi_[A-Za-z0-9_]+$' end) then
    raise exception 'Invalid context event locator'; end if;
  if p_kind='session' then
    select attempt.reservation_id into target from public.exact_context_checkout_results_v2 result
      join public.exact_context_checkout_attempts_v2 attempt on attempt.id=result.attempt_id where result.session_id=p_provider_id;
  elsif p_kind='subscription' then
    select step.reservation_id into target from public.exact_context_held_results_v2 result
      join public.exact_context_held_steps_v2 step on step.id=result.step_id where result.provider_id=p_provider_id and step.stage='subscription';
  else
    select receipt.reservation_id into target from public.exact_context_first_receipts_v2 receipt where receipt.payment_intent_id=p_provider_id;
    if target is null then
      select link.reservation_id,receipt.stripe_invoice_id,receipt.payment_number into target,invoice_id,payment_number
        from public.exact_installment_receipts receipt join public.exact_context_accounting_links_v2 link on link.agreement_id=receipt.agreement_id
        where receipt.stripe_payment_intent_id=p_provider_id;
    end if;
    if target is null then
      select link.reservation_id,claim.stripe_invoice_id,claim.payment_number into target,invoice_id,payment_number
        from public.exact_installment_invoice_claims claim join public.exact_context_accounting_links_v2 link on link.agreement_id=claim.agreement_id
        where claim.stripe_payment_intent_id=p_provider_id;
    end if;
  end if;
  if target is not null and p_hint is not null and target<>p_hint then raise exception 'Context event hint conflicts with persisted identity'; end if;
  target:=coalesce(target,p_hint);
  if target is null then return null; end if;
  select * into r from public.exact_installment_context_reservations_v2 where id=target;
  if not found then raise exception 'Context event reservation not yet available'; end if;
  select bound.session_id into session_id from public.exact_context_checkout_results_v2 bound
    join public.exact_context_checkout_attempts_v2 attempt on attempt.id=bound.attempt_id where attempt.reservation_id=r.id;
  select bound.provider_id into subscription_id from public.exact_context_held_results_v2 bound
    join public.exact_context_held_steps_v2 step on step.id=bound.step_id where step.reservation_id=r.id and step.stage='subscription';
  select bound.customer_id into customer_id from public.exact_context_customer_bindings_v2 bound
    join public.exact_installment_context_customer_operations_v2 op on op.id=bound.operation_id where op.reservation_id=r.id;
  select receipt.payment_intent_id into first_intent from public.exact_context_first_receipts_v2 receipt where receipt.reservation_id=r.id;
  select ag.* into a from public.exact_installment_agreements ag join public.exact_context_accounting_links_v2 link on link.agreement_id=ag.id
    and link.booking_payment_id=ag.booking_payment_id where link.reservation_id=r.id;
  credited:=a.id is not null and a.first_fulfilled_at is not null and exists(select 1 from public.exact_installment_receipts receipt
    join public.payment_fee_ledger ledger on ledger.id=receipt.ledger_id where receipt.agreement_id=a.id and receipt.payment_number=1
    and receipt.counted_at is not null and ledger.earnings_credited_at is not null and receipt.stripe_payment_intent_id=first_intent);
  if a.id is not null and (a.id<>r.id or a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',a.booking_payment_id) or
    a.stripe_checkout_session_id is distinct from session_id or a.stripe_subscription_id is distinct from subscription_id or a.stripe_customer_id is distinct from customer_id) then
    raise exception 'Context event accounting binding differs'; end if;
  if p_kind='intent' and first_intent=p_provider_id then payment_number:=1; end if;
  return jsonb_build_object('reservationId',r.id,'creatorId',r.terms->>'creatorId','buyerId',r.terms->>'buyerId','context',r.context,
    'sessionId',session_id,'subscriptionId',subscription_id,'customerId',customer_id,'firstIntentId',first_intent,
    'firstCredited',credited,'paymentNumber',payment_number,'invoiceId',invoice_id);
end;
$$;
revoke all on function public.resolve_exact_context_event_v2(text,text,uuid) from public,anon,authenticated;
grant execute on function public.resolve_exact_context_event_v2(text,text,uuid) to service_role;
commit;
