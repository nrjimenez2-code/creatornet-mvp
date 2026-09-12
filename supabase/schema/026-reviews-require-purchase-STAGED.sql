-- STAGED ONLY. This file's presence/merge does not authorize hosted execution.
-- Apply after 024, after reviewing the target catalog and a verified recovery
-- point, first on the isolated staging candidate. No production execution here.
--
-- Match lib/reviewEligibility.ts: access_granted IS TRUE and a non-NULL status
-- other than refunded/failed. Active/complete installments and partial refunds
-- retaining access qualify; neither full payment nor a positive amount is needed.
-- Old NULL-post reviews stay readable and owner-deletable, but cannot be edited.
-- Review identity is immutable for every writer: an existing review cannot be
-- moved to another offer/creator, including another one the buyer purchased.
-- No rows, purchase permissions, rating triggers or SELECT policies are changed.
-- The helper answers only for auth.uid(), never for a caller-supplied buyer.
-- Restrictive fences also constrain any existing permissive/ALL write policy.
-- A failure aborts the whole transaction; investigate drift, do not skip checks.
-- Reapplication intentionally fails closed instead of replacing unknown objects.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- All target/schema/role checks precede the first DDL or grant change.
do $preflight$
declare
  target record;
  caller text;
  privilege_name text;
begin
  if not exists (select 1 from pg_roles where rolname=current_user and (rolsuper or rolbypassrls)) then
    raise exception '026 requires a reviewed migration owner able to read purchase rows independently of RLS';
  end if;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')) <> 3 then
    raise exception '026 expected client/server roles are missing';
  end if;
  if exists (select 1 from pg_roles where rolname in ('anon','authenticated') and (rolsuper or rolbypassrls)) then
    raise exception '026 client role bypasses RLS';
  end if;
  if not exists (select 1 from pg_class where oid=to_regclass('public.reviews') and relkind='r' and relrowsecurity) then
    raise exception '026 requires existing RLS-enabled reviews after 024';
  end if;
  if exists (select 1 from pg_class c where c.oid='public.reviews'::regclass
    and (pg_has_role('anon',c.relowner,'USAGE') or pg_has_role('authenticated',c.relowner,'USAGE'))) then
    raise exception '026 client inherits reviews ownership';
  end if;
  for target in select * from (values
    ('public.reviews','id','uuid'),('public.reviews','reviewer_id','uuid'),
    ('public.reviews','creator_id','uuid'),('public.reviews','post_id','uuid'),
    ('public.reviews','rating','integer'),('public.reviews','comment','text'),
    ('public.reviews','created_at','timestamp with time zone'),('public.reviews','updated_at','timestamp with time zone'),
    ('public.posts','id','uuid'),('public.posts','creator_id','uuid'),
    ('public.purchases','buyer_id','uuid'),('public.purchases','post_id','uuid'),
    ('public.purchases','access_granted','boolean'),('public.purchases','status','text')
  ) as required(table_name,column_name,type_name) loop
    if not exists (select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid
      where a.attrelid=to_regclass(target.table_name) and c.relkind='r' and a.attnum>0
        and not a.attisdropped and a.attname=target.column_name
        and format_type(a.atttypid,a.atttypmod)=target.type_name) then
      raise exception '026 required base column/type missing: %.%',target.table_name,target.column_name;
    end if;
  end loop;
  -- Purchase rows are the authorization authority. Do not install a review gate
  -- over client-editable purchase evidence; 003/011 must already have closed it.
  -- This check makes no change to purchase privileges or their buyer read policy.
  foreach caller in array array['anon','authenticated'] loop
    foreach privilege_name in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if has_table_privilege(caller,'public.purchases',privilege_name) then
        raise exception '026 purchase evidence is client-writable; review existing purchases ACLs';
      end if;
    end loop;
    foreach privilege_name in array array['INSERT','UPDATE','REFERENCES'] loop
      if has_any_column_privilege(caller,'public.purchases',privilege_name) then
        raise exception '026 purchase evidence has client column writes; review existing purchases ACLs';
      end if;
    end loop;
  end loop;
  if (select count(*) from pg_attribute where attrelid='public.reviews'::regclass and attnum>0 and not attisdropped) <> 8 then
    raise exception '026 unexpected review columns; review ACL allowlist before proceeding';
  end if;
  if not exists (select 1 from pg_index i where i.indexrelid=to_regclass('public.reviews_reviewer_post_unique')
    and i.indrelid='public.reviews'::regclass and i.indisunique and i.indisvalid and i.indisready
    and i.indnkeyatts=2 and i.indnatts=2
    and pg_get_indexdef(i.indexrelid,1,true)='reviewer_id'
    and pg_get_indexdef(i.indexrelid,2,true)='post_id'
    and pg_get_expr(i.indpred,i.indrelid)='(post_id IS NOT NULL)') then
    raise exception '026 requires the valid per-post unique index from 024';
  end if;
  if not exists (select 1 from pg_constraint c where c.conrelid='public.reviews'::regclass
    and c.confrelid='public.posts'::regclass and c.contype='f' and c.convalidated and c.confdeltype='c'
    and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='post_id')]::smallint[]
    and c.confkey=array[(select attnum from pg_attribute where attrelid=c.confrelid and attname='id')]::smallint[]) then
    raise exception '026 requires the validated post foreign key from 024';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('can_review_purchased_post','has_live_purchase_of_post','keep_review_identity')) then
    raise exception '026 review helper already exists; review its definition and grants, do not replace blindly';
  end if;
  if exists (select 1 from pg_policy where polrelid='public.reviews'::regclass
    and polname in ('reviews_purchase_insert_fence','reviews_purchase_update_fence',
                    'reviews_owner_delete_fence','reviews_owner_delete')) then
    raise exception '026 policy name collision; review existing policy first';
  end if;
  if exists (select 1 from pg_trigger where tgrelid='public.reviews'::regclass and tgname='reviews_keep_identity') then
    raise exception '026 trigger name collision; review existing trigger first';
  end if;
  -- Do not remove an unreviewed extra condition hiding under a familiar name.
  -- These are the two original caller-only policies that this file replaces.
  if (select count(*) from pg_policy where polrelid='public.reviews'::regclass and polpermissive
    and (0::oid=any(polroles) or (select oid from pg_roles where rolname='authenticated')=any(polroles))
    and pg_get_expr(polwithcheck,polrelid)='(auth.uid() = reviewer_id)'
    and ((polname='Users can insert their own reviews' and polcmd='a' and polqual is null)
      or (polname='Users can update their own reviews' and polcmd='w'
        and pg_get_expr(polqual,polrelid)='(auth.uid() = reviewer_id)'))) <> 2 then
    raise exception '026 expected original insert/update policy expressions missing or changed; review target policy drift';
  end if;
  if to_regprocedure('auth.uid()') is null then raise exception '026 auth.uid() missing'; end if;
  foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE'] loop
    if not has_table_privilege('service_role','public.reviews',privilege_name) then
      raise exception '026 existing server review permission missing: %',privilege_name;
    end if;
  end loop;
