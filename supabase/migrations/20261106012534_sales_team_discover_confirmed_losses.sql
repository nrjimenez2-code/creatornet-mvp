-- Local forward candidate only. Correct derived Discover principal for team
-- receipts; retain financial owners, original events and all legacy semantics.
-- Apply once after exact installed compatibility/security review. No backfill.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
set local search_path=pg_catalog,public;
lock table public.payment_fee_ledger in share row exclusive mode;

do $patch$
declare
 target oid:=to_regprocedure('public.reconcile_discover_sale_v1(uuid)');
 trigger_function oid:=to_regprocedure('public.discover_ledger_changed_v1()');
 original text;replacement text;original_owner oid;original_acl aclitem[];
 needle text:='greatest(0,gross_amount_cents-refunded_amount_cents)';
 revised text:='greatest(0,gross_amount_cents-case when sales_team_receipt_id is not null then greatest(refunded_amount_cents,team_loss_subtotal_cents) else refunded_amount_cents end)';
begin
 if target is null or trigger_function is null then raise exception 'TEAM_DISCOVER_LOSS_DEPENDENCY_MISSING';end if;
 select pg_get_functiondef(oid),proowner,proacl into original,original_owner,original_acl from pg_proc where oid=target;
 if encode(sha256(convert_to(original,'UTF8')),'hex')<>'d3a93bf179d0578010a631073a9238eb8591ca99216a65e35e0aee7a36634104'
  or encode(sha256(convert_to(pg_get_functiondef(trigger_function),'UTF8')),'hex')<>'c449fcc555a5565e7e8418ceeaca3445768d4403a24382e048461d04fc673b7d'
 then raise exception 'TEAM_DISCOVER_LOSS_ROUTINE_DIFFERS';end if;
 if has_function_privilege('anon',target,'EXECUTE') or has_function_privilege('authenticated',target,'EXECUTE')
  or not has_function_privilege('service_role',target,'EXECUTE')
  or has_function_privilege('anon',trigger_function,'EXECUTE') or has_function_privilege('authenticated',trigger_function,'EXECUTE')
 then raise exception 'TEAM_DISCOVER_LOSS_PRIVILEGES_DIFFER';end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.payment_fee_ledger'::regclass and tgname='discover_ledger_changed_v1'
  and not tgisinternal and tgtype=21 and tgenabled='O' and tgfoid=trigger_function and tgnargs=0 and tgqual is null and tgattr=''::int2vector
  and tgconstraint=0 and not tgdeferrable and not tginitdeferred and tgoldtable is null and tgnewtable is null)
 then raise exception 'TEAM_DISCOVER_LOSS_TRIGGER_DIFFERS';end if;
 if (select count(*) from (values
  ('sales_team_receipt_id','uuid'::regtype,false),('team_loss_subtotal_cents','bigint'::regtype,true),
  ('refunded_amount_cents','bigint'::regtype,true),('gross_amount_cents','bigint'::regtype,true)
 ) expected(name,kind,required) join pg_attribute a on a.attrelid='public.payment_fee_ledger'::regclass
  and a.attname=expected.name and a.atttypid=expected.kind and not a.attisdropped and (not expected.required or a.attnotnull))<>4
 then raise exception 'TEAM_DISCOVER_LOSS_COLUMNS_DIFFER';end if;
 if (select count(*) from (values
  ('payment_fee_ledger_refund_check','c','2010abc43527d4b54762c808bf00c361217de80f8615d8ecbba0aba03216564c'),
  ('sales_team_ledger_exclusive_v1','c','808f690a87b66cd82093f914175ef292e7fb73316a421ec0857d8713c9639313'),
  ('sales_team_ledger_receipt_pair_v1','f','03ab2eb0c81e52f0eed1fb2187c5cb71f6ad1cb1c866d7143d42c5f742368576')
 ) expected(name,kind,digest) join pg_constraint c on c.conrelid='public.payment_fee_ledger'::regclass
  and c.conname=expected.name and c.contype::text=expected.kind and c.convalidated
  and encode(sha256(convert_to(pg_get_constraintdef(c.oid),'UTF8')),'hex')=expected.digest)<>3
 then raise exception 'TEAM_DISCOVER_LOSS_CONSTRAINTS_DIFFER';end if;
 if length(original)-length(replace(original,needle,''))<>length(needle)
 then raise exception 'TEAM_DISCOVER_LOSS_REPLACEMENT_DIFFERS';end if;
 replacement:=replace(original,needle,revised);
 execute replacement;
 if pg_get_functiondef(target) is distinct from replacement or not exists(select 1 from pg_proc
  where oid=target and proowner=original_owner and proacl is not distinct from original_acl and not prosecdef)
 then raise exception 'TEAM_DISCOVER_LOSS_REPLACEMENT_CHANGED_IDENTITY';end if;
end $patch$;
commit;
