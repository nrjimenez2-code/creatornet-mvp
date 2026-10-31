-- Narrow only the client administrator override. Ordinary owner/buyer policies,
-- private-site access, release settings and service-role fulfillment stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.is_admin()')
    and prosecdef and prorettype='boolean'::regtype and provolatile='s'
    and prolang=(select oid from pg_language where lanname='sql')
    and pg_get_userbyid(proowner)='postgres'
    and proconfig=array['search_path=public']
    and md5(prosrc)='943de565b8dc6c0817f3a0ce1a1ffe18'
    and cardinality(proacl)=3
    and proacl @> array['postgres=X/postgres'::aclitem,'authenticated=X/postgres'::aclitem,'service_role=X/postgres'::aclitem]) then
    raise exception 'Administrator helper drifted; reconcile before MFA hardening';
  end if;
end $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(auth.jwt()->>'aal','aal1')='aal2'
    and exists(select 1 from public.profiles where id=auth.uid() and role='admin' and banned_at is null)
    and exists(select 1 from auth.mfa_factors where user_id=auth.uid() and factor_type='totp' and status='verified');
$$;
-- CREATE OR REPLACE retains the existing owner and EXECUTE ACL. No new client
-- capability or Auth schema write is introduced.
notify pgrst,'reload schema';
commit;
