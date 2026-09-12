-- Read-only handoff check, executed on original staging 2026-09-08T08:12:22Z.
-- Independently confirm CreatorNet Staging / nwqfofezfzljhxolkycz in the UI.
-- Conservative LIKE patterns deliberately overmatch underscore characters.
-- Verified locally that all 040-057 manifest relations/triggers/types and
-- function names fall within these patterns. Recheck coverage if it changes.
-- Zero collisions is not full schema compatibility or permission to install.
begin;
set transaction read only;
set local search_path=pg_catalog;
set local statement_timeout='30s';
set local lock_timeout='5s';
with required(signature) as (
  values ('public.apply_payment_fee_ledger_refund(uuid,bigint)'),
    ('public.record_payment_refund_state(text,text,bigint,bigint)'),
    ('public.record_payment_dispute_state(text,text,text,bigint,text,text,bigint)')
)
select jsonb_build_object(
  'observed_at',clock_timestamp(),'role',current_user,
  'read_only',current_setting('transaction_read_only'),
  'public_schema_present',to_regnamespace('public') is not null,
  'booking_payments_present',to_regclass('public.booking_payments') is not null,
  'exact_relations',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'exact_installment_%'),
  'exact_types',(select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
    where n.nspname='public' and (t.typname like 'exact_installment_%' or t.typname like '_exact_installment_%')),
  'exact_functions',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like '%exact_%'),
  'exact_triggers',(select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and t.tgname like 'exact_installment_%'),
  'legacy_column_present',exists(select 1 from pg_attribute where attrelid=to_regclass('public.booking_payments')
    and attname='installment_collection_version' and attnum>0 and not attisdropped),
  'legacy_constraint_present',exists(select 1 from pg_constraint where conrelid=to_regclass('public.booking_payments')
    and conname='booking_payments_installment_collection_version_check'),
  'required_routines',(select jsonb_agg(jsonb_build_object('signature',r.signature,'present',p.oid is not null,
    'owner',pg_get_userbyid(p.proowner),'anon_execute',has_function_privilege('anon',p.oid,'EXECUTE'),
    'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
    'service_execute',has_function_privilege('service_role',p.oid,'EXECUTE')) order by r.signature)
    from required r left join pg_proc p on p.oid=to_regprocedure(r.signature))
) as next_schema_check;
rollback;
