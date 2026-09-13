begin;
create table if not exists public.discover_sessions_v1 (
 id uuid primary key default gen_random_uuid(), actor text not null, user_id uuid references auth.users(id) on delete cascade,
 audiences jsonb not null default '{}',
 tab text not null check(tab in ('discover','following')), post_ids uuid[] not null,
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '2 hours'
);
create index if not exists discover_sessions_actor_v1 on public.discover_sessions_v1(actor,created_at desc);
create index if not exists discover_sessions_expiry_v1 on public.discover_sessions_v1(expires_at,id);
create table if not exists public.discover_events_v1 (
 id uuid primary key default gen_random_uuid(), actor text not null, user_id uuid references auth.users(id) on delete set null,
 -- Retain the originating ID and category snapshot after a post is removed.
 post_id uuid not null,
 creator_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('exposure','qualified_view','completion','product_tap','booking_tap','checkout_start',
 'booking_setup_complete','booking_scheduled','booking_canceled','purchase','mentorship_purchase','not_interested','quick_skip','like')),
 entity_key text not null, categories text[] not null default '{}', topics text[] not null default '{}',
 audience text not null default 'general', offer_type text not null default 'none',
 amount_cents bigint not null default 0 check(amount_cents>=0), currency text,
 occurred_at timestamptz not null default now(), unique(kind,entity_key)
);
create index if not exists discover_events_post_recent_v1 on public.discover_events_v1(post_id,occurred_at desc);
create index if not exists discover_events_actor_recent_v1 on public.discover_events_v1(actor,occurred_at desc);
create table if not exists public.discover_watch_v1 (
 session_id uuid not null references public.discover_sessions_v1(id) on delete cascade,
 post_id uuid not null references public.posts(id) on delete cascade,
 claimed_seconds numeric not null default 0, watch_seconds numeric not null default 0,
 last_at timestamptz not null default now(), primary key(session_id,post_id)
);
create table if not exists public.discover_booking_attribution_v1 (
 id uuid primary key default gen_random_uuid(), setup_session_id text not null unique,
 user_id uuid not null references auth.users(id) on delete cascade,
 creator_id uuid not null references auth.users(id) on delete cascade,
 post_id uuid not null,
 created_at timestamptz not null default now(), provider text, provider_booking_id text,
 scheduled_at timestamptz, verified_at timestamptz, canceled_at timestamptz,
 unique(provider,provider_booking_id)
);
create table if not exists public.discover_checkout_links_v1 (
 id uuid primary key default gen_random_uuid(), provider_session_id text not null unique,
 buyer_id uuid not null references auth.users(id) on delete cascade,
 creator_id uuid not null references auth.users(id) on delete cascade,
 post_id uuid not null, destination text not null,
 created_at timestamptz not null default now()
);
create table if not exists public.discover_identity_links_v1 (
 anonymous_id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
 linked_at timestamptz not null default now()
);
do $$ declare name text; begin
 foreach name in array array['discover_sessions_v1','discover_events_v1','discover_watch_v1','discover_booking_attribution_v1','discover_checkout_links_v1','discover_identity_links_v1'] loop
 execute format('alter table public.%I enable row level security',name);
 execute format('revoke all on public.%I from public,anon,authenticated',name);
 execute format('grant select,insert,update,delete on public.%I to service_role',name);
 end loop;
end $$;
-- Only the backend can record these facts. Clients cannot turn a delta into a sale.
create or replace function public.discover_watch_sample_v1(p_session uuid,p_post uuid,p_claimed numeric)
returns numeric language plpgsql set search_path='' as $$
declare w public.discover_watch_v1; elapsed numeric; total numeric;
begin
 if p_claimed is null or p_claimed<0 or p_claimed>43200 or p_claimed::text in ('NaN','Infinity','-Infinity') then
 raise exception 'invalid watch sample'; end if;
 insert into public.discover_watch_v1(session_id,post_id) values(p_session,p_post) on conflict do nothing;
 select * into w from public.discover_watch_v1 where session_id=p_session and post_id=p_post for update;
 elapsed:=greatest(0,extract(epoch from clock_timestamp()-w.last_at));
 total:=w.watch_seconds + greatest(0,least(p_claimed-w.claimed_seconds,elapsed,6));
 if p_claimed>w.claimed_seconds then
 update public.discover_watch_v1 set claimed_seconds=p_claimed,watch_seconds=total,last_at=clock_timestamp()
 where session_id=p_session and post_id=p_post;
 end if;
 return total;
end $$;
revoke all on function public.discover_watch_sample_v1(uuid,uuid,numeric) from public,anon,authenticated;
grant execute on function public.discover_watch_sample_v1(uuid,uuid,numeric) to service_role;
-- Retire expired snapshots as new sessions arrive. This bounded batch skips
-- rows another request is cleaning; watch receipts cascade with their session.
create or replace function public.discover_prune_sessions_v1()
returns trigger language plpgsql set search_path='' as $$
begin
 delete from public.discover_sessions_v1 where id in (
  select id from public.discover_sessions_v1 where expires_at<now()
   order by expires_at,id limit 100 for update skip locked
 );
 return new;
end $$;
revoke all on function public.discover_prune_sessions_v1() from public,anon,authenticated;
drop trigger if exists discover_prune_sessions_v1 on public.discover_sessions_v1;
create trigger discover_prune_sessions_v1 after insert on public.discover_sessions_v1
 for each row execute function public.discover_prune_sessions_v1();
commit;
