-- Local candidate. Requires the original durable Connect creation table.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column recipient_onboarding_enabled boolean not null default false;
create table public.sales_team_recipient_setups_v1 (
 user_id uuid primary key references auth.users(id) on delete restrict,
 id uuid not null unique default gen_random_uuid(),
 api text not null check(api in ('v1','v2')),
 account_id text unique check(account_id ~ '^acct_[A-Za-z0-9]+$'),
 legacy_creation_key uuid,
 context jsonb not null,
 request jsonb,
 created_at timestamptz not null default clock_timestamp(),
 check((api='v1' and account_id is not null and legacy_creation_key is not null and request is null) or
       (api='v2' and legacy_creation_key is null and request is not null))
);
create table public.sales_team_onboarding_links_v1 (
 id uuid primary key,
 user_id uuid not null references public.sales_team_recipient_setups_v1(user_id) on delete restrict,
 request jsonb not null,
 context jsonb not null,
 status text not null check(status in ('dispatching','bound','unknown')),
 lease_token uuid not null default gen_random_uuid(),
 lease_until timestamptz not null default clock_timestamp()+interval '30 seconds',
 url text,
 expires_at timestamptz,
 provider_request_id text,
 created_at timestamptz not null default clock_timestamp(),
 check((status='bound' and url is not null and expires_at is not null and provider_request_id ~ '^req_[A-Za-z0-9]+$') or
       (status<>'bound' and url is null and expires_at is null and provider_request_id is null))
);
create index sales_team_onboarding_links_user_v1 on public.sales_team_onboarding_links_v1(user_id,created_at desc);
create unique index sales_team_onboarding_links_unresolved_v1 on public.sales_team_onboarding_links_v1(user_id) where status<>'bound';
create table public.sales_team_recipient_observations_v1 (
 user_id uuid not null references public.sales_team_recipient_setups_v1(user_id) on delete restrict,
 provider_request_id text not null check(provider_request_id ~ '^req_[A-Za-z0-9]+$'),
 context jsonb not null, observation jsonb not null,
 observed_at timestamptz not null default clock_timestamp(),
 primary key(user_id,provider_request_id)
);

create function creatornet_team_private.guard_recipient_setup_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if (to_jsonb(new)-'account_id') is distinct from (to_jsonb(old)-'account_id') or
  (old.account_id is not null and new.account_id is distinct from old.account_id) then raise exception 'ORIGINAL_RECIPIENT_SETUP_CHANGED'; end if;
 return new;
end $$;
revoke all on function creatornet_team_private.guard_recipient_setup_v1() from public,anon,authenticated,service_role;
create trigger sales_team_recipient_setup_immutable_v1 before update on public.sales_team_recipient_setups_v1
 for each row execute function creatornet_team_private.guard_recipient_setup_v1();

