-- Bounded transport output; full ranked snapshots remain private in the database.
create or replace function public.discover_compact_page_v1(
 p_session uuid, p_actor text, p_offset bigint, p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare ranked uuid[]; expiry timestamptz; selected uuid[] := '{}'; total integer;
begin
 if p_offset is null or p_offset<0 or p_limit is null or p_limit<1 or p_limit>50 then
  raise exception 'Invalid feed page' using errcode='22023';
 end if;
 select post_ids,expires_at into ranked,expiry from public.discover_sessions_v1
 where id=p_session and actor=p_actor;
 if not found or expiry<=now() then
  raise exception 'Feed session unavailable' using errcode='CN001';
 end if;
 total := cardinality(ranked);
 if p_offset<total then
  selected := ranked[(p_offset+1)::integer:least(p_offset+p_limit,total)::integer];
 end if;
 return jsonb_build_object('page_post_ids',selected,'total_count',total,'expires_at',expiry,
  'inventory',public.discover_inventory_batch_v1(selected));
end $$;
revoke all on function public.discover_compact_page_v1(uuid,text,bigint,integer) from public,anon,authenticated;
grant execute on function public.discover_compact_page_v1(uuid,text,bigint,integer) to service_role;

create or replace function public.discover_create_compact_page_v1(
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
 page := public.discover_compact_page_v1(session_id,p_actor,p_offset,p_limit);
 return jsonb_build_object('id',session_id,'page',page);
end $$;
revoke all on function public.discover_create_compact_page_v1(text,uuid,text,uuid[],jsonb,bigint,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.discover_create_compact_page_v1(text,uuid,text,uuid[],jsonb,bigint,integer,text,text,jsonb) to service_role;
