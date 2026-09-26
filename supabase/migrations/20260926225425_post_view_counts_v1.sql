-- DB MIGRATION REQUIRED. Read-only recorded counts; does not change recording.
-- Apply this file alone after reviewing the target database and migration ledger.
begin;
set local lock_timeout = '1s';
set local statement_timeout = '10s';

create or replace function public.get_post_view_counts_v1(p_post_ids uuid[])
returns table (post_id uuid, view_count bigint)
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  if p_post_ids is null or cardinality(p_post_ids) > 100 or array_position(p_post_ids, null) is not null then
    raise exception 'Expected up to 100 non-null post IDs' using errcode = '22023';
  end if;
  return query
    select p.id,
      greatest(coalesce(m.views, 0), 0)::bigint + (
        select count(*) from public.discover_events_v1 e
        where e.post_id = p.id and e.kind = 'qualified_view' and e.valid = true
      ) as view_count
    from public.posts p
    left join public.post_metrics m on m.post_id = p.id
    where p.id = any(p_post_ids);
end;
$$;

revoke all on function public.get_post_view_counts_v1(uuid[]) from public, anon, authenticated;
grant execute on function public.get_post_view_counts_v1(uuid[]) to service_role;
comment on function public.get_post_view_counts_v1(uuid[]) is
  'Service-only recorded views: legacy post_metrics.views plus valid Discover qualified_view events. Call only after preview authorization.';
commit;
