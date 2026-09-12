-- Read-only pre/post repair check. Verify CreatorNet Staging project identity
-- in the dashboard first. Expect exactly 15 PASS rows, not a production claim.
begin read only;
with function_targets(signature) as (values
  ('public.claim_stripe_event(text,text,integer,uuid)'),
  ('public.complete_stripe_event(text,uuid)'),
  ('public.release_stripe_event(text,uuid)'),
  ('public.record_payment_dispute_state(text,text,text,bigint,text,text,bigint)'),
  ('public.record_payment_refund_state(text,text,bigint,bigint)'),
  ('public.credit_payment_fee_ledger_earnings(uuid)'),
  ('public.apply_purchase_refund_earnings(uuid,bigint)'),
  ('public.apply_payment_fee_ledger_refund(uuid,bigint)'),
  ('public.claim_refund_operation(uuid,uuid,integer)'),
  ('public.create_refund_operation(uuid,uuid,bigint,text,text,text,text,uuid,text,text,bigint,bigint,bigint)')
), table_targets(name) as (values
  ('public.payment_fee_ledger'),('public.stripe_events'),
  ('public.payment_refund_state'),('public.payment_dispute_state'),('public.refund_operations')
), checks as (
  select 'function' as kind,f.signature as name,
    coalesce(p.oid is not null and p.prosecdef and
      not has_function_privilege('anon',p.oid,'EXECUTE') and
      not has_function_privilege('authenticated',p.oid,'EXECUTE') and
      has_function_privilege('service_role',p.oid,'EXECUTE'),false) as passed
  from function_targets f left join pg_proc p on p.oid=to_regprocedure(f.signature)
  union all
  select 'table',t.name,coalesce(c.oid is not null and c.relkind='r' and c.relrowsecurity and
    not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and
    not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and
    not has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') and
    not has_any_column_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') and
    has_table_privilege('service_role',c.oid,'SELECT') and
    has_table_privilege('service_role',c.oid,'INSERT') and
    has_table_privilege('service_role',c.oid,'UPDATE') and
    has_table_privilege('service_role',c.oid,'DELETE'),false)
  from table_targets t left join pg_class c on c.oid=to_regclass(t.name)
)
select kind,name,case when passed then 'PASS' else 'REVIEW' end as result from checks order by kind,name;
rollback;
