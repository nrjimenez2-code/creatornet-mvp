-- Current session ownership, eligibility and event metadata in one private read.
create or replace function public.discover_event_context_v1(p_session uuid, p_actor text, p_post uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare audience text; inventory jsonb;
begin
 select coalesce(s.audiences->>p_post::text,'general') into audience
 from public.discover_sessions_v1 s
 join public.posts p on p.id=p_post and p.id=any(s.post_ids)
 join public.profiles c on c.id=p.creator_id
 where s.id=p_session and s.actor=p_actor and s.expires_at>now()
 and p.active is distinct from false and p.hidden_at is null and p.removed_at is null
 and c.banned_at is null;
 if not found then return null; end if;
 inventory:=public.discover_inventory_batch_v1(array[p_post]);
 return jsonb_build_object('audience',audience,'post',inventory->'posts'->0,
   'primaryProducts',inventory->'primaryProducts','legacyProducts',inventory->'legacyProducts',
   'offerings',inventory->'offerings');
end $$;
revoke all on function public.discover_event_context_v1(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.discover_event_context_v1(uuid,text,uuid) to service_role;
