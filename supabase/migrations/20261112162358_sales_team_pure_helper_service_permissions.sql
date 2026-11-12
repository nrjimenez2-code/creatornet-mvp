-- Local candidate: exact approved service EXECUTE for two pure shared helpers.
-- No hosted installation, financial context/data operation or activation.
-- Requires a controlled single-writer window without concurrent role/admin maintenance.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
set local search_path=pg_catalog,pg_temp;
do $contract$
declare expected record;routine oid;p pg_proc;original_oids jsonb:='{}';
begin
 if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed'
  or not has_schema_privilege('service_role','public','USAGE') then
  raise exception 'TEAM_PREREQUISITE_HELPER_INSTALLER_REQUIRED';end if;
 -- Preflight BOTH owner-only predecessors before expanding either permission.
 for expected in select * from (values
  ('public.fixed_service_end_v1(bigint,integer)','6ab96f17f2b4f2f2a92c90082ea48c49ac16d6395c3a8d9eb1c887818d912f0d','bigint'),
  ('public.valid_monthly_fee_snapshot_v1(jsonb,integer)','f28f2ece809bd411c2b7402c8abc80de0c1c599a9faafe358ab7fd0de6c41e63','boolean')
 ) v(signature,digest,result_type) loop
  routine:=to_regprocedure(expected.signature);
  select * into p from pg_proc where oid=routine;
  if not found or p.proowner<>(select oid from pg_roles where rolname='postgres') or p.prosecdef
   or p.prolang<>(select oid from pg_language where lanname='plpgsql') or p.provolatile<>'i'
   or p.prorettype<>to_regtype(expected.result_type) or p.proconfig is distinct from array['search_path=pg_catalog']::text[]
   or encode(sha256(convert_to(pg_get_functiondef(routine),'UTF8')),'hex')<>expected.digest
   or (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
   or not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where a.grantee=p.proowner and a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
   or has_function_privilege('anon',routine,'EXECUTE') or has_function_privilege('authenticated',routine,'EXECUTE')
   or has_function_privilege('service_role',routine,'EXECUTE')
  then raise exception 'TEAM_PREREQUISITE_HELPER_PREDECESSOR_DIFFERS: %',expected.signature;end if;
  original_oids:=original_oids||jsonb_build_object(expected.signature,routine);
 end loop;
 grant execute on function public.fixed_service_end_v1(bigint,integer) to service_role;
 grant execute on function public.valid_monthly_fee_snapshot_v1(jsonb,integer) to service_role;
 -- Retain exact identity/body/owner/invoker and owner self access. Browser,
 -- grantable, inherited-only or any other ACL state is not this contract.
 for expected in select * from (values
  ('public.fixed_service_end_v1(bigint,integer)','6ab96f17f2b4f2f2a92c90082ea48c49ac16d6395c3a8d9eb1c887818d912f0d'),
  ('public.valid_monthly_fee_snapshot_v1(jsonb,integer)','f28f2ece809bd411c2b7402c8abc80de0c1c599a9faafe358ab7fd0de6c41e63')
 ) v(signature,digest) loop
  routine:=to_regprocedure(expected.signature);
  select * into p from pg_proc where oid=routine;
  if not found or routine is distinct from (original_oids->>expected.signature)::oid
   or p.proowner<>(select oid from pg_roles where rolname='postgres') or p.prosecdef
   or encode(sha256(convert_to(pg_get_functiondef(routine),'UTF8')),'hex')<>expected.digest
   or (select count(*) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
   or exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where
    a.grantee not in (p.proowner,(select oid from pg_roles where rolname='service_role'))
    or a.grantor<>p.proowner or a.privilege_type<>'EXECUTE' or a.is_grantable)
   or not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=p.proowner)
   or not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=(select oid from pg_roles where rolname='service_role'))
   or has_function_privilege('anon',routine,'EXECUTE') or has_function_privilege('authenticated',routine,'EXECUTE')
   or not has_function_privilege('service_role',routine,'EXECUTE')
   or not has_schema_privilege('service_role','public','USAGE')
  then raise exception 'TEAM_PREREQUISITE_HELPER_POSTCONDITION_DIFFERS: %',expected.signature;end if;
 end loop;
end $contract$;
commit;
