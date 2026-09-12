-- REVIEW ONLY: not executed by preparation. Confirm the Supabase UI project is
-- original CreatorNet Staging (nwqfofezfzljhxolkycz) before a separate run.
-- SQL results alone do not establish project identity. No customer rows,
-- credentials, function bodies, settings changes or application RPCs are read.
-- Compare every result with corrected 026; missing/drifted evidence means STOP.
begin;
set transaction read only;
set local search_path = pg_catalog;
set local statement_timeout = '30s';
set local lock_timeout = '5s';

select current_user as inspected_role,
       current_setting('transaction_read_only') as transaction_read_only,
       current_setting('server_version_num') as server_version_num;

select n.nspname as schema_name,c.relname,c.relkind,c.relrowsecurity,
       c.relforcerowsecurity,pg_get_userbyid(c.relowner) as owner,
       pg_has_role('anon',c.relowner,'USAGE') as anon_inherits_owner,
       pg_has_role('authenticated',c.relowner,'USAGE') as authenticated_inherits_owner
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('reviews','posts','products','purchases')
order by c.relname;

select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) as type_name,
       a.attnotnull,md5(coalesce(pg_get_expr(d.adbin,d.adrelid),'')) as default_fingerprint
from pg_attribute a join pg_class c on c.oid=a.attrelid
join pg_namespace n on n.oid=c.relnamespace
left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
where n.nspname='public' and a.attnum>0 and not a.attisdropped
  and (c.relname='reviews' or (c.relname in ('posts','products','purchases')
    and a.attname in ('id','creator_id','product_id','post_id','buyer_id','access_granted','status')))
order by c.relname,a.attnum;

select c.conrelid::regclass::text as table_name,c.conname,c.contype,c.convalidated,
       pg_get_constraintdef(c.oid,true) as constraint_definition
from pg_constraint c
where c.conrelid in (to_regclass('public.reviews'),to_regclass('public.posts'),to_regclass('public.products'))
  and c.contype in ('p','u','f')
order by table_name,c.conname;

select i.indexrelid::regclass::text as index_name,i.indisunique,i.indisvalid,i.indisready,
       pg_get_indexdef(i.indexrelid) as index_definition
from pg_index i where i.indrelid=to_regclass('public.reviews')
order by index_name;

-- Policy hashes reveal drift without printing custom policy expressions.
select p.polname,p.polcmd,p.polpermissive,
       array(select r.rolname::text from pg_roles r where r.oid=any(p.polroles) order by r.rolname) as named_roles,
       0=any(p.polroles) as applies_to_public,
       p.polqual is null as no_using,
       pg_get_expr(p.polqual,p.polrelid)='(auth.uid() = reviewer_id)' as using_self_only,
       pg_get_expr(p.polwithcheck,p.polrelid)='(auth.uid() = reviewer_id)' as check_self_only,
       md5(coalesce(pg_get_expr(p.polqual,p.polrelid),'')) as using_fingerprint,
       md5(coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'')) as check_fingerprint
from pg_policy p where p.polrelid=to_regclass('public.reviews') order by p.polname;

select r.rolname,r.rolsuper,r.rolbypassrls,c.relname,v.privilege_name,
       has_table_privilege(r.oid,c.oid,v.privilege_name) as effective_privilege,
       has_table_privilege(r.oid,c.oid,v.privilege_name||' WITH GRANT OPTION') as grant_option
from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) v(privilege_name)
where r.rolname in ('anon','authenticated','service_role') and n.nspname='public'
  and c.relname in ('reviews','purchases') order by r.rolname,c.relname,v.privilege_name;

select r.rolname,c.relname,a.attname,v.privilege_name,
       has_column_privilege(r.oid,c.oid,a.attnum,v.privilege_name) as effective_privilege
from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) v(privilege_name)
where r.rolname in ('anon','authenticated') and n.nspname='public'
  and c.relname in ('reviews','purchases') order by r.rolname,c.relname,a.attnum,v.privilege_name;

select t.tgname,t.tgenabled,t.tgtype,p.oid::regprocedure::text as routine,
       pg_get_userbyid(p.proowner) as routine_owner,p.prosecdef,
       p.proconfig @> array['search_path=pg_catalog'] as pg_catalog_pinned,
       md5(coalesce(array_to_string(p.proconfig,'|'),'')) as configuration_fingerprint,
       md5(pg_get_functiondef(p.oid)) as routine_fingerprint
from pg_trigger t join pg_proc p on p.oid=t.tgfoid
where t.tgrelid=to_regclass('public.reviews') and not t.tgisinternal order by t.tgname;

select p.oid::regprocedure::text as existing_candidate_routine,
       pg_get_userbyid(p.proowner) as owner,p.prosecdef,
       p.proconfig @> array['search_path=pg_catalog'] as pg_catalog_pinned,
       md5(coalesce(array_to_string(p.proconfig,'|'),'')) as configuration_fingerprint,
       md5(pg_get_functiondef(p.oid)) as definition_fingerprint
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('has_live_purchase_of_post','can_review_purchased_post','keep_review_identity')
order by existing_candidate_routine;
rollback;
