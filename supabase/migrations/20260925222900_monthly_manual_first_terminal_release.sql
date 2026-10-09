begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

-- Reuse the original monthly subscription/invoice close-out and atomic
-- agreement retirement only after the original manual intent is terminal.
-- This migration does not itself cancel a provider resource or release money.
do $preflight$ begin
  if current_user<>'postgres' or
    to_regprocedure('public.record_monthly_manual_first_receipt_v1(uuid,uuid,jsonb,uuid,uuid,jsonb)') is null or
    to_regprocedure('public.complete_monthly_initial_abandonment_v1(uuid,uuid,jsonb,jsonb)') is null or
    to_regprocedure('public.monthly_manual_first_terminal_v1(uuid)') is not null then
    raise exception 'Monthly manual terminal release prerequisites differ'; end if;
end $preflight$;

-- This is a read under the caller's already-held agreement lock. The shared
-- cancellation writer created the immutable proof after inspecting the bound
-- intent and every charge page; the original journal and stop must still join.
create function public.monthly_manual_first_terminal_v1(p_id uuid) returns jsonb
language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
  m public.monthly_manual_payment_selections_v1%rowtype;
  s public.server_payment_protocols_v1%rowtype;
  i public.server_payment_intent_operations_v1%rowtype;
  t public.server_payment_intent_terminal_v1%rowtype;
  customer_id text; subscription_id text;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id;
  select * into m from public.monthly_manual_payment_selections_v1 where agreement_id=p_id and kind='first';
  if a.id is null or m.id is null or m.buyer_id is distinct from a.buyer_id or
    m.context is distinct from a.terms->'paymentContext' then return null; end if;
  select * into s from public.server_payment_protocols_v1 where attempt_id=m.id;
  select * into i from public.server_payment_intent_operations_v1 where attempt_id=m.id;
  select * into t from public.server_payment_intent_terminal_v1 where attempt_id=m.id;
  select provider_id into customer_id from public.monthly_mentorship_operations_v1
    where agreement_id=p_id and kind='customer' and scope_key='initial' and status='complete';
  select provider_id into subscription_id from public.monthly_mentorship_operations_v1
    where agreement_id=p_id and kind='subscription' and scope_key='initial' and status='complete';
  if s.attempt_id is null or s.kind is distinct from 'monthly_first' or s.reservation_id is not null or
    s.buyer_id is distinct from a.buyer_id or s.product_id is distinct from a.product_id or
    s.context is distinct from jsonb_build_object('version','exact-payment-context-v1',
      'mode',m.context->>'mode','platformAccountId',m.context->>'stripeAccountId',
      'supabaseProjectRef',m.context->>'supabaseProjectRef','siteOrigin',m.context->>'siteOrigin') or
    s.source is distinct from to_jsonb(m) or
    i.attempt_id is null or i.bound_at is null or i.payment_intent_id is null or
    i.contract->>'attemptId' is distinct from m.id::text or i.contract->>'buyerId' is distinct from a.buyer_id::text or
    i.contract->>'kind' is distinct from 'monthly_first' or i.contract->'context' is distinct from s.context or
    i.contract->>'termsFingerprint' is distinct from a.fingerprint or
    i.contract->>'customerId' is distinct from customer_id or
    i.contract#>>'{sourceMetadata,membership_subscription_id}' is distinct from subscription_id or
    customer_id is null or subscription_id is null or
    not exists(select 1 from public.server_payment_stops_v1 where attempt_id=m.id) or
    t.attempt_id is null or t.proof->>'version' is distinct from 'server-payment-intent-terminal-v1' or
    t.proof->>'paymentIntentId' is distinct from i.payment_intent_id or
    t.proof->>'status' is distinct from 'canceled' or
    t.proof->'amountReceived' is distinct from '0'::jsonb or
    t.proof->'amountCapturable' is distinct from '0'::jsonb or
    exists(select 1 from public.monthly_mentorship_receipts_v1 where agreement_id=p_id) or
    exists(select 1 from public.payment_fee_ledger where purchase_id=a.purchase_id or stripe_payment_intent_id=i.payment_intent_id)
    then return null; end if;
  return jsonb_build_object('attemptId',m.id,'paymentIntentId',i.payment_intent_id,
    'customerId',customer_id,'subscriptionId',subscription_id,'terminalProof',t.proof);
