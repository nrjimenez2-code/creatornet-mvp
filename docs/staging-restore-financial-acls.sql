-- OPERATOR-APPROVED STAGING REPAIR ONLY, NOT A NUMBERED APP MIGRATION.
-- Verify dashboard project nwqfofezfzljhxolkycz / CreatorNet Staging immediately
-- before execution. This script cannot independently identify a hosted project.
-- Restore the server-only intent already specified in migration 019. Do NOT
-- rerun all of 019: it also contains data backfills and function replacements.
-- No data, function body, owner, RLS policy, credential or service_role grant
-- is changed. No production permission is granted by this file's existence.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $repair$
declare
  target_name text;
  target_table regclass;
  target_function regprocedure;
  columns_sql text;
  caller text;
  privilege_name text;
begin
  foreach target_name in array array[
    'public.payment_fee_ledger','public.stripe_events',
    'public.payment_refund_state','public.payment_dispute_state'
  ] loop
    target_table := to_regclass(target_name);
    if target_table is null or not exists(select 1 from pg_class
      where oid=target_table and relkind='r' and relrowsecurity) then
      raise exception 'Expected existing RLS-enabled private table: %',target_name;
    end if;
    foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role',target_table,privilege_name) then
        raise exception 'Existing server permission missing on %: %',target_name,privilege_name;
      end if;
    end loop;
    execute format('revoke all privileges on table %s from public, anon, authenticated',target_table);
    select string_agg(quote_ident(attname),',' order by attnum) into columns_sql
      from pg_attribute where attrelid=target_table and attnum>0 and not attisdropped;
    -- Table REVOKE alone does not remove separately granted column privileges.
    execute format('revoke all privileges (%s) on table %s from public, anon, authenticated',columns_sql,target_table);
    -- Check effective server rights again before COMMIT in case they depended
    -- on PUBLIC or an inherited role whose client grants were just removed.
    foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role',target_table,privilege_name) then
        raise exception 'Server permission lost during repair on %: %',target_name,privilege_name;
      end if;
    end loop;
    foreach caller in array array['anon','authenticated'] loop
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        if has_table_privilege(caller,target_table,privilege_name) then
          raise exception 'Unexpected inherited table access remains; review instead of widening repair';
        end if;
      end loop;
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        if has_any_column_privilege(caller,target_table,privilege_name) then
          raise exception 'Unexpected inherited column access remains; review instead of widening repair';
        end if;
      end loop;
    end loop;
  end loop;
  foreach target_name in array array[
    'public.claim_stripe_event(text,text,integer,uuid)',
    'public.complete_stripe_event(text,uuid)',
    'public.release_stripe_event(text,uuid)',
    'public.record_payment_dispute_state(text,text,text,bigint,text,text,bigint)',
    'public.record_payment_refund_state(text,text,bigint,bigint)',
    'public.credit_payment_fee_ledger_earnings(uuid)',
    'public.apply_purchase_refund_earnings(uuid,bigint)',
    'public.apply_payment_fee_ledger_refund(uuid,bigint)'
  ] loop
    target_function := to_regprocedure(target_name);
    if target_function is null or not exists(select 1 from pg_proc
      where oid=target_function and prosecdef) or
      not has_function_privilege('service_role',target_function,'EXECUTE') then
      raise exception 'Expected existing server function unavailable: %',target_name;
    end if;
    execute format('revoke all privileges on function %s from public, anon, authenticated',target_function);
    if has_function_privilege('anon',target_function,'EXECUTE') or
      has_function_privilege('authenticated',target_function,'EXECUTE') or
      not has_function_privilege('service_role',target_function,'EXECUTE') then
      raise exception 'Function permissions did not become server-only; review inherited roles';
    end if;
  end loop;
end;
$repair$;
commit;
