-- Legacy installations can retain PostgreSQL's default PUBLIC execute grant.
-- These helpers accept arbitrary metric deltas and are called only by server helpers.
-- Apply independently of the optional legacy counter schema; do not recreate it.
do $migration$
declare signature text; target regprocedure;
begin
 foreach signature in array array[
  'public.bump_interest_score(uuid,text,integer)',
  'public.bump_post_metrics(uuid,integer,integer,integer,integer,integer,integer,integer,numeric)',
  'public.bump_post_metrics_scored(uuid,integer,integer,integer,integer,integer,integer,integer,numeric)'
 ] loop
  target:=to_regprocedure(signature);
  if target is not null then
   execute format('revoke execute on function %s from public, anon, authenticated',target);
   execute format('grant execute on function %s to service_role',target);
  end if;
 end loop;
end $migration$;
