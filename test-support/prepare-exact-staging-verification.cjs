/* eslint-disable @typescript-eslint/no-require-imports -- Local SQL preparation only; no database/network execution. */
"use strict";
const { createHash } = require("node:crypto");
const { manifest, prepareStagingBundle } = require("./prepare-exact-staging-bundle.cjs");
const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const literal = text => `'${text.replace(/'/g, "''")}'`;
const compact = sql => sql.split(/\r?\n/).filter(line => !line.trimStart().startsWith("--")).map(line => line.trim()).filter(Boolean).join(" ");

function prepareExactVerification() {
  // Recheck every approved source checksum, not a discovered or inferred inventory.
  const bundle = prepareStagingBundle();
  const inventory = { relations: manifest.relations, functions: manifest.functions, triggers: manifest.triggers,
    legacyColumns: manifest.legacyColumns, legacyConstraints: manifest.legacyConstraints };
  const metadataSql = `-- READ ONLY. Verify original CreatorNet Staging in the UI separately.
-- Before/after metadata comparison only; no raw bodies, config values or application rows.
-- Legacy fingerprints exclude only manifest objects/marker and their new internal FK triggers.
-- Payment feature/environment flags cannot be verified from this SQL.
begin;
set transaction read only;
set local search_path = pg_catalog;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
with m as (select ${literal(JSON.stringify(inventory))}::jsonb as doc),
er as (select x->>0 name,x->>1 kind from m,jsonb_array_elements(doc->'relations') x),
ef as (select x->>0 signature,split_part(x->>0,'(',1) name,(x->>1)::boolean server_execute,(x->>2)::boolean definer
  from m,jsonb_array_elements(doc->'functions') x),
et as (select x->>0 table_name,x->>1 name,x->>2 routine,(x->>3)::smallint type from m,jsonb_array_elements(doc->'triggers') x),
roles as (
  select q.name,r.oid,r.rolsuper,r.rolbypassrls,
    coalesce((select jsonb_agg(s.rolname order by s.rolname) from pg_roles s where s.oid<>r.oid
      and (pg_has_role(r.oid,s.oid,'USAGE') or pg_has_role(r.oid,s.oid,'MEMBER') or pg_has_role(r.oid,s.oid,'SET'))),'[]'::jsonb) memberships
  from (values ('anon'),('authenticated'),('service_role')) q(name) left join pg_roles r on r.rolname=q.name
), exact_relations as (
  select e.name,e.kind expected_kind,c.oid is not null present,c.relkind::text actual_kind,
    pg_get_userbyid(c.relowner) owner,c.relrowsecurity rls,c.relforcerowsecurity force_rls,c.relispartition,
    (select count(*) from pg_inherits where inhrelid=c.oid or inhparent=c.oid) inheritance_edges,
    (select count(*) from pg_policy where polrelid=c.oid) policy_count
  from er e left join pg_class c on c.oid=to_regclass('public.'||quote_ident(e.name))
), exact_columns as (
  select e.name,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,a.attidentity,a.attgenerated,
    md5(coalesce(pg_get_expr(d.adbin,d.adrelid),'')) default_hash
  from er e join pg_attribute a on a.attrelid=to_regclass('public.'||quote_ident(e.name)) and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where e.kind='r'
), table_rights as (
  select e.name,r.name role,v.privilege,has_table_privilege(r.oid,c.oid,v.privilege) allowed,
    has_table_privilege(r.oid,c.oid,v.privilege||' WITH GRANT OPTION') grant_option
  from er e join pg_class c on c.oid=to_regclass('public.'||quote_ident(e.name)) cross join roles r
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(privilege)
  where e.kind='r' and r.oid is not null
), column_rights as (
  select e.name,r.name role,a.attname,v.privilege,has_column_privilege(r.oid,c.oid,a.attnum,v.privilege) allowed,
    has_column_privilege(r.oid,c.oid,a.attnum,v.privilege||' WITH GRANT OPTION') grant_option
  from er e join pg_class c on c.oid=to_regclass('public.'||quote_ident(e.name)) cross join roles r
  join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(privilege)
  where e.kind='r' and r.oid is not null
), exact_functions as (
  select e.signature,p.oid is not null present,p.prokind,pg_get_userbyid(p.proowner) owner,
    p.prosecdef definer,e.definer expected_definer,p.provolatile,
    case when p.prokind in ('f','p') then md5(pg_get_functiondef(p.oid)) end raw_definition_hash,
    case when p.prokind in ('f','p') then md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10))) end normalized_definition_hash,
    case when p.prokind in ('f','p') then length(pg_get_functiondef(p.oid))-length(replace(pg_get_functiondef(p.oid),chr(13),'')) end carriage_returns,
    cardinality(p.proconfig)=1 and regexp_replace(p.proconfig[1],'\\s','','g')='search_path=public,pg_temp' reviewed_search_path,
    md5(coalesce(array_to_string(p.proconfig,'|'),'')) configuration_hash,e.server_execute expected_server_execute,
    (select has_function_privilege(r.oid,p.oid,'EXECUTE') from roles r where r.name='anon') anon_execute,
    (select has_function_privilege(r.oid,p.oid,'EXECUTE') from roles r where r.name='authenticated') authenticated_execute,
    (select has_function_privilege(r.oid,p.oid,'EXECUTE') from roles r where r.name='service_role') server_execute,
    coalesce((select bool_or(has_function_privilege(r.oid,p.oid,'EXECUTE WITH GRANT OPTION')) from roles r where r.oid is not null),false) any_app_grant_option
  from ef e left join pg_proc p on p.oid=to_regprocedure('public.'||e.signature)
), exact_constraints as (
  select c.conrelid::regclass::text relation,c.conname,c.contype,c.convalidated,
    md5(pg_get_constraintdef(c.oid)) definition_hash
  -- PG18 additionally catalogs NOT NULL constraints; hosted PG17 does not.
  -- attnotnull is already covered in every exact column's fingerprint.
  from pg_constraint c where c.contype<>'n' and (c.conrelid in (select to_regclass('public.'||quote_ident(name)) from er where kind='r')
    or (c.conrelid=to_regclass('public.booking_payments') and c.conname='booking_payments_installment_collection_version_check'))
), exact_indexes as (
  select e.name,i.indisunique,i.indisvalid,i.indisready,md5(pg_get_indexdef(i.indexrelid)) definition_hash
  from er e join pg_index i on i.indexrelid=to_regclass('public.'||quote_ident(e.name)) where e.kind='i'
), exact_triggers as (
  select e.table_name,e.name,t.oid is not null present,t.tgtype,t.tgenabled,t.tgisinternal,
    t.tgfoid::regprocedure::text routine,e.type expected_type,'public.'||e.routine expected_routine,
    md5(pg_get_triggerdef(t.oid)) definition_hash
  from et e left join pg_trigger t on t.tgrelid=to_regclass('public.'||e.table_name) and t.tgname=e.name
), marker as (
  select a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,a.atthasdef
  from pg_attribute a where a.attrelid=to_regclass('public.booking_payments')
    and a.attname='installment_collection_version' and a.attnum>0 and not a.attisdropped
), legacy_relations as (
  select c.* from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and not exists(select 1 from er where name=c.relname)
), legacy_rows as (
  select 'relation' kind,c.relname::text name,jsonb_build_object('kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
    'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'partition',c.relispartition,
    'acl',(select jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(x.grantor),'grantee',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee)::text end,
      'privilege',x.privilege_type,'grant_option',x.is_grantable) order by x.grantee,x.grantor,x.privilege_type)
      from aclexplode(c.relacl) x)) details from legacy_relations c
  union all
  select 'column',c.relname||'.'||a.attname,jsonb_build_object('number',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
    'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
    'default_hash',md5(coalesce(pg_get_expr(d.adbin,d.adrelid),'')),'acl',a.attacl::text)
  from legacy_relations c join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where not(c.relname='booking_payments' and a.attname='installment_collection_version')
  union all
  select 'constraint',c.relname||'.'||x.conname,jsonb_build_object('valid',x.convalidated,'definition_hash',md5(pg_get_constraintdef(x.oid)))
  from legacy_relations c join pg_constraint x on x.conrelid=c.oid
  where not(c.relname='booking_payments' and x.conname='booking_payments_installment_collection_version_check')
  union all
  select 'index',c.relname||'.'||i.indexrelid::regclass::text,jsonb_build_object('valid',i.indisvalid,'ready',i.indisready,'definition_hash',md5(pg_get_indexdef(i.indexrelid)))
  from legacy_relations c join pg_index i on i.indrelid=c.oid
  union all
  select 'policy',c.relname||'.'||p.polname,jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
    'roles',array(select case when r=0 then 'PUBLIC' else pg_get_userbyid(r)::text end from unnest(p.polroles) r order by 1),
    'using_hash',md5(coalesce(pg_get_expr(p.polqual,p.polrelid),'')),'check_hash',md5(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')))
  from legacy_relations c join pg_policy p on p.polrelid=c.oid
  union all
  select 'trigger',c.relname||'.'||t.tgname,jsonb_build_object('enabled',t.tgenabled,'internal',t.tgisinternal,'type',t.tgtype,
    'routine',t.tgfoid::regprocedure::text,'definition_hash',md5(pg_get_triggerdef(t.oid)))
  from legacy_relations c join pg_trigger t on t.tgrelid=c.oid
  where not exists(select 1 from et where table_name=c.relname and name=t.tgname)
    and not exists(select 1 from pg_constraint co join er e on co.conrelid=to_regclass('public.'||quote_ident(e.name))
      where e.kind='r' and t.tgisinternal and t.tgconstraint=co.oid)
  union all
  select 'routine',p.oid::regprocedure::text,jsonb_build_object('owner',pg_get_userbyid(p.proowner),'kind',p.prokind,'definer',p.prosecdef,
    'normalized_hash',case when p.prokind in ('f','p') then md5(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10))) end,
    'config_hash',md5(coalesce(array_to_string(p.proconfig,'|'),'')),'acl',p.proacl::text)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and not exists(select 1 from ef where name=p.proname)
)
select jsonb_build_object(
  'observation',jsonb_build_object('at',clock_timestamp(),'role',current_user,'read_only',current_setting('transaction_read_only'),
    'server_version',current_setting('server_version_num'),'search_path',current_setting('search_path'),
    'superuser',(select rolsuper from pg_roles where rolname=current_user),'bypassrls',(select rolbypassrls from pg_roles where rolname=current_user)),
  'bundle_sha256',${literal(bundle.sha256)},'manifest_sha256',${literal(bundle.manifestSha256)},
  'roles',(select jsonb_agg((to_jsonb(r)-'oid')||jsonb_build_object('present',r.oid is not null) order by name) from roles r),
  'relations',(select jsonb_agg(to_jsonb(r) order by name) from exact_relations r),
  'broad_exact_relations',coalesce((select jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind) order by c.relname)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'exact\\_installment\\_%' escape '\\'),'[]'::jsonb),
  'function_name_inventory',coalesce((select jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in(select name from ef)),'[]'::jsonb),
  'functions',(select jsonb_agg(to_jsonb(f) order by signature) from exact_functions f),
  'table_acl_conditions',coalesce((select jsonb_agg(to_jsonb(x) order by name,role) from (
    select name,role,count(*) privileges_checked,bool_and(allowed=(role='service_role' and privilege='SELECT') and not grant_option) expected_access
    from table_rights group by name,role) x),'[]'::jsonb),
  'column_acl_conditions',coalesce((select jsonb_agg(to_jsonb(x) order by name,role) from (
    select name,role,count(*) privileges_checked,bool_and(allowed=(role='service_role' and privilege='SELECT') and not grant_option) expected_access
    from column_rights group by name,role) x),'[]'::jsonb),
  'columns_fingerprint',jsonb_build_object('count',(select count(*) from exact_columns),
    'hash',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by name,attnum),'[]'::jsonb)::text) from exact_columns x)),
  'constraints_fingerprint',jsonb_build_object('scope','Excludes PG18-only pg_constraint NOT NULL rows; attnotnull is covered by columns_fingerprint',
    'count',(select count(*) from exact_constraints),
    'all_validated',(select bool_and(convalidated) from exact_constraints),
    'hash',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by relation,conname),'[]'::jsonb)::text) from exact_constraints x)),
  'indexes',(select coalesce(jsonb_agg(to_jsonb(x) order by name),'[]'::jsonb) from exact_indexes x),
  'triggers',(select jsonb_agg(to_jsonb(x) order by table_name,name) from exact_triggers x),
  'booking_marker',coalesce((select to_jsonb(x) from marker x),'null'::jsonb),
  'legacy_fingerprints',(select jsonb_agg(to_jsonb(x) order by kind) from (
    select kind,count(*) object_count,md5(jsonb_agg(to_jsonb(r) order by name)::text) hash from legacy_rows r group by kind) x),
  'limits','Metadata only. Empty-table EXISTS query is separate; database metadata cannot establish deployment feature flags or application acceptance.'
) as exact_verification;
rollback;
`;
  const tables = manifest.relations.filter(([, kind]) => kind === "r").map(([name]) => name);
  if (tables.some(name => !/^exact_installment_[a-z_]+$/.test(name))) throw new Error("Review table identifier drift");
  const emptySql = `-- Aggregate existence only in the sixteen new tables, never legacy/customer row output.
-- Run ONLY after metadata confirms all targets ordinary, unpartitioned RLS tables.
-- A complete result also requires owner/superuser/BYPASSRLS context; row_security=off
-- fails on policies that would otherwise hide rows. Missing targets fail, not PASS.
begin;
set transaction read only;
set local search_path = pg_catalog;
set local row_security = off;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
select jsonb_build_object('at',clock_timestamp(),'role',current_user,'read_only',current_setting('transaction_read_only'),
  'bypassrls',(select rolbypassrls from pg_roles where rolname=current_user),'superuser',(select rolsuper from pg_roles where rolname=current_user),
  'tables',jsonb_build_object(${tables.map(name => `${literal(name)},not exists(select 1 from public."${name}")`).join(",\n    ")})) as exact_tables_empty;
rollback;
`;
  return Object.freeze({ metadataSql, emptySql, metadataSha256: hash(metadataSql), emptySha256: hash(emptySql),
    compactMetadataSql: compact(metadataSql), compactEmptySql: compact(emptySql),
    compactMetadataSha256: hash(compact(metadataSql)), compactEmptySha256: hash(compact(emptySql)),
    bundleSha256: bundle.sha256, manifestSha256: bundle.manifestSha256 });
}
module.exports = { prepareExactVerification };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--summary", "--metadata", "--empty"].includes(args[0])) {
    process.stderr.write("Local read-only preparation: --summary|--metadata|--empty\n"); process.exitCode = 2;
  } else {
    const v = prepareExactVerification();
    process.stdout.write(args[0] === "--metadata" ? v.metadataSql : args[0] === "--empty" ? v.emptySql : JSON.stringify({
      bundleSha256: v.bundleSha256, manifestSha256: v.manifestSha256,
      metadata: { sha256: v.metadataSha256, bytes: Buffer.byteLength(v.metadataSql), compactSha256: v.compactMetadataSha256, compactBytes: Buffer.byteLength(v.compactMetadataSql) },
      empty: { sha256: v.emptySha256, bytes: Buffer.byteLength(v.emptySql), compactSha256: v.compactEmptySha256, compactBytes: Buffer.byteLength(v.compactEmptySql) }
    }, null, 2) + "\n");
  }
}
