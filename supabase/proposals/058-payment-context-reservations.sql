-- LOCAL FORWARD PROPOSAL ONLY. Not part of the installed 040-057 manifest.
-- No hosted execution, deployment, context provisioning or payment is authorized.
-- A reservation is permanently reserved_not_issuable: no transactional provider IDs, payment,
-- purchase, entitlement, invoice or obligation is created by this proposal.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

do $context_v2_preflight$
declare required_name text;
begin
  if current_user <> 'postgres' or current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Context v2 requires the reviewed owner and READ COMMITTED'; end if;
  if (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')) <> 3 or
    exists(select 1 from pg_roles where rolname in ('anon','authenticated','service_role') and
      (rolsuper or rolcreaterole or rolcreatedb)) or
    not exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls) or
    exists(select 1 from pg_auth_members where member in
      (select oid from pg_roles where rolname in ('anon','authenticated','service_role'))) then
    raise exception 'Context v2 runtime role baseline differs'; end if;
  foreach required_name in array array['bookings','booking_payments','products','posts','profiles','purchases',
    'exact_installment_agreements'] loop
    if not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=required_name and c.relkind='r'
      and c.relowner=(select oid from pg_roles where rolname=current_user)) then
      raise exception 'Context v2 required relation/owner differs'; end if;
  end loop;
  if to_regprocedure('public.reserve_exact_installment_checkout(uuid,uuid,integer,text,jsonb,jsonb)') is null or
    to_regprocedure('public.create_exact_installment_agreement(uuid,uuid,uuid,jsonb)') is null or
    to_regprocedure('public.publish_exact_installment_checkout(uuid,uuid,text,text,uuid,text,bigint,text)') is null or
    to_regprocedure('public.guard_exact_installment_checkout_estimate()') is null or
    not exists(select 1 from pg_attribute where attrelid='public.booking_payments'::regclass
      and attname='installment_collection_version' and atttypid='text'::regtype and not attisdropped and not attnotnull) or
    not exists(select 1 from pg_constraint where conrelid='public.booking_payments'::regclass
      and conname='booking_payments_installment_collection_version_check' and contype='c' and convalidated
      and regexp_replace(pg_get_constraintdef(oid), '\s', '', 'g') =
        'CHECK(((installment_collection_versionISNULL)OR(installment_collection_version=''exact-cents-held-v1''::text)))') or
    not exists(select 1 from pg_trigger where tgrelid='public.booking_payments'::regclass
      and tgname='exact_installment_checkout_estimate' and tgenabled='O' and tgtype=19
      and tgfoid='public.guard_exact_installment_checkout_estimate()'::regprocedure and not tgisinternal) then
    raise exception 'Context v2 requires the unchanged 057 prerequisite'; end if;
  -- Refuse partial installation, replay, overloads, row/array types and indexes.
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
    and (c.relname like 'exact_installment_context_reservations_v2%' or c.relname like 'exact_installment_context_pin_v2%')) or
    exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'
      and (t.typname in ('exact_installment_context_reservations_v2','_exact_installment_context_reservations_v2',
        'exact_installment_context_pin_v2','_exact_installment_context_pin_v2'))) or
    exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('valid_exact_payment_context_v2','guard_exact_context_immutable_v2',
        'guard_legacy_payment_context_v2','reserve_exact_installment_context_v2','read_exact_installment_context_pin_v2')) or
    exists(select 1 from pg_trigger where tgrelid='public.booking_payments'::regclass
      and tgname='legacy_payment_context_v2') then
    raise exception 'Context v2 prospective object collision; no replay or adoption'; end if;
end;
$context_v2_preflight$;

