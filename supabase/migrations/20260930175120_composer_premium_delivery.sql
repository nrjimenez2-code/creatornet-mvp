begin;

alter table public.products add column delivery_revision uuid;
alter table public.products drop constraint if exists products_type_check;
alter table public.products add constraint products_type_check check (type in ('video','bundle','course','mentorship','call'));
alter table public.posts add column video_action text;
alter table public.posts add column action_version integer not null default 0 check (action_version in (0,1));
alter table public.posts add constraint posts_video_action_check check (video_action in ('buy','book','tip'));

-- Existing delivery URLs also stay behind authenticated server interfaces.
-- Preserve every sales column and the existing row-level ownership policies.
do $sales_acl$
declare visible text; hidden text;
begin
 select string_agg(quote_ident(attname),',') filter (where attname not in
  ('deliver_url','discord_invite_url','whop_listing_url','external_url','fulfillment_url','fulfillment_payload','premium_video_url','discord_channel_id','whop_listing_id')),
  string_agg(quote_ident(attname),',') filter (where attname in
  ('deliver_url','discord_invite_url','whop_listing_url','external_url','fulfillment_url','fulfillment_payload','premium_video_url','discord_channel_id','whop_listing_id'))
 into visible,hidden from pg_attribute where attrelid='public.products'::regclass and attnum>0 and not attisdropped;
 revoke select on public.products from public,anon,authenticated;
 if hidden is not null then execute format('revoke select (%s) on public.products from public,anon,authenticated',hidden); end if;
 execute format('grant select (%s) on public.products to anon,authenticated',visible);
end $sales_acl$;

-- Preserve financial references. Combined legacy posts become Buy only.
update public.posts set video_action = case
 when product_id is not null or offering_id is not null or coalesce(price_cents,0)>0 then 'buy'
 when allow_booking then 'book' when tips_enabled then 'tip' else null end;
update public.posts set allow_booking=false,booking_url=null,booking_url_override=null
 where video_action='buy' and allow_booking;

