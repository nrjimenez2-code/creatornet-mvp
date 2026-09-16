-- Initial ranking inventory only. Viewer authorization and fresh page access
-- checks remain in the existing feed path; no personalized data is cached here.
create or replace function public.discover_initial_inventory_page_v1(
 p_after uuid default null, p_limit integer default 1000
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_ids uuid[]; v_result jsonb;
begin
 if p_limit is null or p_limit<1 or p_limit>1000 then
  raise exception 'Invalid initial inventory page' using errcode='22023';
 end if;
 -- Separate first/continuation queries preserve a simple indexed range scan
 -- after PostgreSQL switches a repeatedly called function to a generic plan.
 if p_after is null then
  select array_agg(page.id order by page.id) into v_ids
  from (select p.id from public.posts p order by p.id limit p_limit) page;
 else
  select array_agg(page.id order by page.id) into v_ids
  from (select p.id from public.posts p where p.id>p_after order by p.id limit p_limit) page;
 end if;
 with selected_posts as materialized (
  select id,creator_id,product_id,offering_id,title,content,caption,interests,topics,hashtags,
   created_at,video_url,poster_url,price_cents,allow_booking,booking_url,likes_count,
   comments_count,shares_count,purchase_count,active,hidden_at,removed_at
  from public.posts where id=any(v_ids)
 ), selected_profiles as (
  select id,full_name,username,avatar_url,banned_at,stripe_account_id,stripe_onboarding_complete
  from public.profiles where id in(select creator_id from selected_posts)
 ), primary_products as (
  select id,product_id,creator_id,title,description,type,price_cents,amount_cents,active
  from public.products where id in(select product_id from selected_posts)
 ), legacy_products as (
  select id,product_id,creator_id,title,description,type,price_cents,amount_cents,active
  from public.products where product_id in(select product_id from selected_posts)
 ), selected_offerings as (
  select id,creator_id,title,type,product_metadata,is_active
  from public.offerings where id in(select offering_id from selected_posts)
 )
 select jsonb_build_object(
  'posts',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from selected_posts p),'[]'::jsonb),
  'profiles',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from selected_profiles p),'[]'::jsonb),
  'primaryProducts',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from primary_products p),'[]'::jsonb),
  'legacyProducts',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from legacy_products p),'[]'::jsonb),
  'offerings',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from selected_offerings p),'[]'::jsonb)
 ) into v_result;
 return v_result;
end $$;
revoke all on function public.discover_initial_inventory_page_v1(uuid,integer) from public,anon,authenticated;
grant execute on function public.discover_initial_inventory_page_v1(uuid,integer) to service_role;
