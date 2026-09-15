-- Distinguish a snapshot that cannot be continued from transient API failures.
-- Missing, expired and differently owned snapshots have the same safe result.
create or replace function public.discover_page_inventory_v1(
 p_session uuid, p_actor text, p_offset bigint, p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path=public as $$
declare snapshot public.discover_sessions_v1%rowtype; selected uuid[] := '{}';
begin
 if p_offset is null or p_offset<0 or p_limit is null or p_limit<1 or p_limit>50 then
  raise exception 'Invalid feed page' using errcode='22023';
 end if;
 select * into snapshot from public.discover_sessions_v1
 where id=p_session and actor=p_actor;
 if not found or snapshot.expires_at<=now() then
  raise exception 'Feed session unavailable' using errcode='CN001';
 end if;
 if p_offset<cardinality(snapshot.post_ids) then
  selected := snapshot.post_ids[(p_offset+1)::integer:least(p_offset+p_limit,cardinality(snapshot.post_ids))::integer];
 end if;
 return jsonb_build_object('post_ids',snapshot.post_ids,'expires_at',snapshot.expires_at,
  'inventory',public.discover_inventory_batch_v1(selected));
end $$;
revoke all on function public.discover_page_inventory_v1(uuid,text,bigint,integer) from public,anon,authenticated;
grant execute on function public.discover_page_inventory_v1(uuid,text,bigint,integer) to service_role;
