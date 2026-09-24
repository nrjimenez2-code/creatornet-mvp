begin;

-- Reports are moderation records, not discover-ranking events. Only trusted
-- server routes may read or write them; a reporter cannot inspect other reports.
create table if not exists public.post_reports (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id),
  reporter_id uuid not null references auth.users(id),
  reason text not null check (reason in ('sexual_content', 'harassment', 'violence', 'spam', 'other')),
  details text check (details is null or char_length(details) <= 500),
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  notification_status text not null default 'pending' check (notification_status in ('pending', 'sent', 'failed')),
  notified_at timestamptz,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists post_reports_one_open_per_reporter_post
  on public.post_reports (post_id, reporter_id) where status = 'open';
create index if not exists post_reports_open_recent
  on public.post_reports (created_at desc, id desc) where status = 'open';
create index if not exists post_reports_post_recent
  on public.post_reports (post_id, created_at desc);

alter table public.post_reports enable row level security;
revoke all on public.post_reports from public, anon, authenticated;
grant select, insert, update on public.post_reports to service_role;

create or replace function public.post_report_counts(p_post_ids uuid[])
returns table(post_id uuid, report_count bigint)
language sql stable set search_path = ''
as $$
  select r.post_id, count(*)::bigint
  from public.post_reports r
  where r.post_id = any(p_post_ids)
  group by r.post_id;
$$;
revoke all on function public.post_report_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.post_report_counts(uuid[]) to service_role;

commit;
