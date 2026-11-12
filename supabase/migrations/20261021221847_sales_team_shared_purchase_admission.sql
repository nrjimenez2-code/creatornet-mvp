-- Shared admission only. Original request/receipt/recovery validators are retained.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
create table public.sales_team_purchase_admissions_v1 (
 sale_id uuid primary key references public.sales_team_sale_agreements_v1(id) on delete restrict deferrable initially deferred,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 status text not null default 'active' check(status in ('active','closed_unpaid')),
 created_at timestamptz not null default now(),
 closed_at timestamptz
);
create unique index sales_team_one_purchase_admission_v1 on public.sales_team_purchase_admissions_v1(buyer_id,product_id) where status='active';
alter table public.sales_team_purchase_admissions_v1 enable row level security;
revoke all on public.sales_team_purchase_admissions_v1 from public,anon,authenticated;
grant select,insert,update on public.sales_team_purchase_admissions_v1 to service_role;

create function public.sales_team_canonical_product_v1(p_product_id uuid)
returns uuid language plpgsql stable security invoker set search_path=pg_catalog as $$
declare v_id uuid;v_count integer;
begin
 select count(*),(array_agg(id))[1] into v_count,v_id from public.products where id=p_product_id or product_id=p_product_id;
 if v_count<>1 then raise exception 'AMBIGUOUS_PAYMENT_PRODUCT';end if;
 return v_id;
end $$;

create function public.guard_sales_team_purchase_acceptance_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v_product uuid;v_name text;v_buyer_key text;v_product_key text;v_exists boolean;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'TEAM_PURCHASE_ADMISSION_REQUIRES_READ_COMMITTED';end if;
 v_product:=public.sales_team_canonical_product_v1((new.terms->>'productId')::uuid);
 -- This is the payment candidate's existing buyer/product lock, not a parallel mutex.
 perform pg_advisory_xact_lock(hashtextextended(new.buyer_id::text||':'||v_product::text,72913));
 if exists(select 1 from public.sales_team_purchase_admissions_v1 where buyer_id=new.buyer_id and product_id=v_product and status='active') then raise exception 'EXISTING_TEAM_SALE_REQUIRES_RECOVERY';end if;
 -- Do not reinterpret or adopt any historical/uncertain financial identity.
 for v_name,v_buyer_key,v_product_key in values
  ('product_checkout_attempts','buyer_id','product_id'),('booking_payments','buyer_id','product_id'),
  ('buyer_mentorship_installment_reservations_v1','buyer_id','product_id'),('monthly_mentorship_agreements_v1','buyer_id','product_id'),
  ('full_manual_checkout_requests_v1','buyer_id','product_id'),('exact_installment_agreements','terms.buyerId','terms.productId'),
  ('exact_installment_context_reservations_v2','terms.buyerId','terms.productId'),('purchases','buyer_id','product_id') loop
  if to_regclass('public.'||v_name) is null then raise exception 'TEAM_PAYMENT_DEPENDENCY_SCHEMA_REQUIRED: %',v_name;end if;
  execute format('select exists(select 1 from public.%I r where to_jsonb(r)#>>$1=$2 and exists(select 1 from public.products p where p.id=$3 and (to_jsonb(r)#>>$4=p.id::text or to_jsonb(r)#>>$4=p.product_id::text)))',v_name)
   into v_exists using string_to_array(v_buyer_key,'.'),new.buyer_id::text,v_product,string_to_array(v_product_key,'.');
  if v_exists then raise exception 'EXISTING_PAYMENT_REQUIRES_RECOVERY';end if;
 end loop;
 if exists(select 1 from public.orders o join public.posts p on p.id=o.post_id join public.products product on product.id=v_product
  where o.buyer_id=new.buyer_id and p.product_id in(product.id,product.product_id)) then raise exception 'EXISTING_PAYMENT_REQUIRES_RECOVERY';end if;
 insert into public.sales_team_purchase_admissions_v1(sale_id,buyer_id,product_id,creator_id) values(new.id,new.buyer_id,v_product,new.creator_id);
 return new;
end $$;
create trigger guard_sales_team_purchase_acceptance_v1 before insert on public.sales_team_sale_agreements_v1
 for each row execute function public.guard_sales_team_purchase_acceptance_v1();

create function public.guard_legacy_against_team_purchase_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v_buyer uuid;v_product uuid;v_row jsonb:=to_jsonb(new);
begin
 v_buyer:=(v_row#>>string_to_array(tg_argv[0],'.'))::uuid;
 v_product:=(v_row#>>string_to_array(tg_argv[1],'.'))::uuid;
 if v_buyer is null or v_product is null then return new;end if;
 v_product:=public.sales_team_canonical_product_v1(v_product);
 perform pg_advisory_xact_lock(hashtextextended(v_buyer::text||':'||v_product::text,72913));
 if exists(select 1 from public.sales_team_purchase_admissions_v1 where buyer_id=v_buyer and product_id=v_product and status='active') then raise exception 'TEAM_SALE_OWNS_PURCHASE_ADMISSION';end if;
 return new;
end $$;

do $$ declare v_name text;v_buyer_key text;v_product_key text;v_sig regprocedure;begin
 for v_name,v_buyer_key,v_product_key in values
  ('product_checkout_attempts','buyer_id','product_id'),('booking_payments','buyer_id','product_id'),
  ('buyer_mentorship_installment_reservations_v1','buyer_id','product_id'),('monthly_mentorship_agreements_v1','buyer_id','product_id'),
  ('full_manual_checkout_requests_v1','buyer_id','product_id'),('exact_installment_agreements','terms.buyerId','terms.productId'),
  ('exact_installment_context_reservations_v2','terms.buyerId','terms.productId') loop
  if to_regclass('public.'||v_name) is null then raise exception 'TEAM_PAYMENT_DEPENDENCY_SCHEMA_REQUIRED: %',v_name;end if;
  execute format('create trigger sales_team_purchase_admission_v1 before insert on public.%I for each row execute function public.guard_legacy_against_team_purchase_v1(%L,%L)',v_name,v_buyer_key,v_product_key);
 end loop;
 -- Original operation recovery may still update its existing row. A fresh
 -- attempt-key rotation is admission and must acquire the same shared guard.
 execute 'create trigger sales_team_purchase_rotation_v1 before update of attempt_key on public.product_checkout_attempts for each row when(old.attempt_key is distinct from new.attempt_key) execute function public.guard_legacy_against_team_purchase_v1(''buyer_id'',''product_id'')';
 for v_sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
  ('sales_team_canonical_product_v1','guard_sales_team_purchase_acceptance_v1','guard_legacy_against_team_purchase_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',v_sig);
 end loop;
end $$;
grant execute on function public.sales_team_canonical_product_v1(uuid) to service_role;
commit;
