-- UNAPPLIED. Connect a new context receipt to EXISTING 040/041/044 accounting
-- and delivery. No historical agreement adoption, balance rewrite, Stripe call,
-- Checkout publication, subscription activation or later collection.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Context first credit requires reviewed owner and READ COMMITTED'; end if;
  if to_regprocedure('public.record_exact_context_first_receipt_v2(uuid,uuid,jsonb,jsonb)') is null or
    to_regprocedure('public.seed_exact_installment_purchase(uuid)') is null or
    to_regprocedure('public.credit_exact_installment_receipt(uuid,integer,text,text,bigint)') is null or
    to_regprocedure('public.fulfill_exact_installment_first_payment(uuid)') is null or
    to_regprocedure('public.reconcile_exact_installment_dispute_audit(text)') is null then
    raise exception 'Context first credit requires reviewed 040-062 prerequisites'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      and c.relname like 'exact_context_accounting_links_v2%') or
    exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
      p.proname in ('guard_context_accounting_payment_v2','credit_exact_context_first_payment_v2')) then
    raise exception 'Context accounting collision; no adoption'; end if;
end;
$preflight$;

-- Only identity correspondence, not a second ledger. Deferred FKs let the
-- private transaction reserve exact new IDs before the fenced payment INSERT.
create table public.exact_context_accounting_links_v2 (
  reservation_id uuid primary key references public.exact_context_first_receipts_v2(reservation_id) on delete restrict,
  agreement_id uuid not null unique references public.exact_installment_agreements(id) deferrable initially deferred,
  booking_payment_id uuid not null unique references public.booking_payments(id) deferrable initially deferred,
  created_at timestamptz not null default clock_timestamp(),
  check(agreement_id=reservation_id)
);
alter table public.exact_context_accounting_links_v2 enable row level security;
revoke all on public.exact_context_accounting_links_v2 from public,anon,authenticated,service_role;
create trigger context_accounting_link_immutable before update or delete on public.exact_context_accounting_links_v2
  for each row execute function public.guard_exact_context_immutable_v2();
create trigger context_accounting_link_no_truncate before truncate on public.exact_context_accounting_links_v2
  for each statement execute function public.guard_exact_context_immutable_v2();

alter table public.booking_payments drop constraint booking_payments_installment_collection_version_check;
alter table public.booking_payments add constraint booking_payments_installment_collection_version_check
  check(installment_collection_version is null or installment_collection_version in ('exact-cents-held-v1','exact-cents-context-v2'));

-- Preserve 058's reciprocal booking fence. The sole new admission is a private
-- durable link to an already verified context receipt; no session flag or
-- caller-provided "bypass" can insert another payment for the reserved booking.
create or replace function public.guard_legacy_payment_context_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype;
begin
  if tg_op='UPDATE' and new.booking_id is not distinct from old.booking_id then return new; end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'Cross-protocol payment admission requires READ COMMITTED'; end if;
  perform 1 from public.bookings where id=new.booking_id for update;
  select * into r from public.exact_installment_context_reservations_v2 where booking_id=new.booking_id;
  if found and (tg_op='INSERT' and new.installment_collection_version='exact-cents-context-v2' and
    exists(select 1 from public.exact_context_accounting_links_v2 where reservation_id=r.id and booking_payment_id=new.id)) is not true then
    raise exception 'Booking is reserved by the non-issuable context protocol'; end if;
  return new;
end;
$$;

-- Exact v2 economics/identities are derived from its immutable receipt and
-- reservation. Existing v1 behavior is untouched. Context payment links remain
-- unpublished even if an old publication RPC is called with a known identity.
create function public.guard_context_accounting_payment_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype;
  receipt public.exact_context_first_receipts_v2%rowtype; sub_id text; platform bigint;
