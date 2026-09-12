-- Metadata-only follow-up for the approved original-staging review package.
-- Uses exactly the column-row shape/order from staging-review-postinstall-json.sql.
-- Recorded original seven-column hash: staging 2026-09-08, before unit three.
-- No application rows, raw defaults/function bodies, or application RPC calls.
begin;
set transaction read only;
set local search_path = pg_catalog;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
with columns as (
  select 'reviews'::text as name,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) as type,
    a.attnotnull,a.attidentity,a.attgenerated,
    md5(coalesce(pg_get_expr(d.adbin,d.adrelid),'')) as default_hash
  from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where a.attrelid=to_regclass('public.reviews') and a.attnum>0 and not a.attisdropped
), original_columns as (
  select * from columns where attname<>'post_id'
), comparison as (
  select count(*) as column_count,
    md5(coalesce(jsonb_agg(to_jsonb(x) order by attnum),'[]'::jsonb)::text) as original_columns_hash
  from original_columns x
)
select jsonb_build_object(
  'observed_at',clock_timestamp(),'role',current_user,'read_only',current_setting('transaction_read_only'),
  'recorded_original_columns_hash','89cc98690792c47d19a5de76c6c765c1',
  'original_column_count',(select column_count from comparison),
  'original_columns_hash',(select original_columns_hash from comparison),
  'original_seven_columns_match',(select column_count=7 and original_columns_hash='89cc98690792c47d19a5de76c6c765c1' from comparison),
  'current_column_count',(select count(*) from columns),
  'current_columns',coalesce((select jsonb_agg(to_jsonb(x) order by attnum) from columns x),'[]'::jsonb),
  'post_foreign_keys',coalesce((select jsonb_agg(jsonb_build_object('name',c.conname,'validated',c.convalidated,
    'definition',pg_get_constraintdef(c.oid)) order by c.conname)
    from pg_constraint c where c.conrelid=to_regclass('public.reviews') and c.contype='f'
      and (select attnum from pg_attribute where attrelid=c.conrelid and attname='post_id' and not attisdropped)=any(c.conkey)),'[]'::jsonb),
  'post_indexes',coalesce((select jsonb_agg(jsonb_build_object('name',i.indexrelid::regclass::text,
    'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready,'definition',pg_get_indexdef(i.indexrelid)) order by i.indexrelid::regclass::text)
    from pg_index i where i.indrelid=to_regclass('public.reviews') and i.indexrelid in
      (to_regclass('public.reviews_reviewer_post_unique'),to_regclass('public.idx_reviews_post_id'))),'[]'::jsonb)
) as original_columns_postcheck;
rollback;
