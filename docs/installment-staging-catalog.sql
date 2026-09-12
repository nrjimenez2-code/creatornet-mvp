-- Read-only structural preflight. Run only in the verified CreatorNet Staging
-- project (nwqfofezfzljhxolkycz). No rows, secrets, policies or grants are changed.
-- The output is schema evidence, NOT a database or media recovery backup.
begin read only;
with targets as (
  select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relname in
    ('profiles','products','posts','bookings','booking_payments','purchases',
     'payment_fee_ledger','payment_refund_state','payment_dispute_state',
     'refund_operations','admin_actions')
), inventory as (
  select 'column' as kind, t.relname||'.'||a.attname as name,
    jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),
      'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),
      'identity',a.attidentity,'generated',a.attgenerated,'position',a.attnum) as details
  from targets t join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=t.oid and d.adnum=a.attnum
  union all
  select 'constraint',t.relname||'.'||c.conname,
    jsonb_build_object('definition',pg_get_constraintdef(c.oid),'valid',c.convalidated)
  from targets t join pg_constraint c on c.conrelid=t.oid
  union all
  select 'index',t.relname||'.'||i.relname,
    jsonb_build_object('definition',pg_get_indexdef(x.indexrelid),'valid',x.indisvalid)
  from targets t join pg_index x on x.indrelid=t.oid join pg_class i on i.oid=x.indexrelid
  union all
  select 'enum',ty.typname,jsonb_build_object('labels',jsonb_agg(e.enumlabel order by e.enumsortorder))
  from pg_type ty join pg_namespace n on n.oid=ty.typnamespace join pg_enum e on e.enumtypid=ty.oid
  where n.nspname='public' and ty.oid in
    (select a.atttypid from pg_attribute a join targets t on t.oid=a.attrelid)
  group by ty.typname
  union all
  select 'trigger',t.relname||'.'||g.tgname,
    jsonb_build_object('definition',pg_get_triggerdef(g.oid),'enabled',g.tgenabled,
      'function',p.proname,'body',pg_get_functiondef(p.oid))
  from targets t join pg_trigger g on g.tgrelid=t.oid and not g.tgisinternal
  join pg_proc p on p.oid=g.tgfoid
  union all
  select 'table',t.relname,jsonb_build_object('rls',t.relrowsecurity,'forceRls',t.relforcerowsecurity,
    'anonInsert',has_table_privilege('anon',t.oid,'INSERT'),
    'authenticatedInsert',has_table_privilege('authenticated',t.oid,'INSERT')) from targets t
  union all
  select 'dependency_function',p.proname,
    jsonb_build_object('body',pg_get_functiondef(p.oid),'securityDefiner',p.prosecdef,
      'settings',p.proconfig,'anonExecute',has_function_privilege('anon',p.oid,'EXECUTE'),
      'authenticatedExecute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
      'serviceExecute',has_function_privilege('service_role',p.oid,'EXECUTE'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('record_payment_refund_state','record_payment_dispute_state','apply_payment_fee_ledger_refund')
  union all
  select 'exact_table',c.relname,jsonb_build_object('rls',c.relrowsecurity)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relname like 'exact_installment_%'
)
select kind,name,details from inventory order by kind,name;
rollback;
