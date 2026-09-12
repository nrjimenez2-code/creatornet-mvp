-- STAGED PREREQUISITE ONLY. Preparation/merge is not execution authorization.
-- Separately confirm CreatorNet Staging / nwqfofezfzljhxolkycz in the dashboard
-- and obtain approval for this exact artifact. Never infer project identity
-- from these SQL results. No production execution or historical migration replay.
--
-- Source observation: 2026-09-08T05:48:46.107016Z, PG 170006, purchases RLS on;
-- anon/authenticated had every tested non-read table privilege, no grant option.
-- Detail recheck 2026-09-08T06:14:19.629527Z: direct anon/authenticated/postgres/
-- service_role grants all came from postgres; no PUBLIC or independent column
-- ACL entries, and no inherited client roles. Thirteen existing policies and
-- trg_purchases_fill_ids (public.purchases_fill_ids(), enabled type23) remain
-- untouched by this artifact. Unseen PUBLIC non-read grants or non-owner client
-- grant provenance require fresh review; this script refuses them before REVOKE.
-- This file accepts that effective baseline OR an already-closed replay state.
-- Unexplained partial/grant-option drift fails before REVOKE. Provenance and
-- existing policies were inspected at 06:14Z; recheck the target before execution.
--
-- Only PUBLIC/anon/authenticated non-read purchase table/column ACLs change.
-- SELECT grants (including column grants/grant options), policies, structure,
-- triggers, existing server rights and rows are not changed. No purchase data
-- rows are read; only system-catalog metadata is inspected.
-- Actual column names come from the locked catalog; no invented 44-column DDL.
-- Inherited privileges are checked after REVOKE, never repaired with role changes
-- or CASCADE. Any exception rolls the transaction back; do not skip the checks.
begin;
set local search_path = pg_catalog;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

do $purchase_acl_prerequisite$
declare
  purchase_table regclass := to_regclass('public.purchases');
  purchase_owner oid;
  caller text;
  privilege_name text;
  required_column record;
  observed_full boolean;
  already_closed boolean;
  allowed boolean;
  columns_sql text;
  invariant_before jsonb;
  invariant_after jsonb;
  invariant_sql constant text := $invariants$
    select jsonb_build_object(
      'relation',jsonb_build_object('oid',c.oid,'owner',c.relowner,'kind',c.relkind,
        'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'partition',c.relispartition),
      'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'number',a.attnum,
        'type',a.atttypid,'typmod',a.atttypmod,'not_null',a.attnotnull,'identity',a.attidentity,
        'generated',a.attgenerated,'default_hash',md5(coalesce(pg_get_expr(d.adbin,d.adrelid),''))) order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
      'constraints',(select coalesce(jsonb_agg(jsonb_build_object('name',co.conname,'validated',co.convalidated,
        'definition_hash',md5(pg_get_constraintdef(co.oid))) order by co.conname),'[]'::jsonb)
        from pg_constraint co where co.conrelid=c.oid),
      'indexes',(select coalesce(jsonb_agg(jsonb_build_object('oid',i.indexrelid,'valid',i.indisvalid,'ready',i.indisready,
        'definition_hash',md5(pg_get_indexdef(i.indexrelid))) order by i.indexrelid),'[]'::jsonb)
        from pg_index i where i.indrelid=c.oid),
      'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.polname),'[]'::jsonb)
        from pg_policy p where p.polrelid=c.oid),
      'triggers',(select coalesce(jsonb_agg(jsonb_build_object('oid',t.oid,'name',t.tgname,'enabled',t.tgenabled,
        'definition_hash',md5(pg_get_triggerdef(t.oid))) order by t.tgname),'[]'::jsonb)
        from pg_trigger t where t.tgrelid=c.oid),
      'select_acl',(select coalesce(jsonb_agg(to_jsonb(s) order by s.column_number,s.grantee,s.grantor),'[]'::jsonb) from (
        select 0 as column_number,x.grantor,x.grantee,x.is_grantable
        from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x where x.privilege_type='SELECT'
        union all
        select a.attnum,x.grantor,x.grantee,x.is_grantable
        from pg_attribute a cross join lateral aclexplode(a.attacl) x
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped and x.privilege_type='SELECT'
      ) s),
      'effective_reads',(select jsonb_agg(jsonb_build_object('role',r.rolname,
        'table_select',has_table_privilege(r.oid,c.oid,'SELECT'),
        'table_select_grant_option',has_table_privilege(r.oid,c.oid,'SELECT WITH GRANT OPTION'),
        'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,
          'select',has_column_privilege(r.oid,c.oid,a.attnum,'SELECT'),
          'grant_option',has_column_privilege(r.oid,c.oid,a.attnum,'SELECT WITH GRANT OPTION')) order by a.attnum)
          from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)) order by r.rolname)
        from pg_roles r where r.rolname in ('anon','authenticated','service_role')),
      'server_table_rights',(select jsonb_agg(jsonb_build_object('privilege',v.name,
        'allowed',has_table_privilege('service_role',c.oid,v.name),
        'grant_option',has_table_privilege('service_role',c.oid,v.name||' WITH GRANT OPTION')) order by v.name)
        from (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(name)),
      'server_column_rights',(select jsonb_agg(jsonb_build_object('column',a.attname,'privilege',v.name,
        'allowed',has_column_privilege('service_role',c.oid,a.attnum,v.name),
        'grant_option',has_column_privilege('service_role',c.oid,a.attnum,v.name||' WITH GRANT OPTION')) order by a.attnum,v.name)
        from pg_attribute a cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(name)
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)
    ) from pg_class c where c.oid='public.purchases'::regclass
  $invariants$;
