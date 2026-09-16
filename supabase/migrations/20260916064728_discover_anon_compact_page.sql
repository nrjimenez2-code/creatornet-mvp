-- One private round trip for a fresh anonymous-claim check and owned feed page.
-- The caller still verifies Auth and the anonymous HMAC before passing this UUID.
create or replace function public.discover_anon_compact_page_v1(
 p_session uuid, p_anonymous uuid, p_offset bigint, p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare page jsonb;
begin
 if p_offset is null or p_offset<0 or p_limit is null or p_limit<1 or p_limit>50 then
  raise exception 'Invalid feed page' using errcode='22023';
 end if;
 if p_anonymous is null or exists(
  select 1 from public.discover_identity_links_v1 where anonymous_id=p_anonymous
 ) then
  raise exception 'Feed session unavailable' using errcode='CN001';
 end if;
 page := public.discover_compact_page_v1(p_session,'anon:'||p_anonymous::text,p_offset,p_limit);
 return pg_catalog.jsonb_build_object('anonymousClaimChecked',true,'page',page);
end $$;
revoke all on function public.discover_anon_compact_page_v1(uuid,uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.discover_anon_compact_page_v1(uuid,uuid,bigint,integer) to service_role;
