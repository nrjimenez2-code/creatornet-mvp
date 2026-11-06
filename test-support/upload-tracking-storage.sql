-- Disposable local fixture only. Emulates documented operation context;
-- it is not provider-authoritative Storage acceptance.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema storage;
grant usage on schema auth,storage to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
create function storage.allow_only_operation(operation text) returns boolean
language sql stable as $$
  select coalesce(regexp_replace(current_setting('storage.operation',true),'^storage\.','')
    =regexp_replace(operation,'^storage\.',''),false)
$$;
create table storage.objects(id bigint generated always as identity,bucket_id text,name text,owner_id text);
alter table storage.objects enable row level security;
grant select,insert,update on storage.objects to authenticated,anon;
grant usage on sequence storage.objects_id_seq to authenticated,anon;
create policy existing_owner_insert on storage.objects for insert to authenticated
  with check(owner_id=auth.uid()::text);
create policy existing_owner_select on storage.objects for select to authenticated
  using(owner_id=auth.uid()::text);
create policy existing_owner_update on storage.objects for update to authenticated
  using(owner_id=auth.uid()::text) with check(owner_id=auth.uid()::text);
