begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Exclusivity/provenance only. No intent, confirmation, receipt or entitlement
-- is created here. Historical full-payment attempts cannot be adopted because
-- a legacy unbound row may already have reached Stripe.
create table public.server_payment_protocols_v1 (
  attempt_id uuid primary key,
  buyer_id uuid not null,
  product_id uuid not null,
  context jsonb not null references public.exact_installment_context_pin_v2(context),
  kind text not null check(kind in ('full','first_installment')),
  reservation_id uuid unique references public.buyer_mentorship_installment_reservations_v1(id),
  source jsonb not null check(jsonb_typeof(source)='object'),
  protocol text not null default 'creatornet-us-manual-confirmation-v1' check(protocol='creatornet-us-manual-confirmation-v1'),
  created_at timestamptz not null default clock_timestamp(),
  check((kind='full' and reservation_id is null) or (kind='first_installment' and reservation_id is not null))
);
alter table public.server_payment_protocols_v1 enable row level security;
revoke all on public.server_payment_protocols_v1 from public,anon,authenticated,service_role;
grant select on public.server_payment_protocols_v1 to service_role;

create function public.reserve_full_server_payment_v1(p_attempt jsonb,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.product_checkout_attempts%rowtype; saved public.server_payment_protocols_v1%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' or p_buyer_id is null or
    jsonb_typeof(p_attempt) is distinct from 'object' or
    p_attempt-array['id','buyer_id','creator_id','product_id','post_id','purchase_identity','attempt_key','order_id','terms_fingerprint','purchase_consent_id']<>'{}'::jsonb or
    p_attempt->>'buyer_id' is distinct from p_buyer_id::text or
    not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Fresh owned server payment selection required'; end if;
  a:=jsonb_populate_record(null::public.product_checkout_attempts,p_attempt);
  if a.id is null or a.creator_id is null or a.product_id is null or a.attempt_key is null or a.order_id is null or
    a.purchase_consent_id is null or a.buyer_id=a.creator_id or a.terms_fingerprint !~ '^[a-f0-9]{64}$' or a.terms_fingerprint is null or
    a.purchase_identity is distinct from (case when a.post_id is null then 'product:'||a.product_id else 'post:'||a.post_id end) or
    not exists(select 1 from public.product_purchase_consents_v1 c where c.id=a.purchase_consent_id and
      c.terms->>'buyerId'=a.buyer_id::text and c.terms->>'creatorId'=a.creator_id::text and c.terms->>'productId'=a.product_id::text and
      c.terms->>'postId' is not distinct from a.post_id::text and c.terms->>'kind'='one_time') then
    raise exception 'Accepted full-payment selection differs'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.buyer_id::text||':'||a.product_id::text,72913));
  select * into saved from public.server_payment_protocols_v1 where attempt_id=a.id;
  if found then
    if saved.buyer_id is distinct from a.buyer_id or saved.context is distinct from p_context or saved.kind<>'full' or
      saved.source is distinct from p_attempt then raise exception 'Original server payment selection changed'; end if;
    return to_jsonb(saved);
  end if;
  if exists(select 1 from public.product_checkout_attempts where id=a.id or (buyer_id=a.buyer_id and product_id=a.product_id)) or
    exists(select 1 from public.purchases where buyer_id=a.buyer_id and (product_id=a.product_id or (a.post_id is not null and post_id=a.post_id))) then
    raise exception 'Existing checkout or purchase requires original recovery'; end if;
  insert into public.server_payment_protocols_v1(attempt_id,buyer_id,product_id,context,kind,source)
    values(a.id,a.buyer_id,a.product_id,p_context,'full',p_attempt) returning * into saved;
  -- Existing fixed-service, consent and installment-exclusivity triggers remain
  -- installed and execute normally. Failure rolls back the new pin atomically.
  insert into public.product_checkout_attempts(id,buyer_id,creator_id,product_id,post_id,purchase_identity,attempt_key,order_id,
    terms_fingerprint,purchase_consent_id,checkout_kind,status)
    values(a.id,a.buyer_id,a.creator_id,a.product_id,a.post_id,a.purchase_identity,a.attempt_key,a.order_id,
      a.terms_fingerprint,a.purchase_consent_id,'full','creating');
  return to_jsonb(saved);
