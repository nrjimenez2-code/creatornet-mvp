-- Read-only original-staging detail review; not a migration or RPC invocation.
-- Verify CreatorNet Staging / nwqfofezfzljhxolkycz in the dashboard separately.
-- Only three exact routine definitions and related catalog policies/ACLs are
-- returned. No application rows, credentials, settings or financial calls.
begin;
set transaction read only;
set local search_path = pg_catalog;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
with target_functions(signature) as (
  values ('public.set_profile_rating(uuid,uuid,integer)'),
    ('public.update_profile_rating(uuid)'),('public.update_reviews_updated_at()')
), routines as (
  select t.signature,p.oid is not null as present,pg_get_userbyid(p.proowner) as owner,
    p.prosecdef,p.provolatile,p.prokind,
    md5(pg_get_functiondef(p.oid)) as definition_fingerprint,
    pg_get_functiondef(p.oid) as definition
  from target_functions t left join pg_proc p on p.oid=to_regprocedure(t.signature)
), function_acl as (
  select t.signature,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
    pg_get_userbyid(a.grantor) as grantor,a.privilege_type,a.is_grantable
  from target_functions t join pg_proc p on p.oid=to_regprocedure(t.signature)
  cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
), purchase_acl as (
  select case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
    pg_get_userbyid(a.grantor) as grantor,a.privilege_type,a.is_grantable
  from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid=to_regclass('public.purchases')
), purchase_column_acl as (
  select col.attname,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
    pg_get_userbyid(a.grantor) as grantor,a.privilege_type,a.is_grantable
  from pg_attribute col cross join lateral aclexplode(col.attacl) a
  where col.attrelid=to_regclass('public.purchases') and col.attnum>0 and not col.attisdropped
), purchase_policies as (
  select polname,polcmd,polpermissive,
    array(select case when r=0 then 'PUBLIC' else pg_get_userbyid(r) end from unnest(polroles) r) as roles,
    pg_get_expr(polqual,polrelid) as using_expression,
    pg_get_expr(polwithcheck,polrelid) as check_expression
  from pg_policy where polrelid=to_regclass('public.purchases')
), inherited_roles as (
  select c.rolname as client_role,r.rolname as inherited_role,r.rolsuper,r.rolbypassrls,
    pg_has_role(c.oid,r.oid,'USAGE') as inherited_usage,
    pg_has_role(c.oid,r.oid,'MEMBER') as member,
    pg_has_role(c.oid,r.oid,'SET') as can_set_role
  from pg_roles c cross join pg_roles r
  where c.rolname in ('anon','authenticated') and c.oid<>r.oid
    and (pg_has_role(c.oid,r.oid,'USAGE') or pg_has_role(c.oid,r.oid,'MEMBER') or pg_has_role(c.oid,r.oid,'SET'))
), triggers as (
  select c.relname,t.tgname,t.tgtype,t.tgenabled,t.tgfoid::regprocedure::text as routine
  from pg_trigger t join pg_class c on c.oid=t.tgrelid
  where c.oid in (to_regclass('public.purchases'),to_regclass('public.profile_reviews'),to_regclass('public.reviews'))
    and not t.tgisinternal
)
select jsonb_build_object(
  'observed_at',clock_timestamp(),'transaction_read_only',current_setting('transaction_read_only'),
  'inspected_role',current_user,
  'routines',coalesce((select jsonb_agg(to_jsonb(r) order by signature) from routines r),'[]'::jsonb),
  'function_acl',coalesce((select jsonb_agg(to_jsonb(r) order by signature,grantee,privilege_type) from function_acl r),'[]'::jsonb),
  'purchase_acl',coalesce((select jsonb_agg(to_jsonb(r) order by grantee,privilege_type) from purchase_acl r),'[]'::jsonb),
  'purchase_column_acl',coalesce((select jsonb_agg(to_jsonb(r) order by attname,grantee,privilege_type) from purchase_column_acl r),'[]'::jsonb),
  'purchase_policies',coalesce((select jsonb_agg(to_jsonb(r) order by polname) from purchase_policies r),'[]'::jsonb),
  'client_inherited_roles',coalesce((select jsonb_agg(to_jsonb(r) order by client_role,inherited_role) from inherited_roles r),'[]'::jsonb),
  'related_triggers',coalesce((select jsonb_agg(to_jsonb(r) order by relname,tgname) from triggers r),'[]'::jsonb)
) as prerequisite_detail;
rollback;
