-- Direct REST/RPC/GraphQL/Realtime access must honor the saved website release.
-- No content, accounts, accepted financial terms, settings or grants are removed.
begin;

-- Do not silently replace another request hook or a concurrent security change.
do $$ begin
  if exists(select 1 from pg_db_role_setting d join pg_roles r on r.oid=d.setrole,
    lateral unnest(d.setconfig) s(value)
    where r.rolname='authenticator' and s.value like 'pgrst.db_pre_request=%'
      and s.value <> 'pgrst.db_pre_request=') then
    raise exception 'Existing Data API request hook requires integration';
  end if;
end $$;

-- These helpers must read the private configuration and verified caller identity.
-- Keep them out of exposed schemas, with no caller-supplied actor argument.
create function website_release_private.client_feature_open_v1(p_features text[]) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare s public.website_release_settings_v1; caller uuid := auth.uid();
begin
  if auth.role()='service_role' then return true; end if;
  select * into s from public.website_release_settings_v1 where id='00000000-0000-4000-8000-000000000001';
  if not found or public.valid_website_release_flags_v1(s.features) is not true then return false; end if;
  if caller is not null and coalesce(auth.jwt()->>'is_anonymous','false')='false'
    and website_release_private.verified_account_v1(caller) then
    if caller=s.owner_id or exists(select 1 from public.website_release_testers_v1 where user_id=caller) then return true; end if;
  end if;
  return not s.hidden and exists(select 1 from unnest(p_features) f where s.features->>f='true');
end;
$$;

create function website_release_private.client_post_read_v1(p_post uuid,p_creator uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare caller uuid := auth.uid();
begin
  if caller is null or coalesce(auth.jwt()->>'is_anonymous','false') <> 'false'
    or not exists(select 1 from auth.users u where u.id=caller
      and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)) then return false; end if;
  -- Only preview metadata already reachable under the existing grants/policies.
  -- Paid/timed delivery continues to require the existing entitlement readers.
  return caller=p_creator or exists(select 1 from public.purchases p where p.buyer_id=caller and p.post_id=p_post);
end;
$$;

create function website_release_private.client_profile_read_v1(p_profile uuid) returns boolean
language sql stable security definer set search_path='' as $$
  -- Own-profile reads also carry ban status to existing server-side safeguards.
  select auth.uid()=p_profile;
$$;

-- SECURITY DEFINER feed/analytics functions bypass table RLS. Check the signed
-- request before any public RPC executes, without rewriting the legacy bodies.
create function website_release_private.check_data_request_v1() returns void
language plpgsql stable security invoker set search_path='' as $$
declare request_path text := regexp_replace(coalesce(current_setting('request.path',true),''),'^(/rest/v1)?/','');
  routine text; features text[];
begin
  if auth.role()='service_role' then return; end if;
  if request_path not like 'rpc/%' then return; end if;
  routine := substr(request_path,5);
  features := case
    when routine in ('get_feed_discover','get_feed_following','get_feed_v1','get_feed_v2','get_feed_v3') then array['feed']
    when routine in ('creator_kpis','creator_views_timeseries') then array['analytics']
    when routine='get_profile_rating' then array['profiles']
    when routine='set_profile_rating' then array['engagement']
    when routine='next_booking_target' then array['scheduling']
    when routine='is_username_available' then array['registration','creatorTools']
    else array[]::text[] end;
  if routine='is_admin' and auth.uid() is not null then return; end if;
  if not website_release_private.client_feature_open_v1(features) then
    raise insufficient_privilege using message='Website feature is not available';
  end if;
end;
$$;

revoke all on function website_release_private.client_feature_open_v1(text[]),
  website_release_private.client_post_read_v1(uuid,uuid),website_release_private.client_profile_read_v1(uuid),
  website_release_private.check_data_request_v1() from public,anon,authenticated,service_role;
grant usage on schema website_release_private to anon,authenticated;
grant execute on function website_release_private.client_feature_open_v1(text[]),
  website_release_private.client_post_read_v1(uuid,uuid),website_release_private.client_profile_read_v1(uuid),
  website_release_private.check_data_request_v1() to anon,authenticated,service_role;

-- Restrictive policies AND with all existing permissive policies. They also
-- apply to embedded relations, GraphQL and future Realtime publications.
create policy website_release_select_v1 on public.posts as restrictive for select to anon,authenticated
  using ((select website_release_private.client_feature_open_v1(array['feed','profiles','search']))
    or website_release_private.client_post_read_v1(id,creator_id));
create policy website_release_insert_v1 on public.posts as restrictive for insert to anon,authenticated
  with check ((select website_release_private.client_feature_open_v1(array['publishing'])));
create policy website_release_update_v1 on public.posts as restrictive for update to anon,authenticated
  using ((select website_release_private.client_feature_open_v1(array['publishing'])))
  with check ((select website_release_private.client_feature_open_v1(array['publishing'])));
create policy website_release_delete_v1 on public.posts as restrictive for delete to anon,authenticated
  using ((select website_release_private.client_feature_open_v1(array['publishing'])));
create policy website_release_select_v1 on public.profiles as restrictive for select to anon,authenticated
  using ((select website_release_private.client_feature_open_v1(array['profiles']))
    or website_release_private.client_profile_read_v1(id));
create policy website_release_insert_v1 on public.profiles as restrictive for insert to anon,authenticated
  with check ((select website_release_private.client_feature_open_v1(array['registration','creatorTools'])));
create policy website_release_update_v1 on public.profiles as restrictive for update to anon,authenticated
  using ((select website_release_private.client_feature_open_v1(array['creatorTools'])))
  with check ((select website_release_private.client_feature_open_v1(array['creatorTools'])));
create policy website_release_delete_v1 on public.profiles as restrictive for delete to anon,authenticated
  using ((select website_release_private.client_feature_open_v1(array['creatorTools'])));

do $$ declare item record; begin
  for item in select * from (values
    ('products',array['products']),('offerings',array['products']),
    ('follows',array['engagement']),('likes',array['engagement']),('post_likes',array['engagement']),
    ('comments',array['engagement']),('reviews',array['engagement']),
    ('post_metrics',array['feed','analytics']),('post_views',array['feed','analytics']),
    ('post_events',array['feed','analytics']),('user_interest_scores',array['feed']),
    ('booking_targets',array['scheduling']),('team_routing',array['scheduling']),('closers',array['scheduling']),
    ('booking_clicks',array['scheduling','analytics']),('clicks',array['feed','analytics'])
  ) mapping(relation,features) loop
    if to_regclass(format('public.%I',item.relation)) is null then
      raise exception 'Missing release-controlled relation: %',item.relation;
    end if;
    execute format('create policy website_release_access_v1 on public.%I as restrictive for all to anon,authenticated using ((select website_release_private.client_feature_open_v1(%L::text[]))) with check ((select website_release_private.client_feature_open_v1(%L::text[])))',item.relation,item.features,item.features);
  end loop;
end $$;

-- Auth, Storage media URLs, buyer-owned purchases/progress/bookings and existing
-- service-role background/fulfillment paths retain their current policies.
alter role authenticator set pgrst.db_pre_request='website_release_private.check_data_request_v1';
notify pgrst,'reload config';
notify pgrst,'reload schema';
commit;
