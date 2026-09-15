-- Keep ownership/eligibility checks ahead of every watch receipt mutation.
create or replace function public.discover_watch_context_v1(
 p_session uuid,p_actor text,p_post uuid,p_claimed numeric
) returns jsonb language plpgsql volatile security invoker set search_path='' as $$
declare context jsonb; watched numeric;
begin
 context:=public.discover_event_context_v1(p_session,p_actor,p_post);
 if context is null then return null; end if;
 watched:=public.discover_watch_sample_v1(p_session,p_post,p_claimed);
 return context || jsonb_build_object('watched',watched);
end $$;
revoke all on function public.discover_watch_context_v1(uuid,text,uuid,numeric) from public,anon,authenticated;
grant execute on function public.discover_watch_context_v1(uuid,text,uuid,numeric) to service_role;
