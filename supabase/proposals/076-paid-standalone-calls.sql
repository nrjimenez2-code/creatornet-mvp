-- UNAPPLIED. #5: private scheduling for a typed one-time product. No new
-- payments, allocations or entitlement engine; reuse purchases/payment_fee_ledger.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $$ begin
  if current_user <> 'postgres' or to_regclass('public.paid_call_targets') is not null or
    not exists(select 1 from pg_constraint where conrelid='public.products'::regclass and conname='products_type_check' and convalidated) then
    raise exception 'Paid-call prerequisites differ'; end if;
end $$;
alter table public.products drop constraint products_type_check;
alter table public.products add constraint products_type_check check (type in ('video','course','mentorship','call'));
create table public.paid_call_targets (
  product_id uuid primary key references public.products(id) on delete restrict,
  creator_id uuid not null references public.profiles(id) on delete restrict,
  scheduling_url text not null check (length(scheduling_url) between 12 and 2048 and scheduling_url ~ '^https://[^/@[:space:]]+\.[^/@[:space:]]+(/|$)'),
  created_at timestamptz not null default now()
);
alter table public.paid_call_targets enable row level security;
revoke all on public.paid_call_targets from public,anon,authenticated,service_role;
grant select on public.paid_call_targets to service_role;

create function public.guard_paid_call_product_v1() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' and (old.type='call' or new.type='call') and old.type is distinct from new.type then
    raise exception 'Create a new product to change a paid-call offer type'; end if;
  if new.type='call' and (new.price_cents<50 or new.amount_cents is distinct from new.price_cents or new.currency<>'usd' or new.plan_months is distinct from 1 or
    new.external_url is not null or new.deliver_url is not null or new.discord_invite_url is not null or new.whop_listing_url is not null or
    not exists(select 1 from public.paid_call_targets t where t.product_id=new.id and t.creator_id=new.creator_id)) then
    raise exception 'Paid calls require one price and a private scheduling target'; end if;
  return new;
end $$;
-- Deferred so the service-only creation function can insert both rows atomically.
create constraint trigger guard_paid_call_product_v1 after insert or update on public.products
deferrable initially deferred for each row execute function public.guard_paid_call_product_v1();

create function public.create_paid_call_product_v1(p_creator_id uuid,p_title text,p_description text,p_price_cents integer,p_scheduling_url text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare p public.products%rowtype;
begin
  if p_creator_id is null or p_title is null or length(btrim(p_title)) not between 1 and 200 or
    p_price_cents is null or p_price_cents not between 50 and 99999999 then raise exception 'Invalid paid-call offer'; end if;
  insert into public.products(id,creator_id,title,description,type,price_cents,amount_cents,currency,plan_months,fulfillment,active,is_active,created_at)
    values(gen_random_uuid(),p_creator_id,btrim(p_title),p_description,'call',p_price_cents,p_price_cents,'usd',1,'FILE',true,true,now()) returning * into p;
  insert into public.paid_call_targets(product_id,creator_id,scheduling_url) values(p.id,p_creator_id,p_scheduling_url);
  return to_jsonb(p);
end $$;

create function public.read_paid_call_access_v1(p_purchase_id uuid,p_buyer_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog as $$
  select jsonb_build_object('purchase_id',p.id,'buyer_id',p.buyer_id,'creator_id',p.creator_id,'product_id',p.product_id,
    'session_id',p.session_id,'payment_intent_id',p.payment_intent_id,'amount_cents',p.amount_cents,'currency',p.currency,
    'scheduling_url',t.scheduling_url,'stripe_charge_id',l.stripe_charge_id,'total_creator_deduction_cents',l.total_creator_deduction_cents)
  from public.purchases p join public.products pr on pr.id=p.product_id and pr.type='call'
    join public.paid_call_targets t on t.product_id=pr.id and t.creator_id=p.creator_id
    join public.payment_fee_ledger l on l.purchase_id=p.id and l.stripe_payment_intent_id=p.payment_intent_id
      and l.creator_id=p.creator_id and l.gross_amount_cents=p.amount_cents and l.currency=p.currency and l.status='paid'
  where p.id=p_purchase_id and p.buyer_id=p_buyer_id and p.access_granted=true and p.status in ('paid','active','complete')
    and p.session_id is not null and p.payment_intent_id is not null and l.stripe_charge_id is not null;
$$;
create function public.list_paid_calls_v1(p_buyer_id uuid,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare items jsonb; more boolean;
begin
  if p_buyer_id is null or p_offset is null or p_offset<0 or p_offset>10000 then raise exception 'Invalid call page'; end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id),'[]'::jsonb) into items from (
    select p.id,pr.title,p.status,p.access_granted,p.created_at from public.purchases p
    join public.products pr on pr.id=p.product_id and pr.type='call' where p.buyer_id=p_buyer_id
    order by p.created_at desc,p.id limit 20 offset p_offset
  ) r;
  select exists(select 1 from public.purchases p join public.products pr on pr.id=p.product_id and pr.type='call'
    where p.buyer_id=p_buyer_id order by p.created_at desc,p.id limit 1 offset (p_offset+20)) into more;
  return jsonb_build_object('items',items,'hasMore',more);
end $$;
revoke all on function public.guard_paid_call_product_v1(),public.create_paid_call_product_v1(uuid,text,text,integer,text),
  public.read_paid_call_access_v1(uuid,uuid),public.list_paid_calls_v1(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.create_paid_call_product_v1(uuid,text,text,integer,text),
  public.read_paid_call_access_v1(uuid,uuid),public.list_paid_calls_v1(uuid,integer) to service_role;
commit;
