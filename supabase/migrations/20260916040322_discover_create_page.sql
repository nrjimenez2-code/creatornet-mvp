-- Save ranked metadata and read fresh first-page inventory in one transport call.
-- Identity is resolved by the server before this service-role-only operation.
create or replace function public.discover_create_page_v1(
 p_actor text, p_user_id uuid, p_tab text, p_post_ids uuid[], p_audiences jsonb,
 p_offset bigint, p_limit integer, p_pilot_id text default null,
 p_pilot_variant text default null, p_pilot_placements jsonb default '{}'
) returns jsonb language plpgsql volatile security invoker set search_path=public as $$
declare session_id uuid; page jsonb;
begin
 if p_offset is null or p_offset<0 or p_limit is null or p_limit<1 or p_limit>50 then
  raise exception 'Invalid feed page' using errcode='22023';
 end if;
 if p_actor is null or (p_user_id is not null and p_actor<>'user:'||p_user_id::text)
  or (p_user_id is null and p_actor !~ '^anon:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') then
  raise exception 'Invalid feed identity' using errcode='22023';
 end if;
 insert into public.discover_sessions_v1(actor,user_id,tab,post_ids,audiences,pilot_id,pilot_variant,pilot_placements)
 values(p_actor,p_user_id,p_tab,p_post_ids,p_audiences,p_pilot_id,p_pilot_variant,p_pilot_placements)
 returning id into session_id;
 -- Reuse the existing ownership, expiry, page bounds and fresh inventory checks.
 page := public.discover_page_inventory_v1(session_id,p_actor,p_offset,p_limit);
 return jsonb_build_object('id',session_id,'page',page);
end $$;
revoke all on function public.discover_create_page_v1(text,uuid,text,uuid[],jsonb,bigint,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.discover_create_page_v1(text,uuid,text,uuid[],jsonb,bigint,integer,text,text,jsonb) to service_role;
