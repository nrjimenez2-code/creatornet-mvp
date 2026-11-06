-- Unapplied candidate: durable buyer acceptance, no provider dispatch or credit.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if not exists(select 1 from pg_catalog.pg_trigger where
    tgrelid='public.product_checkout_attempts'::regclass and tgname='fixed_service_one_time_v1' and
    tgfoid='public.guard_fixed_service_one_time_v1()'::regprocedure and tgenabled='O' and not tgisinternal) then
    raise exception 'Existing fixed-service checkout guard must be installed and enabled';
  end if;
end $$;

create table public.buyer_mentorship_installment_reservations_v1 (
  id uuid primary key,
  request_id uuid not null unique,
  attempt_id uuid not null unique references public.product_checkout_attempts(id) on delete no action deferrable initially deferred,
  buyer_id uuid not null references public.profiles(id),
  creator_id uuid not null references public.profiles(id),
  product_id uuid not null references public.products(id),
  post_id uuid not null references public.posts(id),
  context jsonb not null references public.exact_installment_context_pin_v2(context) on delete restrict on update restrict,
  destination_id text not null check(destination_id ~ '^acct_[A-Za-z0-9]+$'),
  terms jsonb not null,
  terms_text text not null check(length(terms_text)<=100000),
  fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
  check(terms_text::jsonb=terms and encode(sha256(convert_to(terms_text,'UTF8')),'hex')=fingerprint),
  accepted_at timestamptz not null default clock_timestamp(),
  status text not null default 'reserved' check(status = 'reserved'),
  unique(buyer_id, product_id),
  check(buyer_id <> creator_id),
  check((terms->>'kind' = 'fixed_total_installments' and terms->>'installmentVersion' = 'buyer-mentorship-installments-v1'
    and terms->>'buyerId' = buyer_id::text and terms->>'productId' = product_id::text
    and terms->>'creatorId' = creator_id::text and terms->>'postId' = post_id::text) is true)
);
alter table public.buyer_mentorship_installment_reservations_v1 enable row level security;
revoke all on public.buyer_mentorship_installment_reservations_v1 from public, anon, authenticated, service_role;
grant select on public.buyer_mentorship_installment_reservations_v1 to service_role;

alter table public.product_checkout_attempts
  add column checkout_kind text not null default 'full' check(checkout_kind in ('full','installments')),
  add column buyer_installment_reservation_id uuid unique references public.buyer_mentorship_installment_reservations_v1(id)
    deferrable initially deferred,
  add constraint product_checkout_kind_binding check(
    (checkout_kind='full' and buyer_installment_reservation_id is null) or
    (checkout_kind='installments' and buyer_installment_reservation_id is not null));

create function public.guard_buyer_installment_checkout_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op <> 'INSERT' and old.checkout_kind='installments' then
    raise exception 'An accepted installment checkout cannot be rotated or deleted by the full-payment path';
  end if;
  if tg_op='DELETE' then return old; end if;
  if tg_op='UPDATE' and new.checkout_kind is distinct from old.checkout_kind then
    raise exception 'Checkout payment mode cannot change'; end if;
  -- Both payment modes use this lock, including direct legacy-route INSERTs.
  perform pg_advisory_xact_lock(hashtextextended(new.buyer_id::text || ':' || new.product_id::text, 72913));
  if new.checkout_kind='installments' and not exists(select 1 from public.buyer_mentorship_installment_reservations_v1 r
    where r.id=new.buyer_installment_reservation_id and r.attempt_id=new.id and r.buyer_id=new.buyer_id and
    r.creator_id=new.creator_id and r.product_id=new.product_id and r.post_id=new.post_id and r.fingerprint=new.terms_fingerprint) then
    raise exception 'Installment checkout needs its original buyer acceptance'; end if;
  if new.checkout_kind='full' and exists(select 1 from public.buyer_mentorship_installment_reservations_v1
    where buyer_id=new.buyer_id and product_id=new.product_id) then
    raise exception 'This offer already has an accepted installment checkout'; end if;
  return new;
end;
$$;
create trigger guard_buyer_installment_checkout_v1 before insert or update or delete on public.product_checkout_attempts
  for each row execute function public.guard_buyer_installment_checkout_v1();
