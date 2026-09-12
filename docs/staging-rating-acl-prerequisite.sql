-- LOCAL REVIEW CANDIDATE ONLY. Not authorization to execute, and NEVER production.
-- Separately verify CreatorNet Staging / nwqfofezfzljhxolkycz and its reviewed
-- recovery point before an approved run. SQL cannot establish hosted project ID.
--
-- This deliberately closes BOTH direct-client rating RPCs, including signed-in
-- set_profile_rating callers. It retires that legacy rating entry point; it is
-- not merely removal of an anonymous grant. Execution approval must name that
-- behavior. Candidate code has no mounted ProfileStarRating consumer; the two
-- active update_profile_rating callers use service_role. External callers and
-- profile_reviews direct-table permissions remain separate, unverified scope.
--
-- Exact definitions were inspected read-only on staging on 2026-09-08. Hashes
-- below are md5(pg_get_functiondef(oid)), including its original whitespace.
-- This script replaces NO body, changes NO owner/search_path/trigger/policy,
-- reads/writes NO application rows, and grants NO privilege. It revokes EXECUTE
-- only from PUBLIC, anon and authenticated on the two exact signatures.
-- Baseline or already-repaired ACLs are accepted; any other drift aborts the
-- entire transaction. An uncertain prior run requires read-only inspection.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $rating_acl_prerequisite$
declare
  target record;
  function_oid oid;
  actual_grantees text[];
  valid_acl_entries boolean;
  trigger_before jsonb;
begin
  if current_user <> 'postgres' then
    raise exception 'Rating prerequisite requires the reviewed postgres migration owner';
  end if;
  if (select count(*) from pg_roles where rolname in ('postgres','anon','authenticated','service_role')) <> 4 then
    raise exception 'Rating prerequisite expected roles are missing';
  end if;
  if exists(select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls)) then
    raise exception 'Rating prerequisite client role bypasses protection';
  end if;
  -- The inspected staging clients had no other role memberships. MEMBER/SET
  -- also catch a NOINHERIT membership that effective EXECUTE alone can miss.
  if exists(select 1 from pg_roles c cross join pg_roles r
    where c.rolname in ('anon','authenticated') and c.oid<>r.oid
      and (pg_has_role(c.oid,r.oid,'USAGE') or pg_has_role(c.oid,r.oid,'MEMBER')
        or pg_has_role(c.oid,r.oid,'SET'))) then
    raise exception 'Rating prerequisite unreviewed client role membership';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('set_profile_rating','update_profile_rating','update_reviews_updated_at')) <> 3 then
    raise exception 'Rating prerequisite missing or unreviewed routine overload';
  end if;

  -- Validate every body and ACL BEFORE the first revoke. Trigger execution
  -- rights are not repaired here, and its exact existing catalog is preserved.
  for target in select * from (values
    ('public.set_profile_rating(uuid,uuid,integer)','b6226e332c914d732797d070f96dbcd4',true),
    ('public.update_profile_rating(uuid)','28b76574231e2111b6404f1fe3abe0fa',true),
    ('public.update_reviews_updated_at()','0807db4d0620b1265247ce2c36933afe',false)
  ) as reviewed(signature,fingerprint,is_rpc) loop
    function_oid := to_regprocedure(target.signature);
    if function_oid is null or not exists(select 1 from pg_proc p where p.oid=function_oid
        and p.prokind='f' and pg_get_userbyid(p.proowner)='postgres'
        and p.prosecdef=target.is_rpc
        and md5(pg_get_functiondef(p.oid))=target.fingerprint) then
      raise exception 'Rating prerequisite definition/owner drift: %',target.signature;
    end if;
    if not target.is_rpc then
      select to_jsonb(p) into trigger_before from pg_proc p where p.oid=function_oid;
      continue;
    end if;
    select array_agg(a.grantee_name order by a.grantee_name collate "C"),
      bool_and(a.privilege_type='EXECUTE' and not a.is_grantable and a.grantor_name='postgres')
    into actual_grantees,valid_acl_entries
    from (
      select case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end::text as grantee_name,
        pg_get_userbyid(x.grantor)::text as grantor_name,x.privilege_type,x.is_grantable
      from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
      where p.oid=function_oid
    ) a;
    if valid_acl_entries is distinct from true or not (
        actual_grantees=array['PUBLIC','anon','authenticated','postgres','service_role']::text[]
        or actual_grantees=array['postgres','service_role']::text[]) then
      raise exception 'Rating prerequisite unreviewed ACL drift: %',target.signature;
    end if;
    if not has_function_privilege('service_role',function_oid,'EXECUTE') then
      raise exception 'Rating prerequisite server EXECUTE missing: %',target.signature;
    end if;
  end loop;

  revoke execute on function public.set_profile_rating(uuid,uuid,integer) from public,anon,authenticated;
  revoke execute on function public.update_profile_rating(uuid) from public,anon,authenticated;

  for target in select * from (values
    ('public.set_profile_rating(uuid,uuid,integer)','b6226e332c914d732797d070f96dbcd4'),
    ('public.update_profile_rating(uuid)','28b76574231e2111b6404f1fe3abe0fa')
  ) as reviewed(signature,fingerprint) loop
    function_oid := to_regprocedure(target.signature);
    if not exists(select 1 from pg_proc p where p.oid=function_oid
        and p.prosecdef and pg_get_userbyid(p.proowner)='postgres'
        and md5(pg_get_functiondef(p.oid))=target.fingerprint)
      or has_function_privilege('anon',function_oid,'EXECUTE')
      or has_function_privilege('authenticated',function_oid,'EXECUTE')
      or not has_function_privilege('service_role',function_oid,'EXECUTE') then
      raise exception 'Rating prerequisite postcondition failed; review inherited roles: %',target.signature;
    end if;
  end loop;
  if trigger_before is distinct from (select to_jsonb(p) from pg_proc p
      where p.oid='public.update_reviews_updated_at()'::regprocedure) then
    raise exception 'Rating prerequisite changed an unrelated trigger routine';
  end if;
end;
$rating_acl_prerequisite$;
commit;
