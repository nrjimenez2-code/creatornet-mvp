-- Disposable PostgreSQL 17 CI database only. Actual application functions come
-- from the three repository migrations; these are minimal supporting tables.
create role anon;
create role authenticated;
create role untrusted;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create table public.posts(id uuid primary key,creator_id uuid,product_id uuid,offering_id uuid,
 title text,content text,caption text,interests text[],topics text[],hashtags text[],created_at timestamptz,
 video_url text,poster_url text,price_cents bigint,allow_booking bool,booking_url text,likes_count int,
 comments_count int,shares_count int,purchase_count int,active bool,hidden_at timestamptz,removed_at timestamptz);
create table public.profiles(id uuid primary key,full_name text,username text,avatar_url text,banned_at timestamptz,
 stripe_account_id text,stripe_onboarding_complete bool,private_extra text);
create table public.products(id uuid primary key,product_id uuid,creator_id uuid,title text,description text,
 type text,price_cents bigint,amount_cents bigint,active bool);
create table public.offerings(id uuid primary key,creator_id uuid,title text,type text,product_metadata jsonb,is_active bool);
create table public.discover_sessions_v1(id uuid primary key default gen_random_uuid(),actor text,post_ids uuid[],expires_at timestamptz,
 user_id uuid,tab text,audiences jsonb not null default '{}',pilot_id text,pilot_variant text,pilot_placements jsonb not null default '{}');
create table public.discover_identity_links_v1(anonymous_id uuid primary key,user_id uuid not null references auth.users(id));
create table public.__claim_probe_ci_receipts(kind text primary key,value jsonb not null);
alter table public.discover_sessions_v1 enable row level security;
alter table public.discover_identity_links_v1 enable row level security;
grant select on public.posts,public.profiles,public.products,public.offerings,public.discover_sessions_v1,public.discover_identity_links_v1 to service_role;
grant select,insert on public.__claim_probe_ci_receipts to service_role;
insert into auth.users values('11111111-1111-4111-8111-111111111111');
insert into public.discover_sessions_v1(id,actor,user_id,tab,post_ids,expires_at) values
 ('22222222-2222-4222-8222-222222222222','anon:44444444-4444-4444-8444-444444444444',null,'discover','{}',now()+interval '10 minutes'),
 ('33333333-3333-4333-8333-333333333333','anon:55555555-5555-4555-8555-555555555555',null,'discover','{}',now()+interval '10 minutes');
insert into public.discover_identity_links_v1 values('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111');