revoke all on function public.guard_buyer_installment_checkout_v1() from public, anon, authenticated, service_role;

-- Preserve SQL097's full-payment guard. A buyer installment reservation has its
-- own accepted service snapshot and cannot masquerade as one-time consent.
create or replace function public.guard_fixed_service_one_time_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare c public.product_purchase_consents_v1%rowtype; months integer;
begin
  if new.checkout_kind='installments' then
    if not exists(select 1 from public.buyer_mentorship_installment_reservations_v1 r where
      r.id=new.buyer_installment_reservation_id and r.attempt_id=new.id and r.buyer_id=new.buyer_id and
      r.creator_id=new.creator_id and r.product_id=new.product_id and r.post_id=new.post_id and r.fingerprint=new.terms_fingerprint) then
      raise exception 'Installment service acceptance missing'; end if;
    return new;
  end if;
  if tg_op='UPDATE' and new.attempt_key=old.attempt_key then
    if new.purchase_consent_id is distinct from old.purchase_consent_id and exists(
      select 1 from public.product_purchase_consents_v1 where id=old.purchase_consent_id and terms ? 'serviceMonths') then
      raise exception 'Issued checkout consent is immutable'; end if;
    return new;
  end if;
  select fixed_service_months into months from public.products where id=new.product_id for share;
  select * into c from public.product_purchase_consents_v1 where id=new.purchase_consent_id;
  if months is not null and (c.id is null or c.terms->'serviceMonths' is distinct from to_jsonb(months) or
    c.terms->>'serviceVersion' is distinct from 'fixed-service-months-v1') then
    raise exception 'Timed checkout requires the current accepted service terms'; end if;
  if months is null and c.terms ? 'serviceMonths' then raise exception 'Service terms changed; review again'; end if;
  return new;
end $$;

create function public.reserve_buyer_mentorship_installments_v1(
  p_request_id uuid, p_buyer_id uuid, p_product_id uuid, p_post_id uuid,
  p_context jsonb, p_terms_text text, p_fingerprint text
) returns public.buyer_mentorship_installment_reservations_v1
language plpgsql security definer set search_path=pg_catalog as $$
declare
  p public.products%rowtype;
  profile public.profiles%rowtype;
  saved public.buyer_mentorship_installment_reservations_v1%rowtype;
  t jsonb;
  count_payments integer;
  total integer;
  reservation_id uuid := gen_random_uuid();
  attempt_id uuid := gen_random_uuid();
  i integer;
  expected integer;