end $$;
revoke all on function public.monthly_manual_first_terminal_v1(uuid) from public,anon,authenticated,service_role;

-- A selection can be stopped before the shared journal is registered. SQL
-- proves there is no original payment operation; provider bootstrap still
-- needs its own complete close-out and customer-list evidence below.
create function public.monthly_manual_first_unregistered_v1(p_id uuid) returns boolean
language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
  m public.monthly_manual_payment_selections_v1%rowtype;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id;
  select * into m from public.monthly_manual_payment_selections_v1 where agreement_id=p_id and kind='first';
  return coalesce(a.id is not null and m.id is not null and m.buyer_id=a.buyer_id and
    m.context=a.terms->'paymentContext' and m.source->>'agreementId'=a.id::text and
    m.source->>'purchaseId'=a.purchase_id::text and m.source->>'agreementFingerprint'=a.fingerprint and
    a.stripe_checkout_session_id is null and
    not exists(select 1 from public.server_payment_protocols_v1 where attempt_id=m.id) and
    not exists(select 1 from public.server_payment_intent_operations_v1 where attempt_id=m.id) and
    not exists(select 1 from public.server_payment_confirmations_v1 where attempt_id=m.id) and
    not exists(select 1 from public.server_payment_stops_v1 where attempt_id=m.id) and
    not exists(select 1 from public.server_payment_intent_cancellations_v1 where attempt_id=m.id) and
    not exists(select 1 from public.server_payment_intent_terminal_v1 where attempt_id=m.id) and
    not exists(select 1 from public.monthly_mentorship_receipts_v1 where agreement_id=p_id) and
    not exists(select 1 from public.payment_fee_ledger where purchase_id=a.purchase_id),false);
end $$;
revoke all on function public.monthly_manual_first_unregistered_v1(uuid) from public,anon,authenticated,service_role;

-- Hosted Checkout admission remains forbidden. The existing close-out journal
-- may now seal this original subscription and invoices after terminal proof.
create or replace function public.guard_monthly_manual_hosted_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare agreement uuid;
begin
  if tg_table_name='monthly_mentorship_operations_v1' then
    if new.kind<>'checkout' and (tg_op='INSERT' or old.kind<>'checkout') then return new; end if;
    agreement:=new.agreement_id;
  elsif tg_table_name='monthly_mentorship_initial_closures_v1' then
    agreement:=new.agreement_id;
  else raise exception 'Unexpected monthly manual guard target'; end if;
  perform 1 from public.monthly_mentorship_agreements_v1 where id=agreement for update;
  if exists(select 1 from public.monthly_manual_payment_selections_v1 where agreement_id=agreement and kind='first') then
    if tg_table_name='monthly_mentorship_initial_closures_v1' and
      (public.monthly_manual_first_terminal_v1(agreement) is not null or
        public.monthly_manual_first_unregistered_v1(agreement)) then return new; end if;
    raise exception 'Monthly manual selection requires its own confirmation and terminal recovery';
  end if;
  return new;
end $$;

-- The old agreement is retired only by the existing complete function, which
-- verifies all customer lists, zero-money invoices and the subscription close.
-- This guard adds the manual original to those checks and preserves history.
create or replace function public.guard_monthly_manual_agreement_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare terminal jsonb; original_id text; unregistered boolean;
  expected_customer text; expected_subscription text;