-- Structural validation only; matching this JSON does not prove the provenance
-- of the owner's pin or independently observed Stripe/database facts.
create function public.valid_exact_payment_context_v2(p_context jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare host text; label text;
begin
  if jsonb_typeof(p_context) is distinct from 'object' or
    (select count(*) from jsonb_object_keys(p_context)) <> 5 or
    not (p_context ?& array['version','mode','platformAccountId','supabaseProjectRef','siteOrigin']) or
    p_context->>'version' is distinct from 'exact-payment-context-v1' or
    p_context->>'mode' is null or p_context->>'mode' not in ('test','live') or
    jsonb_typeof(p_context->'platformAccountId') is distinct from 'string' or
    p_context->>'platformAccountId' !~ '^acct_[A-Za-z0-9]{1,100}$' or
    jsonb_typeof(p_context->'supabaseProjectRef') is distinct from 'string' or
    p_context->>'supabaseProjectRef' !~ '^[a-z0-9]{20}$' or
    jsonb_typeof(p_context->'siteOrigin') is distinct from 'string' or
    length(p_context->>'siteOrigin') > 300 or p_context->>'siteOrigin' !~ '^https://[a-z0-9.-]+$' then
    return false; end if;
  host := substr(p_context->>'siteOrigin',9);
  if length(host)>253 or position('.' in host)=0 or host ~ '^[0-9.]+$' then return false; end if;
  foreach label in array string_to_array(host,'.') loop
    if label !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then return false; end if;
  end loop;
  if (p_context->>'mode'='test' and host !~ '^[a-z0-9-]+\.vercel\.app$') or
    (p_context->>'mode'='live' and (host='vercel.app' or host like '%.vercel.app')) then return false; end if;
  return true;
end;
$$;

-- One database, one explicitly owner-provisioned deployment context. EMPTY at
-- install. No API can provision or change this pin; any future change needs a
-- separate reviewed forward migration and existing-reservation disposition.
create table public.exact_installment_context_pin_v2 (
  singleton boolean primary key default true check(singleton),
  context jsonb not null unique check(public.valid_exact_payment_context_v2(context)),
  created_at timestamptz not null default now()
);
create table public.exact_installment_context_reservations_v2 (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete restrict,
  context jsonb not null references public.exact_installment_context_pin_v2(context) on update restrict on delete restrict,
  terms jsonb not null check((jsonb_typeof(terms)='object' and terms->>'version'='exact-cents-context-v2'
    and terms->>'currency'='usd' and terms->>'bookingId'=booking_id::text) is true),
  status text not null default 'reserved_not_issuable' check(status='reserved_not_issuable'),
  created_at timestamptz not null default now()
);
alter table public.exact_installment_context_pin_v2 enable row level security;
alter table public.exact_installment_context_reservations_v2 enable row level security;
revoke all on public.exact_installment_context_pin_v2,public.exact_installment_context_reservations_v2
  from public,anon,authenticated,service_role;
grant select on public.exact_installment_context_reservations_v2 to service_role;

-- Read-only observation of the reached database's immutable OWNER PIN, not an
-- independent project/account attestation. A restore copies this pin. A trusted
-- server must construct and bind the same client to the separately approved
-- unique canonical HTTPS Supabase endpoint, reject redirects/final-URL changes,
-- and compare that endpoint with this pin. That relies on trusted HTTPS and
-- provider DNS; stored JSON, request claims or user-set GUCs do not prove identity.
-- No timestamp is returned: statement time would not prove pin provenance.
create function public.read_exact_installment_context_pin_v2()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare pinned_context jsonb;
begin
  select context into pinned_context from public.exact_installment_context_pin_v2 where singleton;
  if not found or not public.valid_exact_payment_context_v2(pinned_context) then
    raise exception 'Explicit owner-provisioned context pin required'; end if;
  return jsonb_build_object('version','exact-context-pin-observation-v1','context',pinned_context,
    'status','reserved_not_issuable','source','owner_provisioned_database_pin');
end;
$$;

create function public.guard_exact_context_immutable_v2()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'Context v2 pin/reservation is immutable and not issuable'; end;
$$;
create trigger context_pin_v2_immutable before update or delete on public.exact_installment_context_pin_v2
  for each row execute function public.guard_exact_context_immutable_v2();
create trigger context_pin_v2_no_truncate before truncate on public.exact_installment_context_pin_v2
  for each statement execute function public.guard_exact_context_immutable_v2();
create trigger context_reservation_v2_immutable before update or delete on public.exact_installment_context_reservations_v2
  for each row execute function public.guard_exact_context_immutable_v2();
create trigger context_reservation_v2_no_truncate before truncate on public.exact_installment_context_reservations_v2
  for each statement execute function public.guard_exact_context_immutable_v2();

-- Both protocols serialize admission on the existing booking row. READ
-- COMMITTED is required: a lock alone cannot refresh a REPEATABLE READ snapshot.
-- Even with an empty pin/reservation table this adds that lock to legacy INSERT
-- and booking reassignment. Normal unchanged-booking UPDATE is unaffected.
create function public.guard_legacy_payment_context_v2()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' and new.booking_id is not distinct from old.booking_id then return new; end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Cross-protocol payment admission requires READ COMMITTED'; end if;
  perform 1 from public.bookings where id=new.booking_id for update;
  if exists(select 1 from public.exact_installment_context_reservations_v2 where booking_id=new.booking_id) then
    raise exception 'Booking is reserved by the non-issuable context protocol'; end if;
  return new;
end;
$$;
create trigger legacy_payment_context_v2 before insert or update of booking_id on public.booking_payments
  for each row execute function public.guard_legacy_payment_context_v2();

create function public.reserve_exact_installment_context_v2(p_booking_id uuid,p_actor_id uuid,p_count integer,
  p_context jsonb,p_first_fee jsonb,p_renewal_fee jsonb)
returns public.exact_installment_context_reservations_v2
language plpgsql security definer set search_path=pg_catalog as $$
declare
  b public.bookings%rowtype;
  product public.products%rowtype;
  profile public.profiles%rowtype;
  saved public.exact_installment_context_reservations_v2%rowtype;
  terms jsonb;
  schedule jsonb;
  gross bigint;
  scheduled_amount bigint;
  deduction bigint;
begin
  if current_setting('transaction_isolation') <> 'read committed' or p_booking_id is null or p_actor_id is null or
    p_count is null or p_count not between 2 and 24 then raise exception 'Invalid context reservation admission'; end if;
  if not public.valid_exact_payment_context_v2(p_context) or not exists(
    select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Explicit owner-provisioned context pin required'; end if;
  select * into b from public.bookings where id=p_booking_id for update;
  if not found or b.creator_id is distinct from p_actor_id or b.buyer_id is null or
    b.buyer_id=b.creator_id or b.status is distinct from 'booked' then raise exception 'Owned unpaid booking required'; end if;
  -- Never adopt any legacy row, including canceled/refunded evidence. Checking
  -- again after the common booking lock is essential to the reciprocal fence.
  if exists(select 1 from public.booking_payments where booking_id=b.id) or
    exists(select 1 from public.exact_installment_agreements ag where ag.terms->>'bookingId'=b.id::text) then
    raise exception 'Existing legacy payment/agreement cannot be adopted'; end if;
  select p.* into product from public.products p join public.posts post on post.id=b.post_id
    and post.product_id=p.id and post.creator_id=b.creator_id where p.creator_id=b.creator_id for share of p,post;
  if not found or product.type not in ('video','course','mentorship') or product.is_active is distinct from true or
    product.amount_cents is null or product.amount_cents<50 or lower(trim(product.currency)) is distinct from 'usd' or
    coalesce(length(trim(product.title)),0) not between 1 and 200 then raise exception 'Active owned USD product required'; end if;
  if exists(select 1 from public.purchases where buyer_id=b.buyer_id and (post_id=b.post_id or product_id=product.id)) then
    raise exception 'Existing purchase cannot be adopted'; end if;
  select * into profile from public.profiles where id=b.creator_id for share;
  if not found or profile.stripe_onboarding_complete is distinct from true or profile.stripe_account_id is null or
    profile.stripe_account_id !~ '^acct_[A-Za-z0-9]{1,100}$' then raise exception 'Creator destination not ready'; end if;
  gross:=product.amount_cents;
  if gross/p_count<50 or gross/p_count+gross%p_count>99999999 then raise exception 'Invalid agreed amounts'; end if;
  foreach schedule in array array[p_first_fee,p_renewal_fee] loop
    if jsonb_typeof(schedule) is distinct from 'object' or (select count(*) from jsonb_object_keys(schedule))<>4 or
      not(schedule ?& array['enabled','basisPoints','fixedCents','version']) or
      jsonb_typeof(schedule->'enabled') is distinct from 'boolean' or
      jsonb_typeof(schedule->'basisPoints') is distinct from 'number' or
      jsonb_typeof(schedule->'fixedCents') is distinct from 'number' or
      jsonb_typeof(schedule->'version') is distinct from 'string' or
      coalesce(schedule->>'basisPoints','') !~ '^\d+$' or coalesce(schedule->>'fixedCents','') !~ '^\d+$' or
      (schedule->>'basisPoints')::bigint not between 0 and 10000 or
      (schedule->>'fixedCents')::bigint not between 0 and 99999999 or
      coalesce(length(trim(schedule->>'version')),0) not between 1 and 200 or
      schedule->>'version' is distinct from trim(schedule->>'version') then raise exception 'Invalid fee snapshot'; end if;
    foreach scheduled_amount in array array[gross/p_count,gross/p_count+gross%p_count] loop
      deduction:=round(scheduled_amount::numeric*1200/10000)::bigint;
      if (schedule->>'enabled')::boolean then deduction:=deduction+
        round(scheduled_amount::numeric*(schedule->>'basisPoints')::integer/10000)::bigint+(schedule->>'fixedCents')::bigint; end if;
      if deduction>scheduled_amount then raise exception 'Fee exceeds installment'; end if;
    end loop;
  end loop;
  terms:=jsonb_build_object('version','exact-cents-context-v2','currency','usd','bookingId',b.id,'productId',product.id,
    'postId',b.post_id,'buyerId',b.buyer_id,'creatorId',b.creator_id,'destinationId',profile.stripe_account_id,
    'title',trim(product.title),'totalCents',gross,'paymentCount',p_count,
    'firstPaymentFeeSchedule',p_first_fee,'renewalFeeSchedule',p_renewal_fee);
  select * into saved from public.exact_installment_context_reservations_v2 where booking_id=b.id;
  if found then
    if saved.context is distinct from p_context or saved.terms is distinct from terms or
      saved.status is distinct from 'reserved_not_issuable' then raise exception 'Existing context reservation differs'; end if;
    return saved;
  end if;
  insert into public.exact_installment_context_reservations_v2(booking_id,context,terms)
    values(b.id,p_context,terms) returning * into saved;
  return saved;
end;
$$;
revoke all on function public.valid_exact_payment_context_v2(jsonb),public.guard_exact_context_immutable_v2(),
  public.guard_legacy_payment_context_v2(),public.reserve_exact_installment_context_v2(uuid,uuid,integer,jsonb,jsonb,jsonb),
  public.read_exact_installment_context_pin_v2()
  from public,anon,authenticated,service_role;
grant execute on function public.reserve_exact_installment_context_v2(uuid,uuid,integer,jsonb,jsonb,jsonb),
  public.read_exact_installment_context_pin_v2() to service_role;

-- These assertions execute before the ONLY COMMIT. Unexpected effective grants
-- (including inherited/default/column ACLs) must roll the entire proposal back.
do $context_v2_postflight$
declare relation_oid oid; role_name text; privilege_name text;
begin
  foreach relation_oid in array array['public.exact_installment_context_pin_v2'::regclass::oid,
    'public.exact_installment_context_reservations_v2'::regclass::oid] loop
    if not exists(select 1 from pg_class where oid=relation_oid and relrowsecurity and
      relowner=(select oid from pg_roles where rolname=current_user)) or
      exists(select 1 from pg_policy where polrelid=relation_oid) then raise exception 'Context v2 RLS/owner differs'; end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
        if has_table_privilege(role_name,relation_oid,privilege_name) is distinct from
          (role_name='service_role' and privilege_name='SELECT' and relation_oid='public.exact_installment_context_reservations_v2'::regclass) then
          raise exception 'Context v2 effective table ACL differs'; end if;
      end loop;
      if exists(select 1 from pg_attribute where attrelid=relation_oid and attnum>0 and not attisdropped and
        (has_column_privilege(role_name,relation_oid,attnum,'SELECT') is distinct from
          (role_name='service_role' and relation_oid='public.exact_installment_context_reservations_v2'::regclass) or
         has_column_privilege(role_name,relation_oid,attnum,'INSERT') or has_column_privilege(role_name,relation_oid,attnum,'UPDATE') or
         has_column_privilege(role_name,relation_oid,attnum,'REFERENCES'))) then raise exception 'Context v2 effective column ACL differs'; end if;
    end loop;
  end loop;
  if exists(select 1 from pg_proc p where p.oid in ('public.valid_exact_payment_context_v2(jsonb)'::regprocedure,
    'public.guard_exact_context_immutable_v2()'::regprocedure,'public.guard_legacy_payment_context_v2()'::regprocedure,
    'public.reserve_exact_installment_context_v2(uuid,uuid,integer,jsonb,jsonb,jsonb)'::regprocedure,
    'public.read_exact_installment_context_pin_v2()'::regprocedure) and
      (p.proowner<>(select oid from pg_roles where rolname=current_user) or p.proconfig is distinct from array['search_path=pg_catalog'] or
       has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or
       has_function_privilege('service_role',p.oid,'EXECUTE') is distinct from
         (p.oid in ('public.reserve_exact_installment_context_v2(uuid,uuid,integer,jsonb,jsonb,jsonb)'::regprocedure,
           'public.read_exact_installment_context_pin_v2()'::regprocedure)))) then
    raise exception 'Context v2 function configuration/ACL differs'; end if;
  if not exists(select 1 from pg_proc where oid='public.read_exact_installment_context_pin_v2()'::regprocedure
    and prosecdef and provolatile='s' and pronargs=0 and prorettype='jsonb'::regtype) then
    raise exception 'Context v2 pin reader configuration differs'; end if;
  if exists(select 1 from public.exact_installment_context_pin_v2) or
    exists(select 1 from public.exact_installment_context_reservations_v2) then raise exception 'Context v2 must install empty and disabled'; end if;
end;
$context_v2_postflight$;
commit;
