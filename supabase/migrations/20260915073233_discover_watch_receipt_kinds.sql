-- Watch time still advances on every eligible sample. Existing immutable event
-- receipts let the server avoid another upsert when no new milestone was met.
create or replace function public.discover_watch_context_v1(
 p_session uuid,p_actor text,p_post uuid,p_claimed numeric
) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare context jsonb; watched numeric; recorded jsonb;
begin
 context:=public.discover_event_context_v1(p_session,p_actor,p_post);
 if context is null then return null; end if;
 watched:=public.discover_watch_sample_v1(p_session,p_post,p_claimed);
 select coalesce(jsonb_agg(e.kind order by e.kind),'[]'::jsonb) into recorded
 from public.discover_events_v1 e
 where e.actor=p_actor and e.post_id=p_post and e.entity_key=p_session::text||':'||p_post::text
 and e.kind in ('exposure','qualified_view','completion');
 return context || jsonb_build_object('watched',watched,'recordedKinds',recorded);
end $$;
revoke all on function public.discover_watch_context_v1(uuid,text,uuid,numeric) from public,anon,authenticated;
grant execute on function public.discover_watch_context_v1(uuid,text,uuid,numeric) to service_role;
