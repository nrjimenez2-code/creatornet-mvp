-- UNAPPLIED. #6 versioned acceptance for the existing one-time product Checkout.
-- No payment, refund, entitlement, subscription, or historical agreement is changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or to_regclass('public.product_checkout_attempts') is null or
    to_regclass('public.product_purchase_consents_v1') is not null then
    raise exception 'Purchase consent prerequisites differ'; end if;
end;
$preflight$;
create table public.product_purchase_consents_v1 (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.profiles(id),
  creator_id uuid not null references public.profiles(id),
  product_id uuid not null references public.products(id),
  post_id uuid references public.posts(id),
  policy_version text not null check(policy_version='creatornet-purchase-2026-09-09-v1'),
  terms jsonb not null check(jsonb_typeof(terms)='object'),
  fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz not null default clock_timestamp(),
  unique(buyer_id,fingerprint)
);
alter table public.product_purchase_consents_v1 enable row level security;
revoke all on public.product_purchase_consents_v1 from public,anon,authenticated,service_role;
grant select on public.product_purchase_consents_v1 to service_role;

create function public.record_product_purchase_consent_v1(p_buyer_id uuid,p_creator_id uuid,p_product_id uuid,
  p_post_id uuid,p_terms jsonb,p_fingerprint text) returns uuid
language plpgsql security definer set search_path=pg_catalog as $$
declare p public.products%rowtype; v_id uuid; v_existing jsonb;
begin
  select * into p from public.products where id=p_product_id for share;
  if not found or p.creator_id<>p_creator_id or p_terms is null or jsonb_typeof(p_terms)<>'object' or
    p_terms->>'version' is distinct from 'creatornet-purchase-2026-09-09-v1' or
    p_terms->>'buyerId' is distinct from p_buyer_id::text or p_terms->>'creatorId' is distinct from p_creator_id::text or
    p_terms->>'productId' is distinct from p_product_id::text or p_terms->>'postId' is distinct from p_post_id::text or
    p_terms->>'currency' is distinct from 'usd' or lower(coalesce(p.currency,'usd'))<>'usd' or
    p_terms->>'amountCents' is distinct from coalesce(p.amount_cents,p.price_cents)::text or
    coalesce(p.amount_cents,p.price_cents,0)<50 or
    p_terms->>'title' is distinct from coalesce(nullif(p.title,''),'Purchase') or
    p_terms->>'description' is distinct from coalesce(p.description,'') or
    p_terms->>'kind' is distinct from (case when p.type='call' then 'paid_call' else 'one_time' end) or
    p_terms#>>'{policy,version}' is distinct from 'creatornet-purchase-2026-09-09-v1' then
    raise exception 'Purchase consent does not match the owned current offer'; end if;
  -- The optional monthly column may be absent when only this proposal is installed.
  if to_jsonb(p)->'membership_terms' is not null and to_jsonb(p)->'membership_terms'<>'null'::jsonb then
    raise exception 'A monthly service cannot use one-time purchase consent'; end if;
  if p_post_id is not null and not exists(select 1 from public.posts where id=p_post_id and creator_id=p_creator_id and product_id=p_product_id) then
    raise exception 'Post does not sell the consented offer'; end if;
  insert into public.product_purchase_consents_v1(buyer_id,creator_id,product_id,post_id,policy_version,terms,fingerprint)
    values(p_buyer_id,p_creator_id,p_product_id,p_post_id,'creatornet-purchase-2026-09-09-v1',p_terms,p_fingerprint)
    on conflict(buyer_id,fingerprint) do nothing returning id into v_id;
  if v_id is null then
    select id,terms into v_id,v_existing from public.product_purchase_consents_v1 where buyer_id=p_buyer_id and fingerprint=p_fingerprint;
    if v_id is null or v_existing is distinct from p_terms then raise exception 'Purchase consent replay differs'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.record_product_purchase_consent_v1(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.record_product_purchase_consent_v1(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

alter table public.product_checkout_attempts add column purchase_consent_id uuid references public.product_purchase_consents_v1(id);
create function public.guard_product_purchase_consent_v1() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if new.purchase_consent_id is not null and not exists(select 1 from public.product_purchase_consents_v1 c
    where c.id=new.purchase_consent_id and c.buyer_id=new.buyer_id and c.creator_id=new.creator_id and c.product_id=new.product_id and c.post_id is not distinct from new.post_id) then
    raise exception 'Checkout acceptance ownership differs'; end if;
  return new;
end;
$$;
create trigger guard_product_purchase_consent_v1 before insert or update on public.product_checkout_attempts
  for each row execute function public.guard_product_purchase_consent_v1();
revoke all on function public.guard_product_purchase_consent_v1() from public,anon,authenticated,service_role;
commit;
