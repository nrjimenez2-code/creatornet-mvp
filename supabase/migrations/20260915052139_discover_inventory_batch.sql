-- One server-only round trip for the inventory needed by a feed page.
-- Authorization/session ownership is checked by the route; visibility is still
-- rechecked by discoverInventory on every page, never served from ranking cache.
create or replace function public.discover_inventory_batch_v1(p_ids uuid[])
returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare result jsonb;
begin
 if p_ids is null or cardinality(p_ids)>200 then
  raise exception 'Invalid inventory batch' using errcode='22023';
 end if;
 with selected_posts as (
  select id,creator_id,product_id,offering_id,title,content,caption,interests,topics,hashtags,
   created_at,video_url,poster_url,price_cents,allow_booking,booking_url,likes_count,
   comments_count,shares_count,purchase_count,active,hidden_at,removed_at
  from public.posts where id=any(p_ids)
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
  'posts',coalesce((select jsonb_agg(to_jsonb(p)) from selected_posts p),'[]'::jsonb),
  'profiles',coalesce((select jsonb_agg(to_jsonb(p)) from selected_profiles p),'[]'::jsonb),
  'primaryProducts',coalesce((select jsonb_agg(to_jsonb(p)) from primary_products p),'[]'::jsonb),
  'legacyProducts',coalesce((select jsonb_agg(to_jsonb(p)) from legacy_products p),'[]'::jsonb),
  'offerings',coalesce((select jsonb_agg(to_jsonb(p)) from selected_offerings p),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.discover_inventory_batch_v1(uuid[]) from public,anon,authenticated;
grant execute on function public.discover_inventory_batch_v1(uuid[]) to service_role;
