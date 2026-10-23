-- Emergency rollback only. This reopens the audited direct-data access gap.
begin;
do $$ begin
  if not exists(select 1 from pg_db_role_setting d join pg_roles r on r.oid=d.setrole,
    lateral unnest(d.setconfig) s(value) where r.rolname='authenticator'
    and s.value='pgrst.db_pre_request=website_release_private.check_data_request_v1')
    or exists(select 1 from pg_db_role_setting d join pg_roles r on r.oid=d.setrole,
      lateral unnest(d.setconfig) s(value) where r.rolname='authenticator'
      and s.value like 'pgrst.db_pre_request=%'
      and s.value <> 'pgrst.db_pre_request=website_release_private.check_data_request_v1') then
    raise exception 'Request hook changed; integrate rollback manually';
  end if;
end $$;
alter role authenticator reset pgrst.db_pre_request;
do $$ declare item record; begin
  for item in select schemaname,tablename,policyname from pg_policies
    where schemaname='public' and (
      (tablename in ('posts','profiles') and policyname in ('website_release_select_v1','website_release_insert_v1',
        'website_release_update_v1','website_release_delete_v1'))
      or (tablename in ('products','offerings','follows','likes','post_likes','comments','reviews','post_metrics',
        'post_views','post_events','user_interest_scores','booking_targets','team_routing','closers','booking_clicks','clicks')
        and policyname='website_release_access_v1')) loop
    execute format('drop policy %I on %I.%I',item.policyname,item.schemaname,item.tablename);
  end loop;
end $$;
drop function website_release_private.check_data_request_v1();
drop function website_release_private.client_post_read_v1(uuid,uuid);
drop function website_release_private.client_profile_read_v1(uuid);
drop function website_release_private.client_feature_open_v1(text[]);
revoke usage on schema website_release_private from anon,authenticated;
notify pgrst,'reload config';
notify pgrst,'reload schema';
commit;
