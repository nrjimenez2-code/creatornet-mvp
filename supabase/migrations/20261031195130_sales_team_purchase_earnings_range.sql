-- Cumulative team creator earnings can exceed a single integer-priced purchase.
-- Preserve every value, identity, routine, constraint and privilege. No backfill,
-- financial operation or feature activation is performed by this migration.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $parents$ begin
 perform 'public.sync_sales_team_shared_accounting_v1(uuid)'::regprocedure;
 perform 'public.read_sales_team_payout_statement_v1(uuid,uuid,uuid,integer)'::regprocedure;
end $parents$;

do $width$
declare field record;
begin
 select atttypid,attgenerated,attidentity into field
 from pg_attribute where attrelid='public.purchases'::regclass
  and attname='earnings_credited_cents' and attnum>0 and not attisdropped;
 if not found or field.attgenerated<>'' or field.attidentity<>''
  or field.atttypid not in ('integer'::regtype,'bigint'::regtype) then
  raise exception 'Purchase cumulative earnings column differs from reviewed integer/bigint baseline';
 end if;
 if field.atttypid='integer'::regtype then
  alter table public.purchases alter column earnings_credited_cents
   type bigint using earnings_credited_cents::bigint;
 end if;
end $width$;

notify pgrst,'reload schema';
commit;