begin
  -- Only the trusted server service role has EXECUTE. It must authenticate the
  -- buyer, check Origin and reconstruct the quote before invoking this function.
  if p_request_id is null or p_buyer_id is null or p_product_id is null or p_post_id is null or
    p_terms_text is null or length(p_terms_text)>100000 or p_fingerprint is null or
    encode(sha256(convert_to(p_terms_text,'UTF8')),'hex') is distinct from p_fingerprint or
    current_setting('transaction_isolation') <> 'read committed' then raise exception 'Invalid installment acceptance'; end if;
  if not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Installment payment context differs'; end if;
  t := p_terms_text::jsonb;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text || ':' || p_product_id::text, 72913));
  select * into saved from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id;
  if found then
    if saved.buyer_id is distinct from p_buyer_id or saved.product_id is distinct from p_product_id or
      saved.post_id is distinct from p_post_id or saved.context is distinct from p_context or
      saved.terms is distinct from t or saved.fingerprint is distinct from p_fingerprint then
      raise exception 'Original installment acceptance differs'; end if;
    return saved;
  end if;
  if exists(select 1 from public.buyer_mentorship_installment_reservations_v1 where buyer_id=p_buyer_id and product_id=p_product_id) or
    exists(select 1 from public.product_checkout_attempts where buyer_id=p_buyer_id and product_id=p_product_id) or
    exists(select 1 from public.purchases where buyer_id=p_buyer_id and (product_id=p_product_id or post_id=p_post_id)) then
    raise exception 'Existing purchase or checkout requires reconciliation'; end if;
  select * into p from public.products where id=p_product_id for share;
  if not found or p.active is false or p.type::text <> 'mentorship' or p.creator_id=p_buyer_id or p.membership_terms is not null then
    raise exception 'Fixed mentorship offer unavailable'; end if;
  perform 1 from public.posts where id=p_post_id and product_id=p.id and creator_id=p.creator_id for share;
  if not found then raise exception 'Post does not sell this offer'; end if;
  select * into profile from public.profiles where id=p.creator_id for share;
  if not found or profile.stripe_onboarding_complete is not true or profile.stripe_account_id !~ '^acct_[A-Za-z0-9]+$' or
    profile.stripe_account_id is null then raise exception 'Creator payment destination unavailable'; end if;
  total := coalesce(p.amount_cents,p.price_cents,0);
  count_payments := (t->>'paymentCount')::integer;
  if count_payments is null or not (count_payments=any(p.installment_options)) or total not between 100 and 99999999 or
    t->>'version' is distinct from 'creatornet-purchase-2026-09-09-v1' or
    t->>'kind' is distinct from 'fixed_total_installments' or
    t->>'installmentVersion' is distinct from 'buyer-mentorship-installments-v1' or
    t->>'fixedPurchaseConsentVersion' is distinct from 'fixed-total-purchase-consent-v1' or
    t->>'fixedPurchaseConsentText' is distinct from 'This is a fixed-price purchase, not a cancel-anytime membership. I agree to pay the full price on the schedule shown and authorize use of my saved card for those installments. Ending automatic debits or stopping use does not by itself erase the unpaid balance. The payment schedule does not set the service duration. Refund rights and rights provided by law still apply.' or
    t->>'buyerId' is distinct from p_buyer_id::text or t->>'creatorId' is distinct from p.creator_id::text or
    t->>'productId' is distinct from p.id::text or t->>'postId' is distinct from p_post_id::text or
    t->>'amountCents' is distinct from total::text or t->>'currency' is distinct from 'usd' or lower(coalesce(p.currency,'usd'))<>'usd' or
    t->>'title' is distinct from coalesce(nullif(p.title,''),'Purchase') or
    t->>'description' is distinct from coalesce(p.description,'') or
    t->>'serviceMonths' is distinct from p.fixed_service_months::text or
    (p.fixed_service_months is not null and (t->>'serviceVersion' is distinct from 'fixed-service-months-v1' or
      t->>'serviceDescription' is distinct from public.fixed_service_description_v1(p.fixed_service_months))) or
    t#>>'{policy,version}' is distinct from 'creatornet-purchase-2026-09-09-v1' or
    jsonb_typeof(t->'payments') is distinct from 'array' or jsonb_array_length(t->'payments') <> count_payments then
    raise exception 'Accepted terms no longer match the offer'; end if;
  for i in 1..count_payments loop
    expected := total/count_payments + case when i=count_payments then total%count_payments else 0 end;
    if expected<50 or t->'payments'->(i-1) is distinct from jsonb_build_object('number',i,'amountCents',expected) then
      raise exception 'Installment amounts differ'; end if;
  end loop;
  insert into public.buyer_mentorship_installment_reservations_v1(id,request_id,attempt_id,buyer_id,creator_id,product_id,post_id,
    context,destination_id,terms,terms_text,fingerprint)
    values(reservation_id,p_request_id,attempt_id,p_buyer_id,p.creator_id,p.id,p_post_id,p_context,profile.stripe_account_id,t,p_terms_text,p_fingerprint)
    returning * into saved;
  insert into public.product_checkout_attempts(id,buyer_id,purchase_identity,creator_id,product_id,post_id,
    attempt_key,order_id,terms_fingerprint,checkout_kind,buyer_installment_reservation_id)
    values(attempt_id,p_buyer_id,'post:'||p_post_id::text,p.creator_id,p.id,p_post_id,
      gen_random_uuid(),gen_random_uuid(),p_fingerprint,'installments',reservation_id);
  return saved;
end;
$$;
revoke all on function public.reserve_buyer_mentorship_installments_v1(uuid,uuid,uuid,uuid,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.reserve_buyer_mentorship_installments_v1(uuid,uuid,uuid,uuid,jsonb,text,text) to service_role;
commit;