create function public.sales_team_recipient_allowed_v1(p_actor_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select p_actor_id is not null and (
  exists(select 1 from public.sales_team_sale_agreements_v1 where creator_id=p_actor_id or closer_id=p_actor_id) or
  exists(select 1 from public.sales_team_creator_settings_v1 where creator_id=p_actor_id) or
  exists(select 1 from public.sales_team_invitations_v1 where creator_id=p_actor_id and revoked_at is null) or
  exists(select 1 from public.sales_team_memberships_v1 where creator_id=p_actor_id or
   (user_id=p_actor_id and status='active' and is_closer and accepted_commission_revision=commission_revision)))
$$;
create function public.sales_team_recipient_dispatch_allowed_v1(p_actor_id uuid,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select public.sales_team_recipient_allowed_v1(p_actor_id) and
  exists(select 1 from public.sales_team_controls_v1 where singleton and recipient_onboarding_enabled and
   ((access_enabled and new_sales_enabled) or exists(select 1 from public.sales_team_sale_agreements_v1 where creator_id=p_actor_id or closer_id=p_actor_id))) and
  exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context and actual_pricing_verified and reserves_verified and disclosures_approved)
$$;
create function public.sales_team_recipient_continuation_v1(p_actor_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select p_actor_id is not null and (
  exists(select 1 from public.sales_team_sale_agreements_v1 where creator_id=p_actor_id or closer_id=p_actor_id) or
  exists(select 1 from public.sales_team_recipient_setups_v1 s where s.user_id=p_actor_id and
   (s.account_id is not null or exists(select 1 from public.sales_team_provider_operations_v1 o where o.scope_id=p_actor_id and
    o.kind='recipient' and o.scope_key='recipient:'||s.id::text))))
$$;

-- Cached capabilities cannot cross an approved platform-account/mode change.
create function public.sales_team_recipient_context_current_v1(p_actor_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_recipients_v1 r cross join public.sales_team_financial_config_v1 c
  left join public.sales_team_recipient_setups_v1 s on s.user_id=r.user_id
  where c.singleton and r.user_id=p_actor_id and r.mode=c.context->>'mode' and r.platform_account_id=c.context->>'platformAccountId'
  and (s.user_id is null or s.context=c.context))
$$;
create or replace function public.sales_team_member_ready_v1(p_membership_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_memberships_v1 m join public.sales_team_recipients_v1 r on r.user_id=m.user_id
  where m.id=p_membership_id and m.status='active' and m.is_closer and m.accepted_commission_revision=m.commission_revision
  and r.transfers_active and r.payouts_ready and r.ownership_verified and r.country='US' and r.currency='usd'
  and r.verified_at>clock_timestamp()-interval '15 minutes' and r.verified_at<=clock_timestamp()
  and public.sales_team_recipient_context_current_v1(m.user_id))
$$;

-- Cover the legacy admission path too. A new recipient cannot race a legacy
-- creator request and silently produce two accounts for the same login.
create function creatornet_team_private.guard_legacy_recipient_creation_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-connect-recipient:'||new.creator_id::text,0));
 if exists(select 1 from public.sales_team_recipient_setups_v1 where user_id=new.creator_id and api='v2') then
  raise exception 'TEAM_RECIPIENT_ALREADY_RESERVED';
 end if;
 return new;
end $$;
revoke all on function creatornet_team_private.guard_legacy_recipient_creation_v1() from public,anon,authenticated,service_role;
-- Deliberately fails installation if the reviewed legacy dependency is absent.
create trigger sales_team_legacy_recipient_guard_v1 before insert or update on public.stripe_connect_account_creations
 for each row execute function creatornet_team_private.guard_legacy_recipient_creation_v1();

create function public.reserve_sales_team_recipient_v1(p_actor_id uuid,p_context jsonb,p_admit_creation boolean default false)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_setup public.sales_team_recipient_setups_v1;v_legacy public.stripe_connect_account_creations;v_profile text;v_email text;v_id uuid:=gen_random_uuid();
begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-connect-recipient:'||p_actor_id::text,0));
 if not public.sales_team_recipient_allowed_v1(p_actor_id) or p_context is null or
  not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) then raise exception 'TEAM_RECIPIENT_SETUP_HELD'; end if;
 select * into v_setup from public.sales_team_recipient_setups_v1 where user_id=p_actor_id for update;
 select stripe_account_id into v_profile from public.profiles where id=p_actor_id;
 if v_setup.user_id is not null then
  if v_setup.context is distinct from p_context or (nullif(v_profile,'') is not null and v_profile is distinct from v_setup.account_id) then
   raise exception 'TEAM_RECIPIENT_IDENTITY_CONFLICT';
  end if;
  return to_jsonb(v_setup);
 end if;
 select * into v_legacy from public.stripe_connect_account_creations where creator_id=p_actor_id for update;
 if v_legacy.creator_id is not null then
  if nullif(v_legacy.stripe_account_id,'') is null then raise exception 'ORIGINAL_CONNECT_RECOVERY_REQUIRED'; end if;
  if nullif(v_profile,'') is not null and v_profile<>v_legacy.stripe_account_id then raise exception 'TEAM_RECIPIENT_IDENTITY_CONFLICT'; end if;
  insert into public.sales_team_recipient_setups_v1(user_id,api,account_id,legacy_creation_key,context)
   values(p_actor_id,'v1',v_legacy.stripe_account_id,v_legacy.idempotency_key,p_context) returning * into v_setup;
 else
  if p_admit_creation is distinct from true then return null; end if;
  if not public.sales_team_recipient_dispatch_allowed_v1(p_actor_id,p_context) then raise exception 'TEAM_RECIPIENT_SETUP_HELD'; end if;
  -- An editable profile link or old unproven team record is not creation proof.
  if nullif(v_profile,'') is not null or exists(select 1 from public.sales_team_recipients_v1 where user_id=p_actor_id) then raise exception 'TEAM_RECIPIENT_IDENTITY_CONFLICT'; end if;
  -- New account creation requires current new-activity admission. Historical
  -- obligations may recover their original setup but cannot manufacture another.
  if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled) then raise exception 'ORIGINAL_CONNECT_RECOVERY_REQUIRED'; end if;
  v_email:=creatornet_team_private.confirmed_email(p_actor_id);if v_email is null then raise exception 'VERIFIED_EMAIL_REQUIRED'; end if;
  insert into public.sales_team_recipient_setups_v1(user_id,id,api,context,request) values(p_actor_id,v_id,'v2',p_context,
   jsonb_build_object('apiVersion','2026-08-26.dahlia','method','POST','path','/v2/core/accounts','params',jsonb_build_object(
    'contact_email',v_email,'identity',jsonb_build_object('country','us'),'dashboard','express',
    'defaults',jsonb_build_object('currency','usd','responsibilities',jsonb_build_object('fees_collector','application','losses_collector','application')),
    'configuration',jsonb_build_object('recipient',jsonb_build_object('capabilities',jsonb_build_object('stripe_balance',jsonb_build_object('stripe_transfers',jsonb_build_object('requested',true))))),
    'metadata',jsonb_build_object('creatornet_user_id',p_actor_id,'creatornet_team_recipient_setup_id',v_id),
    'include',jsonb_build_array('configuration.recipient','defaults','identity','requirements')))) returning * into v_setup;
 end if;
 return to_jsonb(v_setup);
