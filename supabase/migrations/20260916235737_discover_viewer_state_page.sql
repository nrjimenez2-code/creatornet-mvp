-- Keep personalized state inside the same service-only page request. No cache,
-- identity issuance, entitlement change, or ranking change is introduced.
create or replace function public.discover_page_viewer_state_v1(p_page jsonb,p_user_id uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare selected uuid[]; creators uuid[]; liked uuid[]; followed uuid[];
begin
 if p_user_id is null or jsonb_typeof(p_page->'page_post_ids') is distinct from 'array'
  or jsonb_array_length(p_page->'page_post_ids')>50 then
  raise exception 'Invalid viewer page' using errcode='22023';
 end if;
 select coalesce(array_agg(value::uuid),'{}') into selected
 from jsonb_array_elements_text(p_page->'page_post_ids');
 select coalesce(array_agg(distinct (value->>'creator_id')::uuid),'{}') into creators
 from jsonb_array_elements(p_page->'inventory'->'posts');
 select coalesce(array_agg(post_id order by post_id),'{}') into liked
 from public.likes where user_id=p_user_id and post_id=any(selected);
 select coalesce(array_agg(following_id order by following_id),'{}') into followed
 from public.follows where follower_id=p_user_id and following_id=any(creators);
 return p_page||jsonb_build_object('viewer_state',jsonb_build_object('user_id',p_user_id,
  'liked_post_ids',liked,'followed_creator_ids',followed));
end $$;
revoke all on function public.discover_page_viewer_state_v1(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.discover_page_viewer_state_v1(jsonb,uuid) to service_role;

create or replace function public.discover_user_compact_page_v1(
 p_session uuid,p_actor text,p_user_id uuid,p_offset bigint,p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare page jsonb;
begin
 if p_user_id is null or p_actor is distinct from 'user:'||p_user_id::text then
  raise exception 'Feed session unavailable' using errcode='CN001';
 end if;
 -- Check the stored user binding as well as the existing actor/expiry check.
 if not exists(select 1 from public.discover_sessions_v1
   where id=p_session and actor=p_actor and user_id=p_user_id) then
  raise exception 'Feed session unavailable' using errcode='CN001';
 end if;
 page:=public.discover_compact_page_v1(p_session,p_actor,p_offset,p_limit);
 return public.discover_page_viewer_state_v1(page,p_user_id);
end $$;
revoke all on function public.discover_user_compact_page_v1(uuid,text,uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.discover_user_compact_page_v1(uuid,text,uuid,bigint,integer) to service_role;

create or replace function public.discover_create_user_compact_page_v1(
 p_actor text,p_user_id uuid,p_tab text,p_post_ids uuid[],p_audiences jsonb,
 p_offset bigint,p_limit integer,p_pilot_id text default null,
 p_pilot_variant text default null,p_pilot_placements jsonb default '{}'
) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare saved jsonb;
begin
 if p_user_id is null or p_actor is distinct from 'user:'||p_user_id::text then
  raise exception 'Invalid feed identity' using errcode='22023';
 end if;
 saved:=public.discover_create_compact_page_v1(p_actor,p_user_id,p_tab,p_post_ids,p_audiences,
  p_offset,p_limit,p_pilot_id,p_pilot_variant,p_pilot_placements);
 return jsonb_set(saved,'{page}',public.discover_page_viewer_state_v1(saved->'page',p_user_id));
end $$;
revoke all on function public.discover_create_user_compact_page_v1(text,uuid,text,uuid[],jsonb,bigint,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.discover_create_user_compact_page_v1(text,uuid,text,uuid[],jsonb,bigint,integer,text,text,jsonb) to service_role;
