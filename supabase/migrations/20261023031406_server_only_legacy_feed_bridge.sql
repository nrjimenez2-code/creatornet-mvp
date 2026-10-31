-- PRE-DEPLOY additive phase. Preserve existing legacy feed ACLs until every
-- current application deployment has switched to the verified service bridge.
-- The separately reviewed post-deploy migration closes direct client execution.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $guard$
begin
 if not exists(select 1 from pg_proc where oid='public.get_feed_v3(text,integer,integer)'::regprocedure
   and prosecdef and provolatile='s' and md5(prosrc)='56a02092532bed4751a478871b4b2261'
   and pg_get_function_result(oid)='TABLE(post_id uuid, creator_id uuid, product_id uuid, price_cents integer, title text, video_url text, poster_url text, interests text[], hashtags text[], created_at timestamp with time zone, likes_count integer, comments_count integer, shares_count integer, allow_booking boolean, booking_url text, creator_name text, creator_username text, creator_avatar_url text, product_type text, product_price_cents integer, is_liked boolean, is_following boolean, purchase_count integer, creator_verified boolean)') then
  raise exception 'Legacy feed differs from the reviewed Production body or result contract';
 end if;
end $guard$;

create function public.get_feed_for_actor_v1(
 p_actor uuid,p_tab text default 'discover',p_limit integer default 20,p_offset integer default 0
) returns TABLE(post_id uuid, creator_id uuid, product_id uuid, price_cents integer, title text, video_url text, poster_url text, interests text[], hashtags text[], created_at timestamp with time zone, likes_count integer, comments_count integer, shares_count integer, allow_booking boolean, booking_url text, creator_name text, creator_username text, creator_avatar_url text, product_type text, product_price_cents integer, is_liked boolean, is_following boolean, purchase_count integer, creator_verified boolean)
language plpgsql security invoker set search_path='' as $bridge$
declare
 old_claims text:=coalesce(current_setting('request.jwt.claims',true),'');
 old_claim text:=coalesce(current_setting('request.jwt.claim',true),'');
 old_sub text:=coalesce(current_setting('request.jwt.claim.sub',true),'');
 old_role text:=coalesce(current_setting('request.jwt.claim.role',true),'');
 actor_role text:=case when p_actor is null then 'anon' else 'authenticated' end;
 scoped_claims text;
begin
 -- An argument never authenticates a public caller. Only the trusted API's
 -- service role can enter; it obtains p_actor from server-verified getUser().
 if current_setting('role',true) is distinct from 'service_role' then
  raise insufficient_privilege using message='Service feed entry required';
 end if;
 scoped_claims:=jsonb_build_object('role',actor_role,'sub',p_actor)::text;
 perform set_config('request.jwt.claims',scoped_claims,true);
 perform set_config('request.jwt.claim',scoped_claims,true);
 perform set_config('request.jwt.claim.sub',coalesce(p_actor::text,''),true);
 perform set_config('request.jwt.claim.role',actor_role,true);
 begin
  -- RETURN QUERY materializes the unchanged result before restoring context.
  return query select * from public.get_feed_v3(p_tab,p_limit,p_offset);
 exception when others then
  perform set_config('request.jwt.claims',old_claims,true);
  perform set_config('request.jwt.claim',old_claim,true);
  perform set_config('request.jwt.claim.sub',old_sub,true);
  perform set_config('request.jwt.claim.role',old_role,true);
  raise;
 end;
 perform set_config('request.jwt.claims',old_claims,true);
 perform set_config('request.jwt.claim',old_claim,true);
 perform set_config('request.jwt.claim.sub',old_sub,true);
 perform set_config('request.jwt.claim.role',old_role,true);
end $bridge$;
revoke all on function public.get_feed_for_actor_v1(uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.get_feed_for_actor_v1(uuid,text,integer,integer) to service_role;
-- Do not revoke the old function here: current Production still uses its
-- authenticated SSR caller. Revoke only after the new code is verified live.
grant execute on function public.get_feed_v3(text,integer,integer) to service_role;
notify pgrst,'reload schema';
commit;