begin
  if current_setting('server_version_num')::integer < 170000 then
    raise exception 'Purchase ACL prerequisite requires reviewed PostgreSQL 17+ MAINTAIN privileges';
  end if;
  if purchase_table is null or not exists(select 1 from pg_class where oid=purchase_table
    and relkind='r' and relrowsecurity and not relispartition) then
    raise exception 'Purchase ACL prerequisite requires an existing ordinary RLS-enabled purchases table';
  end if;
  -- Bounded staging lock keeps concurrent DML/DDL outside the comparison window.
  lock table public.purchases in access exclusive mode;
  select relowner into purchase_owner from pg_class where oid=purchase_table;
  if purchase_owner<>(select oid from pg_roles where rolname=current_user) then
    raise exception 'Purchase ACL prerequisite must run as the reviewed table owner';
  end if;
  if exists(select 1 from pg_inherits where inhrelid=purchase_table or inhparent=purchase_table) then
    raise exception 'Purchase ACL prerequisite does not cover inherited/partitioned relations';
  end if;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role'))<>3 then
    raise exception 'Purchase ACL prerequisite requires the three existing application roles';
  end if;
  foreach caller in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=caller and (rolsuper or rolbypassrls))
      or pg_has_role(caller,purchase_owner,'MEMBER') then
      raise exception 'Purchase ACL prerequisite refuses client ownership/bypass inheritance';
    end if;
    if exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=caller)) then
      raise exception 'Purchase ACL prerequisite refuses unreviewed client role membership';
    end if;
  end loop;
  if exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
      where c.oid=purchase_table and x.grantee=0 and x.privilege_type<>'SELECT')
    or exists(select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) x
      where a.attrelid=purchase_table and a.attnum>0 and not a.attisdropped
        and x.grantee=0 and x.privilege_type<>'SELECT') then
    raise exception 'Purchase ACL prerequisite unseen PUBLIC write grants; review provenance before any repair';
  end if;
  if exists(select 1 from pg_class c cross join lateral aclexplode(c.relacl) x
      where c.oid=purchase_table and x.grantee in(select oid from pg_roles where rolname in ('anon','authenticated'))
        and x.privilege_type<>'SELECT' and x.grantor<>purchase_owner)
    or exists(select 1 from pg_attribute a cross join lateral aclexplode(a.attacl) x
      where a.attrelid=purchase_table and a.attnum>0 and not a.attisdropped
        and x.grantee in(select oid from pg_roles where rolname in ('anon','authenticated'))
        and x.privilege_type<>'SELECT' and x.grantor<>purchase_owner) then
    raise exception 'Purchase ACL prerequisite unreviewed client grant provenance';
  end if;
  for required_column in select * from (values
    ('id','uuid'),('buyer_id','uuid'),('post_id','uuid'),('access_granted','boolean'),('status','text')
  ) q(name,type_name) loop
    if not exists(select 1 from pg_attribute where attrelid=purchase_table and attnum>0 and not attisdropped
      and attname=required_column.name and format_type(atttypid,atttypmod)=required_column.type_name) then
      raise exception 'Purchase ACL prerequisite core column/type drift: %',required_column.name;
    end if;
  end loop;
  foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE'] loop
    if not has_table_privilege('service_role',purchase_table,privilege_name) then
      raise exception 'Purchase ACL prerequisite requires existing server CRUD: %',privilege_name;
    end if;
  end loop;
  foreach caller in array array['anon','authenticated'] loop
    observed_full := true;
    already_closed := true;
    foreach privilege_name in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      allowed := has_table_privilege(caller,purchase_table,privilege_name);
      observed_full := observed_full and allowed;
      already_closed := already_closed and not allowed;
      if has_table_privilege(caller,purchase_table,privilege_name||' WITH GRANT OPTION') then
        raise exception 'Purchase ACL prerequisite refuses unreviewed client write grant options';
      end if;
    end loop;
    foreach privilege_name in array array['INSERT','UPDATE','REFERENCES'] loop
      already_closed := already_closed and not has_any_column_privilege(caller,purchase_table,privilege_name);
      if has_any_column_privilege(caller,purchase_table,privilege_name||' WITH GRANT OPTION') then
        raise exception 'Purchase ACL prerequisite refuses unreviewed client column grant options';
      end if;
    end loop;
    if not observed_full and not already_closed then
      raise exception 'Purchase ACL prerequisite baseline drift: expected observed full grants or closed replay, role %',caller;
    end if;
  end loop;

  execute invariant_sql into invariant_before;
  revoke insert,update,delete,truncate,references,trigger,maintain on table public.purchases from public,anon,authenticated;
  select string_agg(quote_ident(attname),',' order by attnum) into columns_sql
    from pg_attribute where attrelid=purchase_table and attnum>0 and not attisdropped;
  execute format('revoke insert (%s),update (%s),references (%s) on table public.purchases from public,anon,authenticated',
    columns_sql,columns_sql,columns_sql);

  foreach caller in array array['anon','authenticated'] loop
    foreach privilege_name in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if has_table_privilege(caller,purchase_table,privilege_name) then
        raise exception 'Purchase ACL prerequisite inherited table writes remain; review role grants, do not use CASCADE';
      end if;
    end loop;
    foreach privilege_name in array array['INSERT','UPDATE','REFERENCES'] loop
      if has_any_column_privilege(caller,purchase_table,privilege_name) then
        raise exception 'Purchase ACL prerequisite inherited column writes remain; review role grants, do not use CASCADE';
      end if;
    end loop;
  end loop;
  execute invariant_sql into invariant_after;
  if invariant_after is distinct from invariant_before then
    raise exception 'Purchase ACL prerequisite invariant changed: SELECT/server access or catalog; complete rollback required';
  end if;
end;
$purchase_acl_prerequisite$;
commit;

-- No broad rollback grants are supplied: restoring client writes would reopen
-- the removed permission path. Any recovery or new drift requires a separately
-- reviewed action. Follow installation with independent metadata and staging
-- application checks; this ACL-only change does not rewrite permissive policies.