end $$;

create function public.record_sales_team_recipient_v1(p_actor_id uuid,p_context jsonb,p_observation jsonb)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare v_setup public.sales_team_recipient_setups_v1;v_operation public.sales_team_provider_operations_v1;
begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-connect-recipient:'||p_actor_id::text,0));
 select * into v_setup from public.sales_team_recipient_setups_v1 where user_id=p_actor_id for update;
 if v_setup.user_id is null or v_setup.context is distinct from p_context or not public.sales_team_recipient_allowed_v1(p_actor_id) or
  not exists(select 1 from public.sales_team_financial_config_v1 where singleton and context=p_context) or
  p_observation->>'api' is distinct from v_setup.api or p_observation->>'country' is distinct from 'US' or p_observation->>'currency' is distinct from 'usd' or
  p_observation->'ownershipVerified' is distinct from 'true'::jsonb or coalesce(p_observation->>'accountId','') !~ '^acct_[A-Za-z0-9]+$' or
  coalesce(p_observation->>'requestId','') !~ '^req_[A-Za-z0-9]+$' or jsonb_typeof(p_observation->'transfersActive') is distinct from 'boolean' or
  jsonb_typeof(p_observation->'payoutsReady') is distinct from 'boolean' or (select count(*) from jsonb_object_keys(p_observation))<>8 then raise exception 'TEAM_RECIPIENT_PROOF_INVALID'; end if;
 if v_setup.api='v2' then
  select * into v_operation from public.sales_team_provider_operations_v1 where scope_id=p_actor_id and kind='recipient' and scope_key='recipient:'||v_setup.id::text;
  if v_operation.status is distinct from 'bound' or v_operation.context is distinct from p_context or v_operation.request is distinct from v_setup.request or
   v_operation.provider_id is distinct from p_observation->>'accountId' then raise exception 'TEAM_RECIPIENT_PROOF_INVALID'; end if;
 elsif not exists(select 1 from public.stripe_connect_account_creations where creator_id=p_actor_id and
  idempotency_key=v_setup.legacy_creation_key and stripe_account_id=v_setup.account_id) then raise exception 'TEAM_RECIPIENT_IDENTITY_CONFLICT';
 end if;
 if v_setup.account_id is not null and v_setup.account_id is distinct from p_observation->>'accountId' then raise exception 'TEAM_RECIPIENT_IDENTITY_CONFLICT'; end if;
 if exists(select 1 from public.profiles where id=p_actor_id and nullif(stripe_account_id,'') is not null and stripe_account_id is distinct from p_observation->>'accountId') then raise exception 'TEAM_RECIPIENT_IDENTITY_CONFLICT'; end if;
 if exists(select 1 from public.sales_team_recipients_v1 where user_id=p_actor_id and
  (account_id is distinct from p_observation->>'accountId' or mode is distinct from p_context->>'mode' or platform_account_id is distinct from p_context->>'platformAccountId')) then
  raise exception 'TEAM_RECIPIENT_IDENTITY_CONFLICT'; end if;
 if exists(select 1 from public.sales_team_recipient_observations_v1 where user_id=p_actor_id and provider_request_id=p_observation->>'requestId' and
  (context is distinct from p_context or observation is distinct from p_observation)) then raise exception 'TEAM_RECIPIENT_PROOF_INVALID'; end if;
 insert into public.sales_team_recipient_observations_v1(user_id,provider_request_id,context,observation)
  values(p_actor_id,p_observation->>'requestId',p_context,p_observation) on conflict do nothing;
 update public.sales_team_recipient_setups_v1 set account_id=p_observation->>'accountId' where user_id=p_actor_id;
 insert into public.sales_team_recipients_v1(user_id,account_id,platform_account_id,mode,country,currency,transfers_active,payouts_ready,ownership_verified,verified_at,evidence)
  values(p_actor_id,p_observation->>'accountId',p_context->>'platformAccountId',p_context->>'mode','US','usd',(p_observation->>'transfersActive')::boolean,
   (p_observation->>'payoutsReady')::boolean,true,clock_timestamp(),p_observation)
 on conflict(user_id) do update set transfers_active=excluded.transfers_active,payouts_ready=excluded.payouts_ready,ownership_verified=true,
  verified_at=excluded.verified_at,evidence=excluded.evidence,updated_at=clock_timestamp();