begin
  if tg_op='UPDATE' and old.installment_collection_version='exact-cents-context-v2' and
    new.installment_collection_version is distinct from old.installment_collection_version then
    raise exception 'Context accounting marker is immutable'; end if;
  if new.installment_collection_version is distinct from 'exact-cents-context-v2' then return new; end if;
  select res.* into r from public.exact_context_accounting_links_v2 link
    join public.exact_installment_context_reservations_v2 res on res.id=link.reservation_id where link.booking_payment_id=new.id;
  if not found then raise exception 'Private context accounting link required'; end if;
  select * into receipt from public.exact_context_first_receipts_v2 where reservation_id=r.id;
  select binding.provider_id into sub_id from public.exact_context_held_results_v2 binding
    join public.exact_context_held_steps_v2 attempt on attempt.id=binding.step_id
    where attempt.reservation_id=r.id and attempt.stage='subscription';
  platform:=round(receipt.amount_cents::numeric*1200/10000)::bigint;
  if receipt.reservation_id is null or sub_id is null or new.booking_id is distinct from r.booking_id or
    new.buyer_id::text is distinct from r.terms->>'buyerId' or new.product_id::text is distinct from r.terms->>'productId' or
    new.closer_user_id::text is distinct from r.terms->>'creatorId' or new.plan_type::text is distinct from 'installment' or
    new.currency is distinct from 'usd' or new.amount_total_cents is distinct from (r.terms->>'totalCents')::bigint or
    new.installment_months is distinct from (r.terms->>'paymentCount')::integer or
    new.installment_amount_cents is distinct from receipt.amount_cents or new.platform_fee_cents is distinct from platform or
    new.processing_fee_cents is distinct from receipt.application_fee_cents-platform or
    new.total_creator_deduction_cents is distinct from receipt.application_fee_cents or
    new.creator_net_cents is distinct from receipt.amount_cents-receipt.application_fee_cents or
    new.fee_schedule_version is distinct from r.terms#>>'{firstPaymentFeeSchedule,version}' or
    (new.stripe_checkout_session_id is not null and new.stripe_checkout_session_id is distinct from receipt.session_id) or
    (new.stripe_subscription_id is not null and new.stripe_subscription_id is distinct from sub_id) or
    (new.stripe_payment_intent_id is not null and new.stripe_payment_intent_id is distinct from receipt.payment_intent_id) or
    new.link_url is not null then raise exception 'Context accounting payment differs or publication attempted'; end if;
  return new;
end;
$$;
create trigger context_accounting_payment_v2 before insert or update on public.booking_payments
  for each row execute function public.guard_context_accounting_payment_v2();

