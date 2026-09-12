-- REVIEWED TARGET ONLY. After the complete 058-100 entitlement chain.
-- Replace the observed review helper(s), retaining their signatures/owners/ACLs.
-- No review rows, purchase flags, financial routines or policies are changed.
begin;
set local search_path=pg_catalog;
set local statement_timeout='30s';
set local lock_timeout='5s';
do $preflight$
declare f record; seen integer:=0;
begin
  if current_user <> 'postgres' then raise exception '101 requires the reviewed postgres owner'; end if;
  if to_regprocedure('public.review_purchase_entitled_v1(uuid,uuid)') is not null then
    raise exception '101 already exists: inspect committed state rather than replay'; end if;
  for f in select p.*,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.oid in(to_regprocedure('public.read_fixed_service_entitlement_v1(uuid,uuid)'),
      to_regprocedure('public.read_monthly_mentorship_entitlement_v1(uuid,uuid)')) loop
    if not f.prosecdef or pg_get_userbyid(f.proowner)<>'postgres' or f.prorettype<>'jsonb'::regtype or
       has_function_privilege('anon',f.oid,'execute') or has_function_privilege('authenticated',f.oid,'execute') or
       not has_function_privilege('service_role',f.oid,'execute') then
      raise exception '101 entitlement reader security differs'; end if;
    seen:=seen+1;
  end loop;
  if seen<>2 or to_regclass('public.fixed_purchase_service_contracts_v1') is null or
    to_regclass('public.monthly_mentorship_agreements_v1') is null then
    raise exception '101 requires both complete entitlement schemas'; end if;
  seen:=0;
  for f in select p.*,n.nspname,md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10))) body_hash
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid in
    (to_regprocedure('public.can_review_purchased_post(uuid,uuid)'),to_regprocedure('private.has_live_purchase_of_post(uuid,uuid,uuid)')) loop
    if pg_get_userbyid(f.proowner)<>'postgres' or not f.prosecdef or
      (f.nspname='public' and (f.body_hash<>'6b5f3cc5c663de65367f8fa881183af5' or
        f.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres}')) or
      (f.nspname='private' and (f.body_hash<>'5a4f282a02ffefa1cfba491e4bf9db6a' or
        f.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')) then
      raise exception '101 review helper differs from the inspected contract'; end if;
    seen:=seen+1;
  end loop;
  if seen=0 then raise exception '101 requires an inspected review helper'; end if;
end $preflight$;

create function public.review_purchase_entitled_v1(p_purchase_id uuid,p_buyer_id uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare p public.purchases%rowtype; entitlement jsonb; seconds numeric;
begin
  if auth.uid() is null or p_buyer_id is distinct from auth.uid() then return false; end if;
  select * into p from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id;
  if not found or p.status is null or p.status in ('refunded','failed') then return false; end if;
  entitlement:=public.read_fixed_service_entitlement_v1(p.id,p_buyer_id);
  if jsonb_typeof(entitlement->'applicable') is distinct from 'boolean' then return false; end if;
  if entitlement->'applicable'='false'::jsonb then
    entitlement:=public.read_monthly_mentorship_entitlement_v1(p.id,p_buyer_id);
  end if;
  if entitlement->'allowed' is distinct from 'true'::jsonb or
    jsonb_typeof(entitlement->'maxAgeSeconds') is distinct from 'number' then return false; end if;
  seconds:=(entitlement->>'maxAgeSeconds')::numeric;
  return seconds>=1 and seconds<=3600 and seconds=trunc(seconds);
end $$;
revoke all on function public.review_purchase_entitled_v1(uuid,uuid) from public,anon,authenticated,service_role;

do $replace_helpers$
begin
  if to_regprocedure('public.can_review_purchased_post(uuid,uuid)') is not null then
    execute $ddl$create or replace function public.can_review_purchased_post(p_post uuid,p_creator uuid)
      returns boolean language sql security definer set search_path=pg_catalog as $body$
        select auth.uid() is not null and p_post is not null and p_creator is not null and auth.uid()<>p_creator
          and exists(select 1 from public.posts po join public.purchases pu on pu.post_id=po.id
            where po.id=p_post and po.creator_id=p_creator and pu.buyer_id=auth.uid()
              and public.review_purchase_entitled_v1(pu.id,auth.uid()));
      $body$ $ddl$;
  end if;
  if to_regprocedure('private.has_live_purchase_of_post(uuid,uuid,uuid)') is not null then
    execute $ddl$create or replace function private.has_live_purchase_of_post(p_buyer uuid,p_post uuid,p_creator uuid)
      returns boolean language sql security definer set search_path=pg_catalog as $body$
        select auth.uid() is not null and p_buyer=auth.uid() and p_post is not null and p_creator is not null
          and p_buyer<>p_creator and exists(select 1 from public.posts po join public.purchases pu on pu.post_id=po.id
            where po.id=p_post and po.creator_id=p_creator and pu.buyer_id=p_buyer
              and public.review_purchase_entitled_v1(pu.id,p_buyer));
      $body$ $ddl$;
  end if;
end $replace_helpers$;
-- CREATE OR REPLACE preserves the existing wrapper ACLs, including service-role
-- execute on the private wrapper. Its answer remains bound to the JWT buyer.
do $postcheck$
begin
  if has_function_privilege('anon','public.review_purchase_entitled_v1(uuid,uuid)','execute') or
     has_function_privilege('authenticated','public.review_purchase_entitled_v1(uuid,uuid)','execute') or
     has_function_privilege('service_role','public.review_purchase_entitled_v1(uuid,uuid)','execute') then
    raise exception '101 internal helper must not become a callable client/server API'; end if;
end $postcheck$;
commit;
