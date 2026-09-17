begin;

-- Server-only batch. Auth remains in the route; clients cannot supply another
-- actor directly. Invoker permissions preserve the service-role boundary.
create function public.update_post_like_v1(p_user_id uuid, p_post_id uuid, p_like_only boolean)
returns jsonb language plpgsql security invoker set search_path = '' set lock_timeout = '2s'
as $$
declare
  changed integer;
  total integer;
  category text;
  is_liked boolean := true;
  inserted boolean := false;
begin
  if p_user_id is null or p_post_id is null or p_like_only is null then
    raise exception 'Like arguments required' using errcode = '22004';
  end if;

  -- Serialize gestures for one viewer/post, not all viewers of a popular post.
  -- No network work occurs while this transaction holds its lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_post_id::text, 1732026));

  select coalesce(p.likes_count, 0), p.interests[pg_catalog.array_lower(p.interests, 1)]
    into total, category from public.posts p where p.id = p_post_id;
  if not found then raise exception 'Post not found' using errcode = 'P0002'; end if;

  if not p_like_only then
    delete from public.likes where user_id = p_user_id and post_id = p_post_id;
    get diagnostics changed = row_count;
    if changed > 0 then
      update public.posts set likes_count = greatest(0, coalesce(likes_count, 0) - 1)
        where id = p_post_id returning likes_count into total;
      is_liked := false;
    end if;
  end if;

  if is_liked then
    insert into public.likes(user_id, post_id) values (p_user_id, p_post_id)
      on conflict (user_id, post_id) do nothing;
    get diagnostics changed = row_count;
    inserted := changed > 0;
    if inserted then
      update public.posts set likes_count = greatest(0, coalesce(likes_count, 0) + 1)
        where id = p_post_id returning likes_count into total;
    else
      -- A concurrent insert may have committed after the first count read.
      select coalesce(p.likes_count, 0) into total from public.posts p where p.id = p_post_id;
    end if;
  end if;

  -- Existing likes triggers still record/invalidate Discover recommendation
  -- events. Category normalization and the best-effort +5 interest update remain
  -- in the existing server helper, once per actual insertion.
  return pg_catalog.jsonb_build_object('liked', is_liked, 'likes_count', total,
    'inserted', inserted, 'category', case when inserted then category else null end);
end;
$$;
revoke all on function public.update_post_like_v1(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.update_post_like_v1(uuid,uuid,boolean) to service_role;
comment on function public.update_post_like_v1(uuid,uuid,boolean) is
  'Verified server actor only; atomic like mutation/count with existing Discover trigger; gated by POST_LIKE_RPC_V1.';
commit;