end $$;
revoke all on function public.reserve_full_server_payment_v1(jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_full_server_payment_v1(jsonb,uuid,jsonb) to service_role;

create function public.pin_installment_server_payment_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  a public.product_checkout_attempts%rowtype; saved public.server_payment_protocols_v1%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Fresh installment payment selection required'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context;
  if not found then raise exception 'Owned installment selection unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=r.id;
  select * into saved from public.server_payment_protocols_v1 where attempt_id=r.attempt_id;
  if found then
    if saved.reservation_id is distinct from r.id or saved.buyer_id is distinct from p_buyer_id or saved.context is distinct from p_context or
      saved.kind<>'first_installment' then raise exception 'Original installment payment selection changed'; end if;
    return to_jsonb(saved);
  end if;
  select * into a from public.product_checkout_attempts where id=r.attempt_id and buyer_installment_reservation_id=r.id and
    buyer_id=r.buyer_id and product_id=r.product_id and checkout_kind='installments';
  if not found or r.status<>'reserved' or r.released_at is not null or a.stripe_checkout_session_id is not null or
    a.original_request is not null or a.original_request_protocol is not null or
    exists(select 1 from public.buyer_mentorship_bootstrap_operations_v1 where reservation_id=r.id and step='checkout.create') or
    exists(select 1 from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_activation_operations_v1 where reservation_id=r.id) or
    exists(select 1 from public.buyer_mentorship_abandonment_holds_v1 where reservation_id=r.id) or
    exists(select 1 from public.purchases where buyer_id=r.buyer_id and (product_id=r.product_id or post_id=r.post_id)) then
    raise exception 'Existing installment preparation requires original recovery'; end if;
  insert into public.server_payment_protocols_v1(attempt_id,buyer_id,product_id,context,kind,reservation_id,source)
    values(r.attempt_id,r.buyer_id,r.product_id,p_context,'first_installment',r.id,
      jsonb_build_object('reservation',to_jsonb(r),'attempt',to_jsonb(a))) returning * into saved;
  return to_jsonb(saved);
end $$;
revoke all on function public.pin_installment_server_payment_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.pin_installment_server_payment_v1(uuid,uuid,jsonb) to service_role;

-- A rollback of an application flag must not reopen the hosted path or rotate
-- away the original identity. Separate manual-payment stop/receipt adapters are
-- required before these pins can be published. No legacy release is authority
-- to abandon a potentially payable manual intent.
create function public.guard_server_payment_attempt_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare saved public.server_payment_protocols_v1%rowtype;
begin
  if tg_op='INSERT' then
    perform pg_advisory_xact_lock(hashtextextended(new.buyer_id::text||':'||new.product_id::text,72913));
    select * into saved from public.server_payment_protocols_v1 where attempt_id=new.id;
  else
    perform pg_advisory_xact_lock(hashtextextended(old.buyer_id::text||':'||old.product_id::text,72913));
    select * into saved from public.server_payment_protocols_v1 where attempt_id=old.id;
  end if;
  if not found then if tg_op='DELETE' then return old; else return new; end if; end if;
  if tg_op='DELETE' then raise exception 'Server payment requires its own terminal release proof'; end if;
  if tg_op='UPDATE' and (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') then
    raise exception 'Original server payment attempt cannot be rewritten'; end if;
  if new.buyer_id is distinct from saved.buyer_id or new.product_id is distinct from saved.product_id or
    new.original_request_protocol is not null or new.original_request is not null or new.stripe_checkout_session_id is not null or
    new.stripe_checkout_url is not null or new.status is distinct from 'creating' then
    raise exception 'Server payment cannot dispatch hosted Checkout'; end if;
  return new;
end $$;
create trigger guard_server_payment_attempt_v1 before insert or update or delete on public.product_checkout_attempts
  for each row execute function public.guard_server_payment_attempt_v1();

create function public.guard_server_payment_legacy_operation_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
begin
  if tg_table_name='buyer_mentorship_bootstrap_operations_v1' then
    if new.step<>'checkout.create' then return new; end if;
  end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1 where id=new.reservation_id;
  if not found then raise exception 'Owned server payment reservation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(r.buyer_id::text||':'||r.product_id::text,72913));
  if exists(select 1 from public.server_payment_protocols_v1 where attempt_id=r.attempt_id) then
    raise exception 'Server payment requires its own confirmation or terminal release proof'; end if;
  return new;
end $$;
create trigger guard_server_payment_legacy_operation_v1 before insert or update on public.buyer_mentorship_bootstrap_operations_v1
  for each row execute function public.guard_server_payment_legacy_operation_v1();
create trigger guard_server_payment_legacy_operation_v1 before insert on public.buyer_mentorship_abandonment_holds_v1
  for each row execute function public.guard_server_payment_legacy_operation_v1();
revoke all on function public.guard_server_payment_attempt_v1(),public.guard_server_payment_legacy_operation_v1() from public,anon,authenticated;
commit;
