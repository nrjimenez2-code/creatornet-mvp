-- UNAPPLIED. #4 monthly service offer identity. Existing products/agreements
-- remain one-time/fixed-total; plan_months is NOT converted into membership.
-- This alone provides no subscription, Checkout, collection or access authority.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regclass('public.products') is null or to_regclass('public.product_checkout_attempts') is null or
    exists(select 1 from pg_attribute where attrelid='public.products'::regclass and attname='membership_terms' and not attisdropped) then
    raise exception 'Monthly offer prerequisites differ'; end if;
end;
$preflight$;
alter table public.products add column membership_terms jsonb;
create function public.valid_monthly_mentorship_terms_v1(p_type text,p_terms jsonb)
returns boolean language sql immutable set search_path=pg_catalog as $$
  select p_terms is null or coalesce(p_type='mentorship' and jsonb_typeof(p_terms)='object' and
    p_terms->>'version'='monthly-mentorship-v1' and
    jsonb_typeof(p_terms->'minimumMonths')='number' and (p_terms->>'minimumMonths') ~ '^([1-9]|1[0-9]|2[0-4])$' and
    jsonb_typeof(p_terms->'autoRenew')='boolean' and
    p_terms - array['version','minimumMonths','autoRenew']='{}'::jsonb, false);
$$;
alter table public.products add constraint products_monthly_mentorship_terms_v1 check (
  public.valid_monthly_mentorship_terms_v1(type,membership_terms));
create function public.guard_monthly_mentorship_offer_v1()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' and old.membership_terms is distinct from new.membership_terms then
    raise exception 'Create a new offer to change monthly service terms; existing offers are not reinterpreted'; end if;
  if new.membership_terms is not null and (new.price_cents is null or new.price_cents<50 or new.price_cents>99999999 or
    new.amount_cents is distinct from new.price_cents or lower(new.currency)<>'usd' or new.plan_months is distinct from 1) then
    raise exception 'Monthly offer requires one consistent USD monthly price, not an installment plan'; end if;
  return new;
end;
$$;
create trigger guard_monthly_mentorship_offer_v1 before insert or update on public.products
for each row execute function public.guard_monthly_mentorship_offer_v1();

-- Old code must never charge the monthly amount as a lifetime/full-price order,
-- even if its application flags have not yet been installed. The later owned
-- membership checkout integration will use a separate typed admission, not a
-- boolean bypass or relabelled v1 product Checkout.
create function public.guard_monthly_product_checkout_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if exists(select 1 from public.products p where p.id=new.product_id and p.membership_terms is not null) then
    raise exception 'Monthly mentorship requires its owned membership Checkout'; end if;
  return new;
end;
$$;
create trigger guard_monthly_product_checkout_v1 before insert or update on public.product_checkout_attempts
for each row execute function public.guard_monthly_product_checkout_v1();

-- No old agreement can be newly reserved against a monthly membership product.
-- Existing stored terms, receipts and ledgers remain unchanged.
create function public.guard_monthly_fixed_agreement_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if exists(select 1 from public.products p where p.id::text=new.terms->>'productId' and p.membership_terms is not null) then
    raise exception 'Monthly mentorship is not a fixed-total installment purchase'; end if;
  return new;
end;
$$;
create trigger guard_monthly_fixed_agreement_v1 before insert on public.exact_installment_agreements
for each row execute function public.guard_monthly_fixed_agreement_v1();
create trigger guard_monthly_fixed_reservation_v1 before insert on public.exact_installment_context_reservations_v2
for each row execute function public.guard_monthly_fixed_agreement_v1();
revoke all on function public.guard_monthly_mentorship_offer_v1(),public.guard_monthly_product_checkout_v1(),
  public.guard_monthly_fixed_agreement_v1() from public,anon,authenticated,service_role;
commit;