-- One transaction: new correspondence -> existing purchase seeding -> verified
-- receipt -> existing cumulative refund/accounting/dispute/delivery functions.
-- Any failed delivery or conflicting evidence rolls ALL financial effects back.
-- Exact-repeat consumption never resets an existing purchase or credits twice.
create function public.credit_exact_context_first_payment_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype;
  receipt public.exact_context_first_receipts_v2%rowtype; link public.exact_context_accounting_links_v2%rowtype;
  a public.exact_installment_agreements%rowtype; b public.bookings%rowtype;
  op public.exact_installment_context_customer_operations_v2%rowtype;
  customer_id text; sub_id text; payment_id uuid; purchase_id uuid; ledger_id uuid; platform bigint; credited boolean;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Context credit requires READ COMMITTED'; end if;
  select * into op from public.read_exact_customer_operation_v2(p_reservation_id,p_actor_id,p_context);
  -- Compare the exact nine fresh server-verified fields to saved evidence.
  perform public.record_exact_context_first_receipt_v2(p_reservation_id,p_actor_id,p_context,p_receipt);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into receipt from public.exact_context_first_receipts_v2 where reservation_id=r.id;
  select binding.customer_id into customer_id from public.exact_context_customer_bindings_v2 binding where binding.operation_id=op.id;
  select binding.provider_id into sub_id from public.exact_context_held_results_v2 binding
    join public.exact_context_held_steps_v2 attempt on attempt.id=binding.step_id
    where attempt.reservation_id=r.id and attempt.stage='subscription';
  if customer_id is null or sub_id is null then raise exception 'Context provider bindings missing'; end if;
  select * into link from public.exact_context_accounting_links_v2 where reservation_id=r.id;
  if found then
    select * into a from public.exact_installment_agreements where id=link.agreement_id for update;
  else
    -- New admission shares 058's booking lock. A competing committed bridge is
    -- reconciled on a new call, never by acquiring the reversed existing lock.
    select * into b from public.bookings where id=r.booking_id for update;
    if not found or b.status is distinct from 'booked' or b.creator_id is distinct from p_actor_id or
      b.buyer_id::text is distinct from r.terms->>'buyerId' or b.post_id::text is distinct from r.terms->>'postId' then
      raise exception 'Context credit booking changed'; end if;
    if exists(select 1 from public.exact_context_accounting_links_v2 where reservation_id=r.id) then
      raise exception 'Context accounting changed; reconcile existing link'; end if;
    if exists(select 1 from public.booking_payments where booking_id=r.booking_id) or
      exists(select 1 from public.exact_installment_agreements where id=r.id or terms->>'bookingId'=r.booking_id::text) or
      exists(select 1 from public.exact_installment_receipts where stripe_payment_intent_id=receipt.payment_intent_id) or
      exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=receipt.payment_intent_id) or
      exists(select 1 from public.purchases where buyer_id=b.buyer_id and
        (post_id=b.post_id or product_id=(r.terms->>'productId')::uuid)) then
      raise exception 'Existing financial evidence cannot be adopted by context credit'; end if;
    payment_id:=gen_random_uuid(); platform:=round(receipt.amount_cents::numeric*1200/10000)::bigint;
    insert into public.exact_context_accounting_links_v2(reservation_id,agreement_id,booking_payment_id) values(r.id,r.id,payment_id);
    insert into public.booking_payments(id,booking_id,product_id,buyer_id,closer_user_id,plan_type,status,currency,
      installment_months,amount_total_cents,installment_amount_cents,platform_fee_cents,processing_fee_cents,
      total_creator_deduction_cents,creator_net_cents,fee_schedule_version,installment_collection_version)
      values(payment_id,r.booking_id,(r.terms->>'productId')::uuid,(r.terms->>'buyerId')::uuid,p_actor_id,'installment','pending','usd',
        (r.terms->>'paymentCount')::integer,(r.terms->>'totalCents')::bigint,receipt.amount_cents,platform,receipt.application_fee_cents-platform,
        receipt.application_fee_cents,receipt.amount_cents-receipt.application_fee_cents,r.terms#>>'{firstPaymentFeeSchedule,version}','exact-cents-context-v2');
    -- Keep the real v2 version; never fabricate v1 terms or a Preview origin.
    insert into public.exact_installment_agreements(id,booking_payment_id,terms,status,stripe_customer_id,stripe_subscription_id,
      stripe_checkout_session_id,created_at)
      values(r.id,payment_id,r.terms||jsonb_build_object('bookingPaymentId',payment_id),'awaiting_first',customer_id,sub_id,receipt.session_id,r.created_at)
      returning * into a;
    purchase_id:=public.seed_exact_installment_purchase(a.id);
    perform public.record_exact_installment_first_receipt(a.id,receipt.session_id,receipt.payment_intent_id,receipt.amount_cents,
      receipt.application_fee_cents,to_timestamp(receipt.paid_at));
    select * into link from public.exact_context_accounting_links_v2 where reservation_id=r.id;
  end if;
  if a.id is null or a.id is distinct from r.id or a.booking_payment_id is distinct from link.booking_payment_id or
    a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',link.booking_payment_id) or
    a.stripe_checkout_session_id is distinct from receipt.session_id or
    a.stripe_customer_id is distinct from customer_id or a.stripe_subscription_id is distinct from sub_id or
    exists(select 1 from public.exact_installment_collection_holds where agreement_id=a.id) or
    not exists(select 1 from public.exact_installment_receipts where agreement_id=a.id and payment_number=1 and
      stripe_payment_intent_id=receipt.payment_intent_id and amount_cents=receipt.amount_cents and
      application_fee_cents=receipt.application_fee_cents and paid_at=to_timestamp(receipt.paid_at)) then
    raise exception 'Context accounting identity or collection hold requires review'; end if;
  -- Monotonic refund evidence is shared with the existing refund path. Never
  -- replace a positive observed refund with zero merely because a read was old.
  if public.record_payment_refund_state(receipt.payment_intent_id,receipt.charge_id,receipt.amount_cents,0)<>0 then
    raise exception 'Context payment has a refund; credit requires review'; end if;
  credited:=public.credit_exact_installment_receipt(a.id,1,receipt.charge_id,receipt.balance_transaction_id,receipt.actual_stripe_fee_cents);
  perform public.reconcile_exact_installment_dispute_audit(receipt.payment_intent_id);
  perform public.fulfill_exact_installment_first_payment(a.id);
  select ag.purchase_id into purchase_id from public.exact_installment_agreements ag where ag.id=a.id;
  select rec.ledger_id into ledger_id from public.exact_installment_receipts rec where rec.agreement_id=a.id and rec.payment_number=1;
  return jsonb_build_object('reservation_id',r.id,'agreement_id',a.id,'purchase_id',purchase_id,'ledger_id',ledger_id,
    'credited',credited,'first_payment_fulfilled',true);
end;
$$;
revoke all on function public.guard_context_accounting_payment_v2() from public,anon,authenticated,service_role;
revoke all on function public.guard_legacy_payment_context_v2() from public,anon,authenticated,service_role;
revoke all on function public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb) to service_role;
do $postflight$
begin
  if has_table_privilege('service_role','public.exact_context_accounting_links_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
    has_table_privilege('anon','public.exact_context_accounting_links_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
    has_table_privilege('authenticated','public.exact_context_accounting_links_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
    has_function_privilege('anon','public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb)','EXECUTE') or
    has_function_privilege('authenticated','public.credit_exact_context_first_payment_v2(uuid,uuid,jsonb,jsonb)','EXECUTE') then
    raise exception 'Context accounting permissions differ'; end if;
end;
$postflight$;
commit;
