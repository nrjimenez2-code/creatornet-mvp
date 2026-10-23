-- Close legacy writable-view bypasses and pin routine lookup paths.
-- No rows, existing function bodies, service-role grants or release settings change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin
  if has_schema_privilege('anon','public','CREATE') or has_schema_privilege('authenticated','public','CREATE') then
    raise exception 'Public schema must not allow client object creation';
  end if;
end $$;
revoke all privileges on public.post_freshness,public.feed_debug,public.trending_hashtags,
  public.post_engagement_daily,public.sales_velocity_mv from anon,authenticated;
alter view public.post_freshness set (security_invoker=true);
alter view public.feed_debug set (security_invoker=true);
alter view public.trending_hashtags set (security_invoker=true);
alter view public.post_engagement_daily set (security_invoker=true);
-- Creation/cancellation is server-authorized. Keep owned recovery SELECTs;
-- remove the obsolete direct-client path that could fabricate booking state.
revoke insert,update,delete on public.bookings from public,anon,authenticated;
revoke insert(id,post_id,buyer_id,creator_id,status,linked_order_id,created_at),
  update(id,post_id,buyer_id,creator_id,status,linked_order_id,created_at)
  on public.bookings from public,anon,authenticated;
-- public is trusted (client CREATE refused above); pg_temp is explicitly last.
-- Preserve all existing bodies, owners, ACLs, volatility and return contracts.
do $$ declare signature text; routine regprocedure; begin
  foreach signature in array array[
    'public.get_feed_v2(uuid,integer,integer)',
    'public.get_profile_rating(uuid)',
    'public.interests_to_text_array(jsonb)',
    'public.interests_to_text_array(text[])',
    'public.jsonb_to_text_array(jsonb)',
    'public.log1p_safe(double precision)',
    'public.minmax_norm(double precision,double precision,double precision)',
    'public.set_updated_at()',
    'public.sv_components(timestamp with time zone)',
    'public.update_reviews_updated_at()'
  ] loop
    routine:=to_regprocedure(signature);
    if routine is null or (select proconfig is not null from pg_proc where oid=routine) then
      raise exception 'Routine missing or its configuration changed: %',signature;
    end if;
    execute format('alter function %s set search_path=pg_catalog,public,pg_temp',routine);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;

