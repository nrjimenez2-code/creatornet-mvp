-- Event identity and eligibility must be fresh in the same private request.
-- Reject a claimed anonymous token even if an old session still has that actor;
-- this replaces the event route's separate identity-link Data API lookup.
create or replace function public.discover_event_context_v1(p_session uuid, p_actor text, p_post uuid)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare audience text; inventory jsonb; v_anonymous_id uuid;
begin
 if left(p_actor,5)='anon:' then
  begin
   v_anonymous_id:=substring(p_actor from 6)::uuid;
  exception when invalid_text_representation then
   return null;
  end;
  if exists(select 1 from public.discover_identity_links_v1 l where l.anonymous_id=v_anonymous_id) then
   return null;
  end if;
 end if;
 select coalesce(s.audiences->>p_post::text,'general') into audience
 from public.discover_sessions_v1 s
 join public.posts p on p.id=p_post and p.id=any(s.post_ids)
 join public.profiles c on c.id=p.creator_id
 where s.id=p_session and s.actor=p_actor and s.expires_at>now()
 and p.active is distinct from false and p.hidden_at is null and p.removed_at is null
 and c.banned_at is null;
 if not found then return null; end if;
 inventory:=public.discover_inventory_batch_v1(array[p_post]);
 return jsonb_build_object('anonymousClaimChecked',true,'audience',audience,'post',inventory->'posts'->0,
   'primaryProducts',inventory->'primaryProducts','legacyProducts',inventory->'legacyProducts',
   'offerings',inventory->'offerings');
end $$;
revoke all on function public.discover_event_context_v1(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.discover_event_context_v1(uuid,text,uuid) to service_role;