end $$;

-- Preserve original behavior for payment operations; recipient admission also
-- covers removed payees whose immutable agreements still owe them money.
alter function public.sales_team_operation_admitted_v1(jsonb,jsonb) rename to sales_team_operation_admitted_before_recipient_v1;
create function public.sales_team_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if p_scope->>'kind'='recipient' then
  return p_scope->>'scopeId'=p_scope->>'actorId' and (p_scope->>'saleId') is null and (p_scope->>'creatorId') is null and
   public.sales_team_recipient_dispatch_allowed_v1((p_scope->>'actorId')::uuid,p_context) and
   exists(select 1 from public.sales_team_recipient_setups_v1 where user_id=(p_scope->>'actorId')::uuid and api='v2' and context=p_context and
    p_scope->>'scopeKey'='recipient:'||id::text and account_id is null);
 end if;
 return public.sales_team_operation_admitted_before_recipient_v1(p_scope,p_context);
end $$;

create function public.claim_sales_team_onboarding_link_v1(p_actor_id uuid,p_request_id uuid,p_context jsonb,p_request jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_setup public.sales_team_recipient_setups_v1;v_link public.sales_team_onboarding_links_v1;v_url text;v_expected jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('creatornet-connect-recipient:'||p_actor_id::text,0));
 select * into v_setup from public.sales_team_recipient_setups_v1 where user_id=p_actor_id;
 if v_setup.account_id is null or v_setup.context is distinct from p_context or not public.sales_team_recipient_dispatch_allowed_v1(p_actor_id,p_context) then raise exception 'TEAM_RECIPIENT_SETUP_HELD'; end if;
 select * into v_link from public.sales_team_onboarding_links_v1 where id=p_request_id for update;
 if v_link.id is not null then
  if v_link.user_id<>p_actor_id or v_link.request is distinct from p_request or v_link.context is distinct from p_context then raise exception 'ORIGINAL_PROVIDER_REQUEST_CHANGED'; end if;
  return jsonb_build_object('status',case when v_link.status='bound' then 'bound' when v_link.status='dispatching' and v_link.lease_until>clock_timestamp() then 'busy' else 'reconciliation_required' end,'link',to_jsonb(v_link));
 end if;
 if exists(select 1 from public.sales_team_onboarding_links_v1 where user_id=p_actor_id and status<>'bound') then raise exception 'ORIGINAL_ONBOARDING_LINK_NEEDS_REVIEW'; end if;
 if exists(select 1 from public.sales_team_onboarding_links_v1 where user_id=p_actor_id and created_at>clock_timestamp()-interval '1 minute') then raise exception 'ONBOARDING_LINK_RATE_LIMITED'; end if;
 v_url:=(p_context->>'siteOrigin')||'/dashboard/closers/payouts';
 v_expected:=jsonb_build_object('apiVersion','2026-08-26.dahlia','method','POST','path',case when v_setup.api='v1' then '/v1/account_links' else '/v2/core/account_links' end,
  'params',case when v_setup.api='v1' then jsonb_build_object('account',v_setup.account_id,'type','account_onboarding','refresh_url',v_url||'?setup=refresh','return_url',v_url||'?setup=return')
   else jsonb_build_object('account',v_setup.account_id,'use_case',jsonb_build_object('type','account_onboarding','account_onboarding',jsonb_build_object(
    'configurations',jsonb_build_array('recipient'),'refresh_url',v_url||'?setup=refresh','return_url',v_url||'?setup=return'))) end);
 if p_request is distinct from v_expected then raise exception 'TEAM_RECIPIENT_PROOF_INVALID'; end if;
 insert into public.sales_team_onboarding_links_v1(id,user_id,request,context,status) values(p_request_id,p_actor_id,p_request,p_context,'dispatching') returning * into v_link;
 return jsonb_build_object('status','dispatch','link',to_jsonb(v_link));
