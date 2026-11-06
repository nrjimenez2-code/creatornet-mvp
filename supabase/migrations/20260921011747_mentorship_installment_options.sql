-- Prepared locally; not applied to a hosted database.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.valid_mentorship_installment_options_v1(value smallint[])
returns boolean language sql immutable security invoker set search_path = pg_catalog as $$
  select coalesce(value is not null and cardinality(value) <= 23 and
    coalesce(array_ndims(value), 1) = 1 and array_position(value, null) is null and
    value = array(select distinct n from unnest(value) n order by n) and
    not exists(select 1 from unnest(value) n where n < 2 or n > 24), false)
$$;
-- This pure validator reads no tables and confers no data access.
revoke all on function public.valid_mentorship_installment_options_v1(smallint[]) from public;
grant execute on function public.valid_mentorship_installment_options_v1(smallint[]) to anon, authenticated, service_role;

alter table public.products add column installment_options smallint[] not null default '{}';
alter table public.products add constraint products_mentorship_installment_options_valid
  check (public.valid_mentorship_installment_options_v1(installment_options));
alter table public.products add constraint products_mentorship_installment_offer_valid
  check (cardinality(installment_options) = 0 or (
    type::text = 'mentorship' and membership_terms is null and
    coalesce(amount_cents, price_cents, 0) between 100 and 99999999 and
    coalesce(amount_cents, price_cents, 0) >= installment_options[cardinality(installment_options)]::integer * 50
  ));
comment on column public.products.installment_options is
  'Creator-approved fixed-total monthly payment counts; empty means no buyer-selected installments. Does not change service duration or existing agreements.';
commit;