begin
  if not exists(select 1 from public.monthly_manual_payment_selections_v1 where agreement_id=old.id) then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then raise exception 'Original monthly manual agreement cannot be deleted'; end if;
  if new.id is distinct from old.id or new.purchase_id is distinct from old.purchase_id or
      new.buyer_id is distinct from old.buyer_id or new.creator_id is distinct from old.creator_id or
      new.product_id is distinct from old.product_id or new.post_id is distinct from old.post_id or
      new.terms is distinct from old.terms or new.fingerprint is distinct from old.fingerprint or
      new.monthly_price_cents is distinct from old.monthly_price_cents or new.minimum_months is distinct from old.minimum_months or
      new.auto_renew is distinct from old.auto_renew or new.accepted_at is distinct from old.accepted_at then
      raise exception 'Original monthly manual terms cannot change'; end if;
  if exists(select 1 from public.monthly_manual_payment_selections_v1 where agreement_id=old.id and kind='first') then
    if new.stripe_checkout_session_id is not null then
      raise exception 'Monthly manual first payment cannot use hosted publication'; end if;
    if new.initial_abandon_proof is distinct from old.initial_abandon_proof and
      new.initial_abandoned_at is not distinct from old.initial_abandoned_at then
      raise exception 'Monthly manual terminal proof cannot change outside retirement'; end if;
    if new.initial_abandoned_at is distinct from old.initial_abandoned_at then
      if old.initial_abandoned_at is not null or new.initial_abandoned_at is null or
        new.initial_abandon_requested_at is null or
        new.initial_abandon_proof->>'version' is distinct from 'monthly-initial-abandonment-proof-v1' or
        new.initial_abandon_proof->>'membershipId' is distinct from old.id::text or
        new.initial_abandon_proof->'paymentContext' is distinct from old.terms->'paymentContext' then
        raise exception 'Original monthly manual retirement differs'; end if;
      perform public.assert_monthly_initial_unpaid_v1(old.id);
      unregistered:=public.monthly_manual_first_unregistered_v1(old.id);
      if new.initial_abandon_proof->'neverPayable'='true'::jsonb then
        if not unregistered or
          exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=old.id
            and kind in ('subscription','hold','checkout','activate','collect')) or
          old.stripe_customer_id is not null or old.stripe_subscription_id is not null then
          raise exception 'Monthly manual provider work cannot be treated as unstarted'; end if;
        select provider_id into expected_customer from public.monthly_mentorship_operations_v1
          where agreement_id=old.id and kind='customer' and scope_key='initial' and status='complete';
        if expected_customer is null then
          if exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=old.id) or
            new.initial_abandon_proof ? 'customerOnly' then
            raise exception 'Original monthly customer needs financial-list reconciliation'; end if;
        elsif expected_customer !~ '^cus_[A-Za-z0-9]+$' or
          new.initial_abandon_proof->'customerOnly' is distinct from 'true'::jsonb or
          new.initial_abandon_proof->>'customerId' is distinct from expected_customer or
          new.initial_abandon_proof->'listsComplete' is distinct from 'true'::jsonb or
          new.initial_abandon_proof->>'pendingInvoiceItemCount' is distinct from '0' or
          jsonb_typeof(new.initial_abandon_proof->'readRequestIds') is distinct from 'array' or
          jsonb_array_length(new.initial_abandon_proof->'readRequestIds')<>6 or
          exists(select 1 from jsonb_array_elements_text(new.initial_abandon_proof->'readRequestIds') r
            where not coalesce(r ~ '^req_[A-Za-z0-9]+$',false)) or
          new.initial_abandon_proof->'paymentIntents' is distinct from '[]'::jsonb or
          new.initial_abandon_proof->'charges' is distinct from '[]'::jsonb or
          new.initial_abandon_proof->'invoices' is distinct from '[]'::jsonb or
          new.initial_abandon_proof->'subscriptions' is distinct from '[]'::jsonb or
          new.initial_abandon_proof->'checkouts' is distinct from '[]'::jsonb then
          raise exception 'Original monthly customer financial lists are not empty'; end if;
      else
        terminal:=public.monthly_manual_first_terminal_v1(old.id);
        original_id:=terminal->>'paymentIntentId';
        expected_customer:=terminal->>'customerId'; expected_subscription:=terminal->>'subscriptionId';
        if unregistered then
          select provider_id into expected_customer from public.monthly_mentorship_operations_v1
            where agreement_id=old.id and kind='customer' and scope_key='initial' and status='complete';
          select resource_id into expected_subscription from public.monthly_mentorship_initial_closures_v1
            where agreement_id=old.id and kind='cancel_subscription' and status='complete';
        end if;
        if (terminal is null and not unregistered) or
          expected_customer is null or expected_subscription is null or
          new.initial_abandon_proof->'neverPayable' is distinct from 'false'::jsonb or
          new.initial_abandon_proof->>'checkoutSessionId' is not null or
          new.initial_abandon_proof->>'customerId' is distinct from expected_customer or
          new.initial_abandon_proof->>'subscriptionId' is distinct from expected_subscription or
          new.initial_abandon_proof->'listsComplete' is distinct from 'true'::jsonb or
          new.initial_abandon_proof->>'pendingInvoiceItemCount' is distinct from '0' or
          jsonb_typeof(new.initial_abandon_proof->'readRequestIds') is distinct from 'array' or
          jsonb_array_length(new.initial_abandon_proof->'readRequestIds')<>6 or
          jsonb_typeof(new.initial_abandon_proof->'paymentIntents') is distinct from 'array' or
          jsonb_typeof(new.initial_abandon_proof->'charges') is distinct from 'array' or
          jsonb_typeof(new.initial_abandon_proof->'invoices') is distinct from 'array' or
          jsonb_typeof(new.initial_abandon_proof->'subscriptions') is distinct from 'array' or
          jsonb_typeof(new.initial_abandon_proof->'checkouts') is distinct from 'array' or
          not exists(select 1 from public.monthly_mentorship_initial_closures_v1
            where agreement_id=old.id and kind='cancel_subscription' and resource_id=expected_subscription and status='complete') or
          exists(select 1 from public.monthly_mentorship_initial_closures_v1 where agreement_id=old.id and status<>'complete') or
          (not unregistered and not exists(select 1 from jsonb_array_elements(new.initial_abandon_proof->'paymentIntents') p
            where p->>'id'=original_id and p->>'status'='canceled' and
              p->>'amountReceivedCents'='0' and p->>'amountCapturableCents'='0')) or
          exists(select 1 from jsonb_array_elements(new.initial_abandon_proof->'paymentIntents') p
            where p->>'status' is distinct from 'canceled' or p->>'amountReceivedCents' is distinct from '0' or
              p->>'amountCapturableCents' is distinct from '0') or
          exists(select 1 from jsonb_array_elements(new.initial_abandon_proof->'charges') c
            where c->'paid' is distinct from 'false'::jsonb or c->>'amountCapturedCents' is distinct from '0') or
          exists(select 1 from jsonb_array_elements(new.initial_abandon_proof->'invoices') i
            where i->>'amountPaidCents' is distinct from '0' or
              not coalesce(i->>'status'='void' or (i->>'status'='paid' and i->>'totalCents'='0') or
                (i->>'status'='draft' and i->'autoAdvance'='false'::jsonb and i->'hostedInvoiceUrlNull'='true'::jsonb),false)) or
          exists(select 1 from jsonb_array_elements(new.initial_abandon_proof->'subscriptions') s
            where s->>'status' is distinct from 'canceled') or
          not exists(select 1 from jsonb_array_elements(new.initial_abandon_proof->'subscriptions') s
            where s->>'id'=expected_subscription) or
          exists(select 1 from jsonb_array_elements(new.initial_abandon_proof->'checkouts') c
            where c->>'status' is distinct from 'expired' or c->>'paymentStatus' is distinct from 'unpaid') then
          raise exception 'Original monthly manual terminal release proof differs'; end if;
      end if;
    end if;
  end if;
  return new;
end $$;
commit;