end $$;
create function public.assert_sales_team_onboarding_dispatch_v1(p_actor_id uuid,p_request_id uuid,p_lease_token uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare v_link public.sales_team_onboarding_links_v1;
begin
 select * into v_link from public.sales_team_onboarding_links_v1 where id=p_request_id for update;
 if v_link.id is null or v_link.user_id is distinct from p_actor_id or v_link.lease_token is distinct from p_lease_token or v_link.status<>'dispatching' or
  v_link.lease_until<=clock_timestamp() or not public.sales_team_recipient_dispatch_allowed_v1(p_actor_id,v_link.context) then raise exception 'TEAM_RECIPIENT_SETUP_HELD'; end if;
end $$;
create function public.bind_sales_team_onboarding_link_v1(p_actor_id uuid,p_request_id uuid,p_lease_token uuid,p_url text,p_expires_at timestamptz,p_provider_request_id text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare v_link public.sales_team_onboarding_links_v1;
begin
 select * into v_link from public.sales_team_onboarding_links_v1 where id=p_request_id for update;
 if v_link.id is null or v_link.user_id is distinct from p_actor_id or v_link.lease_token is distinct from p_lease_token or v_link.status<>'dispatching' or
  v_link.lease_until<=clock_timestamp() or coalesce(p_url,'') !~ '^https://(connect|accounts)\.stripe\.com/' or p_expires_at is null or p_expires_at<=clock_timestamp() or
  p_expires_at>clock_timestamp()+interval '1 hour' or coalesce(p_provider_request_id,'') !~ '^req_[A-Za-z0-9]+$' then raise exception 'TEAM_RECIPIENT_PROOF_INVALID'; end if;
 update public.sales_team_onboarding_links_v1 set status='bound',url=p_url,expires_at=p_expires_at,provider_request_id=p_provider_request_id where id=p_request_id;
end $$;
create function public.mark_sales_team_onboarding_unknown_v1(p_actor_id uuid,p_request_id uuid,p_lease_token uuid)
returns void language sql security invoker set search_path=pg_catalog as $$
 update public.sales_team_onboarding_links_v1 set status='unknown' where id=p_request_id and user_id=p_actor_id and lease_token=p_lease_token and status='dispatching'
$$;

do $$ declare v_name text;v_sig regprocedure;begin
 foreach v_name in array array['sales_team_recipient_setups_v1','sales_team_onboarding_links_v1','sales_team_recipient_observations_v1'] loop
  execute format('alter table public.%I enable row level security',v_name);execute format('revoke all on public.%I from public,anon,authenticated',v_name);
  execute format('grant select,insert,update on public.%I to service_role',v_name);
 end loop;
 revoke update on public.sales_team_recipient_observations_v1 from service_role;
 for v_sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
  ('sales_team_recipient_allowed_v1','sales_team_recipient_dispatch_allowed_v1','sales_team_recipient_continuation_v1','sales_team_recipient_context_current_v1','reserve_sales_team_recipient_v1','record_sales_team_recipient_v1',
   'sales_team_operation_admitted_v1','sales_team_operation_admitted_before_recipient_v1','claim_sales_team_onboarding_link_v1','assert_sales_team_onboarding_dispatch_v1','bind_sales_team_onboarding_link_v1','mark_sales_team_onboarding_unknown_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',v_sig);execute format('grant execute on function %s to service_role',v_sig);
 end loop;
end $$;
commit;
