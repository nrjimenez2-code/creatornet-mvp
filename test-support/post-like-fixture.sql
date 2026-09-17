create role anon;
create role authenticated;
create role untrusted;
create role service_role bypassrls;
create schema discover_private;
create table profiles(id uuid primary key);
create table posts(id uuid primary key, creator_id uuid references profiles, likes_count integer default 0,
  interests text[], topics text[]);
create table likes(id uuid default gen_random_uuid() primary key, user_id uuid references profiles,
  post_id uuid references posts, unique(user_id,post_id));
create table discover_events_v1(actor text,user_id uuid,post_id uuid,creator_id uuid,kind text,
  entity_key text,categories text[],topics text[],valid boolean default true,unique(kind,entity_key));
alter table posts enable row level security;
alter table likes enable row level security;
alter table discover_events_v1 enable row level security;
grant usage on schema public to service_role;
grant select,insert,update,delete on posts,likes to service_role;
insert into profiles values ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
insert into posts values ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111',0,
  array[' Content Creation ','technology & ai'],array['sample']);