create table public.private_video_assets (
 id uuid primary key default gen_random_uuid(),
 creator_id uuid not null references public.profiles(id) on delete restrict,
 provider text not null check (provider in ('stream','supabase')),
 provider_id text,
 status text not null check (status in ('creating','uploading','processing','ready','failed','canceling','canceled')),
 name text not null,
 duration_seconds numeric check (duration_seconds>0 and duration_seconds<=36000),
 size_bytes bigint check (size_bytes>0 and size_bytes<30000000000),
 fingerprint text check (fingerprint ~ '^[0-9a-f]{64}$'),
 upload_url text,
 upload_expires_at timestamptz,
 failure_code text,
 legacy_post_id uuid unique references public.posts(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(id,creator_id),
 check (status not in ('ready','uploading','processing') or provider_id is not null)
);
create unique index private_video_stream_id on public.private_video_assets(provider_id) where provider='stream';
create unique index private_video_upload_fingerprint on public.private_video_assets(creator_id,fingerprint)
 where fingerprint is not null and status not in ('failed','canceled');
create index private_video_assets_creator on public.private_video_assets(creator_id,created_at desc);

-- Wrap each legacy post independently; keep the exact existing storage key.
insert into public.private_video_assets(creator_id,provider,provider_id,status,name,legacy_post_id)
 select creator_id,'supabase',premium_path,'ready',coalesce(nullif(title,''),'Purchased video'),id
 from public.posts where nullif(premium_path,'') is not null and creator_id is not null;

create table public.product_delivery_revisions (
 id uuid primary key default gen_random_uuid(),
 product_id uuid not null references public.products(id) on delete restrict,
 creator_id uuid not null references public.profiles(id) on delete restrict,
 links jsonb not null default '[]' check (jsonb_typeof(links)='array' and jsonb_array_length(links)<=30),
 created_at timestamptz not null default now(),
 unique(id,creator_id),
 unique(id,product_id,creator_id)
);
create table public.product_delivery_videos (
 revision_id uuid not null references public.product_delivery_revisions(id) on delete restrict,
 asset_id uuid not null,
 creator_id uuid not null,
 label text not null check (length(btrim(label)) between 1 and 160),
 position integer not null check (position between 0 and 99),
 primary key(revision_id,asset_id),
 unique(revision_id,position),
 foreign key(asset_id,creator_id) references public.private_video_assets(id,creator_id) on delete restrict
 ,foreign key(revision_id,creator_id) references public.product_delivery_revisions(id,creator_id) on delete restrict
);
alter table public.products add constraint products_delivery_revision_fk
 foreign key(delivery_revision,id,creator_id) references public.product_delivery_revisions(id,product_id,creator_id) on delete restrict;

-- Frozen before opening Stripe. Ordinary clients have no access to URLs.
create table public.checkout_delivery_snapshots (
 order_id uuid primary key,
 buyer_id uuid not null references public.profiles(id) on delete restrict,
 creator_id uuid not null references public.profiles(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 revision_id uuid not null references public.product_delivery_revisions(id) on delete restrict,
 title text not null,
 product_type text not null,
 amount_cents bigint not null check (amount_cents>=50),
 currency text not null check (currency='usd'),
 links jsonb not null check (jsonb_typeof(links)='array'),
 created_at timestamptz not null default now()
 ,foreign key(revision_id,product_id,creator_id) references public.product_delivery_revisions(id,product_id,creator_id) on delete restrict
);
create table public.purchase_deliveries (
 purchase_id uuid primary key references public.purchases(id) on delete restrict,
 order_id uuid not null unique references public.checkout_delivery_snapshots(order_id) on delete restrict,
 created_at timestamptz not null default now()
);
create table public.private_video_progress (
 purchase_id uuid not null references public.purchases(id) on delete restrict,
 asset_id uuid not null references public.private_video_assets(id) on delete restrict,
 buyer_id uuid not null references public.profiles(id) on delete restrict,
 seconds numeric not null check (seconds>=0 and seconds<=36000),
 updated_at timestamptz not null default now(),
 primary key(purchase_id,asset_id)
);
create table public.free_booking_checkouts (
 id uuid primary key default gen_random_uuid(),
 buyer_id uuid not null references public.profiles(id) on delete restrict,
 creator_id uuid not null references public.profiles(id) on delete restrict,
 post_id uuid not null references public.posts(id) on delete restrict,
 destination text not null,
 checkout_origin text not null check (checkout_origin ~ '^https://[^/]+$' or checkout_origin ~ '^http://localhost(:[0-9]+)?$'),
 stripe_session_id text unique,
 status text not null default 'creating' check (status in ('creating','open','complete','expired')),
 created_at timestamptz not null default now(),
 completed_at timestamptz
);
create unique index free_booking_checkout_open on public.free_booking_checkouts(buyer_id,post_id)
 where status in ('creating','open');

do $acl$
declare t text;
begin
 foreach t in array array['private_video_assets','product_delivery_revisions','product_delivery_videos',
  'checkout_delivery_snapshots','purchase_deliveries','private_video_progress','free_booking_checkouts'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $acl$;

create function public.immutable_product_delivery_v1() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 raise exception 'Purchased delivery and published delivery revisions are immutable';
end $$;
create trigger product_delivery_revisions_immutable before update or delete on public.product_delivery_revisions
 for each row execute function public.immutable_product_delivery_v1();
create trigger product_delivery_videos_immutable before update or delete on public.product_delivery_videos
 for each row execute function public.immutable_product_delivery_v1();
create trigger checkout_delivery_snapshot_immutable before update or delete on public.checkout_delivery_snapshots
 for each row execute function public.immutable_product_delivery_v1();
create trigger purchase_deliveries_immutable before update or delete on public.purchase_deliveries
 for each row execute function public.immutable_product_delivery_v1();

create function public.guard_product_delivery_pointer_v1() returns trigger
language plpgsql security invoker set search_path=public as $$
begin
 if (tg_op='INSERT' and new.delivery_revision is not null) or
  (tg_op='UPDATE' and new.delivery_revision is distinct from old.delivery_revision) then
  if current_user not in ('service_role','postgres') then raise exception 'Delivery requires the product service' using errcode='42501'; end if;
 end if;
 return new;
end $$;
create trigger product_delivery_pointer_guard before insert or update on public.products
 for each row execute function public.guard_product_delivery_pointer_v1();

create function public.save_product_delivery_v1(p_product_id uuid,p_creator_id uuid,p_links jsonb,p_videos jsonb)
returns uuid language plpgsql security invoker set search_path=public as $$
declare p public.products%rowtype; r uuid; v jsonb; n integer; i integer:=0;
begin
 select * into p from public.products where id=p_product_id and creator_id=p_creator_id for update;
 if not found then raise exception 'Product ownership mismatch'; end if;
 if jsonb_typeof(p_links) is distinct from 'array' or jsonb_typeof(p_videos) is distinct from 'array' or
  jsonb_array_length(p_links)>30 or jsonb_array_length(p_videos)>100 then raise exception 'Invalid delivery'; end if;
 n:=jsonb_array_length(p_videos);
 if (p.type='video' and (n<>1 or jsonb_array_length(p_links)>0)) or
  (p.type='bundle' and (n<2 or jsonb_array_length(p_links)>0)) or
  (p.type in ('course','mentorship') and n+jsonb_array_length(p_links)=0) or
  p.type not in ('video','bundle','course','mentorship') then raise exception 'Incompatible delivery'; end if;
 for v in select value from jsonb_array_elements(p_links) loop
  if jsonb_typeof(v->'label') is distinct from 'string' or length(btrim(v->>'label')) not between 1 and 160 or
   jsonb_typeof(v->'url') is distinct from 'string' or length(v->>'url')>2048 or
   (v->>'url') !~ '^https://[^/@[:space:]]+([/?#]|$)' then raise exception 'Invalid access link'; end if;
 end loop;
 insert into public.product_delivery_revisions(product_id,creator_id,links)
 values(p.id,p.creator_id,p_links) returning id into r;
 for v in select value from jsonb_array_elements(p_videos) loop
  if jsonb_typeof(v->'label') is distinct from 'string' or length(btrim(v->>'label')) not between 1 and 160 then raise exception 'Invalid video label'; end if;
  perform 1 from public.private_video_assets where id=(v->>'asset_id')::uuid and creator_id=p.creator_id
   and status='ready' for share;
  if not found then raise exception 'Video is not owned and ready'; end if;
  insert into public.product_delivery_videos values(r,(v->>'asset_id')::uuid,p.creator_id,btrim(v->>'label'),i);
  i:=i+1;
 end loop;
 update public.products set delivery_revision=r where id=p.id;
 return r;
end $$;

create function public.prepare_checkout_delivery_v1(p_order_id uuid,p_buyer_id uuid,p_product_id uuid,p_revision_id uuid,p_amount_cents bigint)
returns uuid language plpgsql security invoker set search_path=public as $$
declare p public.products%rowtype; existing public.checkout_delivery_snapshots%rowtype;
begin
 select * into existing from public.checkout_delivery_snapshots where order_id=p_order_id;
 if found then
  if existing.buyer_id<>p_buyer_id or existing.product_id<>p_product_id or
   existing.revision_id<>p_revision_id or existing.amount_cents<>p_amount_cents then raise exception 'Checkout delivery binding differs'; end if;
  return existing.revision_id;
 end if;
 select * into p from public.products where id=p_product_id for share;
 if not found or p.active is false or p.is_active is false or p.delivery_revision is distinct from p_revision_id or
  p.price_cents is distinct from p_amount_cents or lower(coalesce(p.currency,'usd'))<>'usd' then raise exception 'Product changed or unavailable'; end if;
 perform 1 from public.product_delivery_videos v join public.private_video_assets a on a.id=v.asset_id
  where v.revision_id=p_revision_id and (a.creator_id<>p.creator_id or a.status<>'ready');
 if found then raise exception 'Promised video is not ready'; end if;
 insert into public.checkout_delivery_snapshots(order_id,buyer_id,creator_id,product_id,revision_id,title,product_type,amount_cents,currency,links)
 select p_order_id,p_buyer_id,p.creator_id,p.id,r.id,p.title,p.type,p_amount_cents,'usd',r.links
 from public.product_delivery_revisions r where r.id=p_revision_id and r.product_id=p.id and r.creator_id=p.creator_id;
 if not found then raise exception 'Delivery revision missing'; end if;
 return p_revision_id;
end $$;

-- Pending rows retain their purchased revision, and fulfillment retries reuse it.
create function public.bind_purchase_delivery_v1() returns trigger
language plpgsql security invoker set search_path=public as $$
declare s public.checkout_delivery_snapshots%rowtype; old_order uuid; delivery_order uuid; p public.products%rowtype;
begin
 delivery_order:=coalesce(new.order_id,new.id);
 select order_id into old_order from public.purchase_deliveries where purchase_id=new.id;
 if found and old_order is distinct from delivery_order then raise exception 'Purchase delivery cannot be replaced'; end if;
 -- Monthly and guarded installment reservations seed their purchase before
 -- opening Checkout. They keep their original financial identities and fields.
 if tg_op='INSERT' and new.order_id is null then
  select * into p from public.products where id=new.product_id;
  if p.delivery_revision is not null then
   if p.creator_id is distinct from new.creator_id then raise exception 'Reserved product owner differs'; end if;
   perform public.prepare_checkout_delivery_v1(delivery_order,new.buyer_id,p.id,p.delivery_revision,p.price_cents);
  end if;
 end if;
 select * into s from public.checkout_delivery_snapshots where order_id=delivery_order;
 if not found then return new; end if;
 if new.buyer_id is distinct from s.buyer_id or new.creator_id is distinct from s.creator_id or
  new.product_id is distinct from s.product_id or (old_order is null and new.order_id is not null and new.amount_cents is distinct from s.amount_cents) or
  lower(new.currency) is distinct from s.currency then raise exception 'Purchase delivery ownership or price differs'; end if;
 insert into public.purchase_deliveries(purchase_id,order_id) values(new.id,s.order_id) on conflict(purchase_id) do nothing;
 return new;
end $$;
create trigger purchase_delivery_bind after insert or update on public.purchases
 for each row execute function public.bind_purchase_delivery_v1();

create function public.guard_private_video_progress_v1() returns trigger
language plpgsql security invoker set search_path=public as $$
declare p public.purchases%rowtype;
begin
 select * into p from public.purchases where id=new.purchase_id;
 if not found or p.buyer_id is distinct from new.buyer_id then raise exception 'Progress ownership mismatch'; end if;
 if not exists(select 1 from public.purchase_deliveries d
  join public.checkout_delivery_snapshots s on s.order_id=d.order_id
  join public.product_delivery_videos v on v.revision_id=s.revision_id
  where d.purchase_id=p.id and v.asset_id=new.asset_id) and not exists(
   select 1 from public.private_video_assets a where a.id=new.asset_id and a.legacy_post_id=p.post_id)
 then raise exception 'Video is not included in this purchase'; end if;
 return new;
end $$;
create trigger private_video_progress_guard before insert or update on public.private_video_progress
 for each row execute function public.guard_private_video_progress_v1();

create function public.guard_published_video_action_v1() returns trigger
language plpgsql security invoker set search_path=public as $$
declare p public.products%rowtype;
begin
 if tg_op='UPDATE' then
  if row(new.video_action,new.action_version,new.product_id,new.offering_id,new.allow_booking,new.booking_url,
    new.booking_url_override,new.tips_enabled,new.premium_path,new.cta_type) is distinct from
   row(old.video_action,old.action_version,old.product_id,old.offering_id,old.allow_booking,old.booking_url,
    old.booking_url_override,old.tips_enabled,old.premium_path,old.cta_type) then
   raise exception 'Choose the video button only when publishing';
  end if;
  if new.action_version=1 and new.video_action='buy' and new.price_cents is distinct from old.price_cents then
   select * into p from public.products where id=new.product_id and creator_id=new.creator_id;
   if not found or new.price_cents is distinct from p.price_cents then raise exception 'Buy uses the saved product price'; end if;
  end if;
  return new;
 end if;
 if new.action_version=0 then
  new.video_action:=case when new.product_id is not null or new.offering_id is not null or coalesce(new.price_cents,0)>0 then 'buy'
   when new.allow_booking then 'book' when new.tips_enabled then 'tip' else null end;
 end if;
 if new.video_action is not null and current_user not in ('service_role','postgres') then
  raise exception 'Video button requires the publishing service' using errcode='42501';
 end if;
 if new.video_action='buy' and (new.allow_booking or new.booking_url is not null or new.tips_enabled) or
  new.video_action='book' and (new.product_id is not null or new.offering_id is not null or coalesce(new.price_cents,0)<>0 or new.tips_enabled or new.premium_path is not null) or
  new.video_action='tip' and (not new.tips_enabled or new.allow_booking or new.product_id is not null or new.offering_id is not null or new.premium_path is not null or coalesce(new.price_cents,0)<>0) or
  new.video_action is null and (new.product_id is not null or new.offering_id is not null or new.allow_booking or new.booking_url is not null or new.tips_enabled or new.premium_path is not null or coalesce(new.price_cents,0)<>0) then
  raise exception 'Conflicting video buttons';
 end if;
 if new.video_action='book' and (not new.allow_booking or nullif(btrim(new.booking_url),'') is null) then
  raise exception 'Book needs a free scheduling destination';
 end if;
 if new.action_version=1 and new.video_action='buy' then
  select * into p from public.products where id=new.product_id and creator_id=new.creator_id for share;
  if not found or p.active is false or p.is_active is false then raise exception 'Product unavailable'; end if;
  if p.price_cents is null or p.price_cents<50 then raise exception 'Save the product price before publishing Buy'; end if;
  if p.delivery_revision is not null and exists(
   select 1 from public.product_delivery_videos v join public.private_video_assets a on a.id=v.asset_id
   where v.revision_id=p.delivery_revision and (a.creator_id<>new.creator_id or a.status<>'ready')) then
   raise exception 'Promised video is not ready';
  end if;
  if p.type in ('video','bundle','course','mentorship') and p.delivery_revision is null then
   raise exception 'Product delivery is incomplete';
  end if;
  new.price_cents:=p.price_cents;
 end if;
 return new;
end $$;
create trigger published_video_action_guard before insert or update on public.posts
 for each row execute function public.guard_published_video_action_v1();

revoke all on function public.save_product_delivery_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.prepare_checkout_delivery_v1(uuid,uuid,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.save_product_delivery_v1(uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.prepare_checkout_delivery_v1(uuid,uuid,uuid,uuid,bigint) to service_role;
revoke all on function public.immutable_product_delivery_v1() from public,anon,authenticated;
revoke all on function public.guard_product_delivery_pointer_v1() from public,anon,authenticated;
revoke all on function public.bind_purchase_delivery_v1() from public,anon,authenticated;
revoke all on function public.guard_published_video_action_v1() from public,anon,authenticated;
revoke all on function public.guard_private_video_progress_v1() from public,anon,authenticated;
commit;
