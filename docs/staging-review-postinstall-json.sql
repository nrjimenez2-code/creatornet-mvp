-- Independent metadata-only observation; safe before/between/after the three units.
-- Confirm original CreatorNet Staging / nwqfofezfzljhxolkycz in the UI separately.
-- No application rows, RPC invocation, raw bodies/configurations or external calls.
-- No overall PASS: compare each unit's conditions and unchanged metadata to its
-- immediately preceding observation. Metadata does not prove row preservation,
-- running Preview compatibility, purchase-policy safety or end-to-end acceptance.
begin;
set transaction read only;
set local search_path = pg_catalog;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

with role_rows as (
  select q.name,r.oid,r.rolsuper,r.rolbypassrls,r.rolinherit,
    coalesce((select jsonb_agg(s.rolname order by s.rolname) from pg_roles s
      where r.oid<>s.oid and (pg_has_role(r.oid,s.oid,'USAGE')
        or pg_has_role(r.oid,s.oid,'MEMBER') or pg_has_role(r.oid,s.oid,'SET'))),'[]'::jsonb) as memberships
  from (values ('anon'),('authenticated'),('service_role')) q(name)
  left join pg_roles r on r.rolname=q.name
), relation_rows as (
  select q.name,c.oid,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,
    pg_get_userbyid(c.relowner) as owner,
    (select count(*) from pg_inherits where inhrelid=c.oid or inhparent=c.oid) as inheritance_edges
  from (values ('purchases'),('reviews'),('profile_reviews')) q(name)
  left join pg_class c on c.oid=to_regclass('public.'||q.name)
), columns as (
  select r.name,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) as type,
    a.attnotnull,a.attidentity,a.attgenerated,
    md5(coalesce(pg_get_expr(d.adbin,d.adrelid),'')) as default_hash
  from relation_rows r join pg_attribute a on a.attrelid=r.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
), constraints as (
  select r.name,c.conname,c.contype,c.convalidated,md5(pg_get_constraintdef(c.oid)) as definition_hash
  from relation_rows r join pg_constraint c on c.conrelid=r.oid
), indexes as (
  select r.name,i.indexrelid::regclass::text as index_name,i.indisunique,i.indisvalid,i.indisready,
    md5(pg_get_indexdef(i.indexrelid)) as definition_hash
  from relation_rows r join pg_index i on i.indrelid=r.oid
), policies as (
  select r.name,p.polname,p.polcmd,p.polpermissive,
    array(select case when x=0 then 'PUBLIC' else pg_get_userbyid(x)::text end
      from unnest(p.polroles) x order by 1) as roles,
    md5(coalesce(pg_get_expr(p.polqual,p.polrelid),'')) as using_hash,
    md5(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) as check_hash
  from relation_rows r join pg_policy p on p.polrelid=r.oid
), triggers as (
  select r.name,t.tgname,t.tgtype,t.tgenabled,t.tgisinternal,t.tgfoid::regprocedure::text as routine,
    md5(pg_get_triggerdef(t.oid)) as definition_hash,
    pg_get_userbyid(p.proowner) as routine_owner,p.prosecdef,
    md5(pg_get_functiondef(p.oid)) as routine_hash
  from relation_rows r join pg_trigger t on t.tgrelid=r.oid join pg_proc p on p.oid=t.tgfoid
), table_rights as (
  select r.name as relation,q.name as role,v.privilege,
    has_table_privilege(q.oid,r.oid,v.privilege) as allowed,
    has_table_privilege(q.oid,r.oid,v.privilege||' WITH GRANT OPTION') as grant_option
  from relation_rows r cross join role_rows q
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),('MAINTAIN')) v(privilege)
  where r.name in ('purchases','reviews') and r.oid is not null and q.oid is not null
), column_rights as (
  select r.name as relation,q.name as role,a.attname as column_name,v.privilege,
    has_column_privilege(q.oid,r.oid,a.attnum,v.privilege) as allowed,
    has_column_privilege(q.oid,r.oid,a.attnum,v.privilege||' WITH GRANT OPTION') as grant_option
  from relation_rows r cross join role_rows q
  join pg_attribute a on a.attrelid=r.oid and a.attnum>0 and not a.attisdropped
  cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(privilege)
  where r.name in ('purchases','reviews') and q.oid is not null
), direct_select_acl as (
  select r.name,0::integer as column_number,case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee)::text end as grantee,
    pg_get_userbyid(x.grantor) as grantor,x.is_grantable
  from relation_rows r join pg_class c on c.oid=r.oid
  cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x where x.privilege_type='SELECT'
  union all
  select r.name,a.attnum,case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee)::text end,
    pg_get_userbyid(x.grantor),x.is_grantable
  from relation_rows r join pg_attribute a on a.attrelid=r.oid and a.attnum>0 and not a.attisdropped
  cross join lateral aclexplode(a.attacl) x where x.privilege_type='SELECT'
), routine_targets(signature,baseline_hash) as (
  values ('public.set_profile_rating(uuid,uuid,integer)','b6226e332c914d732797d070f96dbcd4'),
    ('public.update_profile_rating(uuid)','28b76574231e2111b6404f1fe3abe0fa'),
    ('public.update_reviews_updated_at()','0807db4d0620b1265247ce2c36933afe'),
    ('public.can_review_purchased_post(uuid,uuid)',null),('public.keep_review_identity()',null)
), routines as (
  select t.signature,p.oid is not null as present,pg_get_userbyid(p.proowner) as owner,
    p.prokind,p.prosecdef,p.provolatile,
    case when p.prokind='f' then md5(pg_get_functiondef(p.oid)) end as definition_hash,
    case when p.prokind='f' and t.baseline_hash is not null then md5(pg_get_functiondef(p.oid))=t.baseline_hash end as matches_captured_definition,
    p.proconfig=array['search_path=pg_catalog'] as only_pg_catalog_config,
    md5(coalesce(array_to_string(p.proconfig,'|'),'')) as configuration_hash,
    (select jsonb_agg(jsonb_build_object('role',q.name,'execute',has_function_privilege(q.oid,p.oid,'EXECUTE'),
      'grant_option',has_function_privilege(q.oid,p.oid,'EXECUTE WITH GRANT OPTION')) order by q.name)
      from role_rows q where q.oid is not null) as effective_execute,
    (select coalesce(jsonb_agg(jsonb_build_object('grantee',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee)::text end,
      'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grant_option',x.is_grantable)
      order by x.grantee,x.grantor),'[]'::jsonb)
      from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x) as direct_acl
  from routine_targets t left join pg_proc p on p.oid=to_regprocedure(t.signature)
), unit_conditions as (
  select
    (select count(*)=2 and bool_and(not rolsuper and not rolbypassrls and memberships='[]'::jsonb)
      from role_rows where name in ('anon','authenticated') and oid is not null) as client_roles_safe,
    (select count(*)=16 and bool_and(allowed=(privilege='SELECT') and not grant_option)
      from table_rights where relation='purchases' and role in ('anon','authenticated')) as purchase_clients_select_only_table,
    (select count(*)>0 and bool_and(allowed=(privilege='SELECT') and not grant_option)
      from column_rights where relation='purchases' and role in ('anon','authenticated')) as purchase_clients_select_only_columns,
    (select count(*)=8 and bool_and(allowed and not grant_option)
      from table_rights where relation='purchases' and role='service_role') as purchase_server_all_eight_preserved,
    (select count(*)>0 and bool_and(allowed and not grant_option)
      from column_rights where relation='purchases' and role='service_role') as purchase_server_columns_preserved,
    (select count(*)=16 and bool_and(allowed=(privilege='SELECT' or (role='authenticated' and privilege='DELETE')) and not grant_option)
      from table_rights where relation='reviews' and role in ('anon','authenticated')) as reviews_final_client_table_allowlist,
    (select count(*)=64 and bool_and(allowed=(privilege='SELECT' or (role='authenticated' and privilege in ('INSERT','UPDATE')
        and column_name in ('reviewer_id','creator_id','post_id','rating','comment','updated_at'))) and not grant_option)
      from column_rights where relation='reviews' and role in ('anon','authenticated')) as reviews_final_column_allowlist,
    (select count(*)=4 and bool_and(allowed) from table_rights where relation='reviews' and role='service_role'
      and privilege in ('SELECT','INSERT','UPDATE','DELETE')) as reviews_server_crud,
    exists(select 1 from columns where name='reviews' and attname='post_id' and type='uuid' and not attnotnull) as reviews_nullable_post_uuid,
    exists(select 1 from pg_constraint c where c.conrelid=to_regclass('public.reviews') and c.confrelid=to_regclass('public.posts')
      and c.contype='f' and c.convalidated and c.confdeltype='c'
      and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='post_id' and not attisdropped)]::smallint[]
      and c.confkey=array[(select attnum from pg_attribute where attrelid=c.confrelid and attname='id' and not attisdropped)]::smallint[]) as reviews_validated_post_fk,
    exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.reviews_reviewer_post_unique')
      and i.indrelid=to_regclass('public.reviews') and i.indisunique and i.indisvalid and i.indisready
      and i.indnkeyatts=2 and i.indnatts=2 and pg_get_indexdef(i.indexrelid,1,true)='reviewer_id'
      and pg_get_indexdef(i.indexrelid,2,true)='post_id' and pg_get_expr(i.indpred,i.indrelid)='(post_id IS NOT NULL)') as reviews_per_post_unique,
    not exists(select 1 from pg_constraint c where c.conrelid=to_regclass('public.reviews') and c.contype='u'
      and pg_get_constraintdef(c.oid)='UNIQUE (reviewer_id, creator_id)') as reviews_legacy_unique_absent,
    (select count(*)=3 from policies where name='reviews' and not polpermissive and roles=array['authenticated']::text[]
      and ((polname='reviews_purchase_insert_fence' and polcmd='a') or (polname='reviews_purchase_update_fence' and polcmd='w')
        or (polname='reviews_owner_delete_fence' and polcmd='d'))) as reviews_three_restrictive_fence_shapes
)
select jsonb_build_object(
  'observation',jsonb_build_object('observed_at',clock_timestamp(),'role',current_user,
    'read_only',current_setting('transaction_read_only'),'search_path',current_setting('search_path'),
    'statement_timeout',current_setting('statement_timeout'),'lock_timeout',current_setting('lock_timeout'),
    'server_version_num',current_setting('server_version_num'),
    'superuser',(select rolsuper from pg_roles where rolname=current_user),
    'bypassrls',(select rolbypassrls from pg_roles where rolname=current_user)),
  'scope','Stage-aware metadata conditions only; false before its unit is expected. No overall or row-preservation PASS.',
  'conditions',(select to_jsonb(c) from unit_conditions c),
  'roles',(select jsonb_agg((to_jsonb(r)-'oid')||jsonb_build_object('present',r.oid is not null) order by name) from role_rows r),
  'relations',(select jsonb_agg(jsonb_build_object('name',r.name,'present',r.oid is not null,'kind',r.relkind,
    'owner',r.owner,'rls',r.relrowsecurity,'force_rls',r.relforcerowsecurity,'partition',r.relispartition,'inheritance_edges',r.inheritance_edges,
    'column_count',(select count(*) from columns x where x.name=r.name),
    'columns_hash',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.attnum),'[]'::jsonb)::text) from columns x where x.name=r.name),
    'constraints_hash',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.conname),'[]'::jsonb)::text) from constraints x where x.name=r.name),
    'indexes_hash',(select md5(coalesce(jsonb_agg(to_jsonb(x) order by x.index_name),'[]'::jsonb)::text) from indexes x where x.name=r.name),
    'select_acl',coalesce((select jsonb_agg(to_jsonb(x)-'name' order by x.column_number,x.grantee,x.grantor) from direct_select_acl x where x.name=r.name),'[]'::jsonb)) order by r.name) from relation_rows r),
  'policies',coalesce((select jsonb_agg(to_jsonb(x) order by name,polname) from policies x),'[]'::jsonb),
  'triggers',coalesce((select jsonb_agg(to_jsonb(x) order by name,tgname) from triggers x),'[]'::jsonb),
  'table_rights',coalesce((select jsonb_agg(to_jsonb(x) order by relation,role,privilege) from table_rights x),'[]'::jsonb),
  'column_rights_summary',(select jsonb_agg(to_jsonb(x) order by relation,role,privilege) from (
    select relation,role,privilege,count(*) as column_count,count(*) filter(where allowed) as allowed_count,
      count(*) filter(where grant_option) as grant_option_count,
      md5(jsonb_agg(to_jsonb(c) order by column_name)::text) as fingerprint
    from column_rights c group by relation,role,privilege) x),
  'routines',(select jsonb_agg(to_jsonb(r) order by signature) from routines r)
) as postinstall;
rollback;