end;
$preflight$;

create function public.can_review_purchased_post(p_post uuid,p_creator uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog
as $function$
  select auth.uid() is not null and p_post is not null and p_creator is not null
    and auth.uid() <> p_creator and exists (
      select 1 from public.posts po join public.purchases pu on pu.post_id=po.id
      where po.id=p_post and po.creator_id=p_creator and pu.buyer_id=auth.uid()
        and pu.access_granted is true and pu.status not in ('refunded','failed')
    );
$function$;
revoke all privileges on function public.can_review_purchased_post(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.can_review_purchased_post(uuid,uuid) to authenticated;

-- An invoker trigger needs no privileged reads. All three identity columns are
-- immutable even for service writers; correcting identity requires a separately
-- reviewed delete/recreate operation, not an unnoticed rating reassignment.
create function public.keep_review_identity()
returns trigger language plpgsql
set search_path = pg_catalog
as $function$
begin
  if new.reviewer_id is distinct from old.reviewer_id
    or new.creator_id is distinct from old.creator_id
    or new.post_id is distinct from old.post_id then
    raise exception 'Review identity cannot be changed' using errcode='23514';
  end if;
  return new;
end;
$function$;
revoke all privileges on function public.keep_review_identity() from public,anon,authenticated,service_role;
create trigger reviews_keep_identity before update on public.reviews
  for each row execute function public.keep_review_identity();

drop policy "Users can insert their own reviews" on public.reviews;
create policy "Users can insert their own reviews" on public.reviews for insert to authenticated
  with check (auth.uid()=reviewer_id and public.can_review_purchased_post(post_id,creator_id));
drop policy "Users can update their own reviews" on public.reviews;
create policy "Users can update their own reviews" on public.reviews for update to authenticated
  using (auth.uid()=reviewer_id and public.can_review_purchased_post(post_id,creator_id))
  with check (auth.uid()=reviewer_id and public.can_review_purchased_post(post_id,creator_id));
create policy reviews_owner_delete on public.reviews for delete to authenticated using (auth.uid()=reviewer_id);
create policy reviews_purchase_insert_fence on public.reviews as restrictive for insert to authenticated
  with check (auth.uid()=reviewer_id and public.can_review_purchased_post(post_id,creator_id));
create policy reviews_purchase_update_fence on public.reviews as restrictive for update to authenticated
  using (auth.uid()=reviewer_id and public.can_review_purchased_post(post_id,creator_id))
  with check (auth.uid()=reviewer_id and public.can_review_purchased_post(post_id,creator_id));
create policy reviews_owner_delete_fence on public.reviews as restrictive for delete to authenticated
  using (auth.uid()=reviewer_id);

revoke all privileges on table public.reviews from public,anon,authenticated;
-- Independent column grants survive a table-level REVOKE, so remove those too.
revoke all privileges (id,reviewer_id,creator_id,post_id,rating,comment,created_at,updated_at)
  on table public.reviews from public,anon,authenticated;
grant select on table public.reviews to anon,authenticated;
grant delete on table public.reviews to authenticated;
-- The existing API includes these identity fields even in an unchanged UPDATE.
-- RLS checks BOTH the old and new tuple; clients cannot write id/created_at.
grant insert (reviewer_id,creator_id,post_id,rating,comment,updated_at),
      update (reviewer_id,creator_id,post_id,rating,comment,updated_at)
  on table public.reviews to authenticated;

do $verify$
declare
  caller text;
  privilege_name text;
  col record;
  expected boolean;
begin
  if not exists (select 1 from pg_proc where oid='public.can_review_purchased_post(uuid,uuid)'::regprocedure
    and prosecdef and provolatile='s' and proconfig=array['search_path=pg_catalog'])
    or not has_function_privilege('authenticated','public.can_review_purchased_post(uuid,uuid)','EXECUTE')
    or has_function_privilege('anon','public.can_review_purchased_post(uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.can_review_purchased_post(uuid,uuid)','EXECUTE WITH GRANT OPTION') then
    raise exception '026 helper privileges or search_path drift; review inherited roles';
  end if;
  if (select count(*) from pg_policy where polrelid='public.reviews'::regclass and not polpermissive
    and polroles=array[(select oid from pg_roles where rolname='authenticated')]
    and ((polname='reviews_purchase_insert_fence' and polcmd='a')
      or (polname='reviews_purchase_update_fence' and polcmd='w')
      or (polname='reviews_owner_delete_fence' and polcmd='d'))) <> 3 then
    raise exception '026 restrictive fences missing';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.reviews'::regclass and tgname='reviews_keep_identity'
    and tgfoid='public.keep_review_identity()'::regprocedure and tgtype=19 and tgenabled='O' and not tgisinternal)
    or not exists (select 1 from pg_proc where oid='public.keep_review_identity()'::regprocedure
      and not prosecdef and proconfig=array['search_path=pg_catalog'])
    or has_function_privilege('anon','public.keep_review_identity()','EXECUTE')
    or has_function_privilege('authenticated','public.keep_review_identity()','EXECUTE') then
    raise exception '026 immutable review identity trigger missing or changed';
  end if;
  foreach caller in array array['anon','authenticated'] loop
    foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      expected := privilege_name='SELECT' or (caller='authenticated' and privilege_name='DELETE');
      if has_table_privilege(caller,'public.reviews',privilege_name) is distinct from expected
        or has_table_privilege(caller,'public.reviews',privilege_name || ' WITH GRANT OPTION') then
        raise exception '026 unexpected effective table privilege: % %; review inherited roles',caller,privilege_name;
      end if;
    end loop;
    for col in select attname from pg_attribute where attrelid='public.reviews'::regclass and attnum>0 and not attisdropped loop
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
        expected := privilege_name='SELECT' or (caller='authenticated' and privilege_name in ('INSERT','UPDATE')
          and col.attname in ('reviewer_id','creator_id','post_id','rating','comment','updated_at'));
        if has_column_privilege(caller,'public.reviews',col.attname,privilege_name) is distinct from expected
          or has_column_privilege(caller,'public.reviews',col.attname,privilege_name || ' WITH GRANT OPTION') then
          raise exception '026 unexpected effective column privilege: % %.%; review inherited roles',caller,col.attname,privilege_name;
        end if;
      end loop;
    end loop;
  end loop;
  foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE'] loop
    if not has_table_privilege('service_role','public.reviews',privilege_name) then
      raise exception '026 server permission lost; review inherited grants before retry';
    end if;
  end loop;
end;
$verify$;
commit;

-- Recovery is a separately reviewed operation, not a blind grant/disable-RLS
-- rollback. Preserve this staged result, compare the target's catalog, and test
-- app/direct-client writes and reads before any production promotion decision.
