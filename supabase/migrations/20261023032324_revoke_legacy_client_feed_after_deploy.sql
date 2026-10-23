-- POST-DEPLOY phase only. Apply after all current Production applications use
-- get_feed_for_actor_v1 and owner following/discover checks have passed.
-- Never blanket-push this together with the pre-deploy additive phase.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $guard$
declare original oid:='public.get_feed_v3(text,integer,integer)'::regprocedure;
 bridge oid:=to_regprocedure('public.get_feed_for_actor_v1(uuid,text,integer,integer)');
begin
 if not exists(select 1 from pg_proc where oid=original and prosecdef and provolatile='s'
   and md5(prosrc)='56a02092532bed4751a478871b4b2261'
   and pg_get_function_result(oid)='TABLE(post_id uuid, creator_id uuid, product_id uuid, price_cents integer, title text, video_url text, poster_url text, interests text[], hashtags text[], created_at timestamp with time zone, likes_count integer, comments_count integer, shares_count integer, allow_booking boolean, booking_url text, creator_name text, creator_username text, creator_avatar_url text, product_type text, product_price_cents integer, is_liked boolean, is_following boolean, purchase_count integer, creator_verified boolean)') then
  raise exception 'Legacy feed differs from the reviewed Production body or result contract';
 end if;
 if bridge is null or not exists(select 1 from pg_proc where oid=bridge
   and not prosecdef and provolatile='v'
   and proconfig=array['search_path=""']::text[]
   and proargnames[1:4]=array['p_actor','p_tab','p_limit','p_offset']::text[]
   and pronargdefaults=3
   and md5(replace(prosrc,E'\r\n',E'\n'))='4bbc3dedce3970b40f829acf78f9376a'
   and pg_get_function_result(oid)=pg_get_function_result(original)) then
  raise exception 'Service feed bridge differs from the reviewed definition';
 end if;
 if exists(select 1 from pg_proc p,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid=bridge and a.grantee=0 and a.privilege_type='EXECUTE')
   or has_function_privilege('anon',bridge,'EXECUTE')
   or has_function_privilege('authenticated',bridge,'EXECUTE')
   or not has_function_privilege('service_role',bridge,'EXECUTE')
   or not has_function_privilege('service_role',original,'EXECUTE') then
  raise exception 'Service feed bridge privileges differ from the reviewed contract';
 end if;
end $guard$;
revoke all on function public.get_feed_v3(text,integer,integer) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
