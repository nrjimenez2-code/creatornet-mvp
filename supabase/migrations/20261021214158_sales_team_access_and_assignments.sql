-- Local candidate only. Hosted catalog was inspected read-only on 2026-10-21.
-- Additive to installed booking_targets/bookings; no historical attribution.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema if not exists creatornet_team_private;
revoke all on schema creatornet_team_private from public, anon;
grant usage on schema creatornet_team_private to authenticated, service_role;

create table public.sales_team_controls_v1 (
  singleton boolean primary key default true check (singleton),
  access_enabled boolean not null default false,
  new_sales_enabled boolean not null default false,
  settlement_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.sales_team_controls_v1(singleton) values (true);

create table public.sales_team_creator_settings_v1 (
 creator_id uuid primary key references auth.users(id) on delete restrict,
 routing_enabled boolean not null default false,
 routing_enabled_at timestamptz,
 updated_at timestamptz not null default now()
);

create table public.sales_team_memberships_v1 (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null check (role in ('manager','closer')),
  is_closer boolean not null default false,
  status text not null check (status in ('invited','active','removed')),
  commission_bps integer not null check (commission_bps between 0 and 8800),
  hold_days integer not null default 14 check (hold_days between 14 and 90),
  renewal_rule text not null default 'initial_commitment' check (renewal_rule in ('initial_commitment','every_renewal')),
  commission_revision integer not null default 1 check (commission_revision > 0),
  accepted_commission_revision integer,
  accepted_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (creator_id,user_id), unique (id,creator_id),
  check (creator_id <> user_id),
  check (role <> 'closer' or is_closer),
  check (accepted_commission_revision is null or accepted_commission_revision <= commission_revision)
);
create index sales_team_memberships_user_v1 on public.sales_team_memberships_v1(user_id,creator_id);

create table public.sales_team_commission_terms_v1 (
  membership_id uuid not null references public.sales_team_memberships_v1(id) on delete restrict,
  revision integer not null,
  terms jsonb not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (membership_id,revision)
);

create table public.sales_team_invitations_v1 (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete restrict,
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  role text not null check (role in ('manager','closer')),
  is_closer boolean not null,
  commission_bps integer not null check (commission_bps between 0 and 8800),
  hold_days integer not null check (hold_days between 14 and 90),
  renewal_rule text not null check (renewal_rule in ('initial_commitment','every_renewal')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by uuid not null references auth.users(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete restrict,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (role <> 'closer' or is_closer)
);

-- Recipient ownership/capabilities are verified server-side, never set by a member.
-- No banking details or provider secrets belong in these records.
create table public.sales_team_recipients_v1 (
  user_id uuid primary key references auth.users(id) on delete restrict,
  account_id text not null unique check (account_id ~ '^acct_[A-Za-z0-9]+$'),
  platform_account_id text not null check (platform_account_id ~ '^acct_[A-Za-z0-9]+$'),
  mode text not null check (mode in ('test','live')),
  country text not null check (country='US'),
  currency text not null check (currency='usd'),
  transfers_active boolean not null default false,
  payouts_ready boolean not null default false,
  ownership_verified boolean not null default false,
  verified_at timestamptz not null,
  evidence jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.sales_team_destination_bindings_v1 (
  target_id uuid primary key references public.booking_targets(id) on delete restrict,
  creator_id uuid not null references auth.users(id) on delete restrict,
  membership_id uuid not null,
  route_count bigint not null default 0 check (route_count >= 0),
  last_assigned_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (membership_id,creator_id) references public.sales_team_memberships_v1(id,creator_id) on delete restrict,
  unique (target_id,creator_id,membership_id)
);

create table public.sales_team_assignments_v1 (
  booking_id uuid primary key references public.bookings(id) on delete restrict,
  creator_id uuid not null references auth.users(id) on delete restrict,
  target_id uuid not null,
  membership_id uuid not null,
  revision integer not null default 1,
  source text not null check (source in ('weighted','manual')),
  assigned_by uuid references auth.users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  accepted_sale_id uuid,
  foreign key (target_id,creator_id,membership_id) references public.sales_team_destination_bindings_v1(target_id,creator_id,membership_id) on delete restrict
);
create index sales_team_assignments_member_v1 on public.sales_team_assignments_v1(membership_id,booking_id);

create table public.sales_team_audit_v1 (
  id bigint generated always as identity primary key,
  creator_id uuid not null,
  actor_id uuid,
  action text not null,
  subject_id uuid not null,
  before_state jsonb,
  after_state jsonb,
  source_evidence jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Internal service helper. Every mutation rechecks the persisted membership.
create function public.sales_team_actor_role_v1(p_creator_id uuid,p_actor_id uuid)
returns text language sql stable security invoker set search_path=pg_catalog as $$
  select case when p_creator_id=p_actor_id then 'owner'
    when exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled)
    then (select m.role from public.sales_team_memberships_v1 m where m.creator_id=p_creator_id and m.user_id=p_actor_id and m.status='active') end
$$;
revoke all on function public.sales_team_actor_role_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sales_team_actor_role_v1(uuid,uuid) to service_role;

-- RLS helper has no caller-supplied identity and returns only the caller's role.
create function creatornet_team_private.current_role(p_creator_id uuid)
returns text language sql stable security definer set search_path=pg_catalog as $$
  select case when auth.uid() is null then null
    when p_creator_id=auth.uid() then 'owner'
    when exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled)
    then (select role from public.sales_team_memberships_v1 where creator_id=p_creator_id and user_id=auth.uid() and status='active') end
$$;
revoke all on function creatornet_team_private.current_role(uuid) from public,anon;
grant execute on function creatornet_team_private.current_role(uuid) to authenticated,service_role;

create function public.sales_team_member_ready_v1(p_membership_id uuid)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_memberships_v1 m join public.sales_team_recipients_v1 r on r.user_id=m.user_id
 where m.id=p_membership_id and m.status='active' and m.is_closer and m.accepted_commission_revision=m.commission_revision
 and r.transfers_active and r.payouts_ready and r.ownership_verified and r.country='US' and r.currency='usd'
 and r.verified_at>clock_timestamp()-interval '15 minutes')
$$;
revoke all on function public.sales_team_member_ready_v1(uuid) from public,anon,authenticated;
grant execute on function public.sales_team_member_ready_v1(uuid) to service_role;

-- The hosted service role cannot SELECT auth.users. Expose one confirmed email
-- only to the service transaction, rather than granting access to the Auth table.
-- A user-bound invocation may inspect only its own current identity.
create function creatornet_team_private.confirmed_email(p_user_id uuid)
returns text language sql stable security definer set search_path=pg_catalog as $$
 select lower(email) from auth.users where id=p_user_id and email_confirmed_at is not null
 and (auth.uid() is null or auth.uid()=p_user_id)
$$;
revoke all on function creatornet_team_private.confirmed_email(uuid) from public,anon,authenticated;
grant execute on function creatornet_team_private.confirmed_email(uuid) to service_role;

create function public.manage_sales_team_v1(p_creator_id uuid,p_actor_id uuid,p_action text,p_input jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare
 v_role text; v_member public.sales_team_memberships_v1; v_before jsonb; v_after jsonb;
 v_invite public.sales_team_invitations_v1; v_email text; v_id uuid; v_target public.booking_targets;
begin
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled) then raise exception 'TEAM_ACCESS_DISABLED'; end if;
 -- Serialize team administration and routing to close revoke/accept/assign races.
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||p_creator_id::text,0));
 v_role:=public.sales_team_actor_role_v1(p_creator_id,p_actor_id);
 if p_action='accept_invitation' then
   select * into v_invite from public.sales_team_invitations_v1 where creator_id=p_creator_id and token_hash=p_input->>'token_hash' for update;
   v_email:=creatornet_team_private.confirmed_email(p_actor_id);
   if v_invite.id is null or v_invite.revoked_at is not null or v_invite.expires_at<=clock_timestamp() or
      v_email is null or v_email is distinct from v_invite.email or p_actor_id=p_creator_id then raise exception 'INVITATION_UNAVAILABLE'; end if;
   if v_invite.accepted_at is not null then
     if v_invite.accepted_by<>p_actor_id then raise exception 'INVITATION_UNAVAILABLE'; end if;
     select * into v_member from public.sales_team_memberships_v1 where creator_id=p_creator_id and user_id=p_actor_id;
     return jsonb_build_object('membership_id',v_member.id,'reused',true);
   end if;
   if coalesce(public.sales_team_actor_role_v1(p_creator_id,v_invite.invited_by),'') not in ('owner','manager') or
      (v_invite.role='manager' and v_invite.invited_by<>p_creator_id) then raise exception 'INVITER_NO_LONGER_AUTHORIZED'; end if;
   select * into v_member from public.sales_team_memberships_v1 where creator_id=p_creator_id and user_id=p_actor_id for update;
   if v_member.id is not null and v_member.status<>'removed' then raise exception 'MEMBER_ALREADY_EXISTS'; end if;
   if v_member.id is not null and v_member.role='manager' and v_invite.invited_by<>p_creator_id then raise exception 'OWNER_REQUIRED'; end if;
   v_before:=to_jsonb(v_member);
   insert into public.sales_team_memberships_v1(creator_id,user_id,role,is_closer,status,commission_bps,hold_days,renewal_rule,accepted_at)
   values(p_creator_id,p_actor_id,v_invite.role,v_invite.is_closer,'active',v_invite.commission_bps,v_invite.hold_days,v_invite.renewal_rule,clock_timestamp())
   on conflict (creator_id,user_id) do update set role=excluded.role,is_closer=excluded.is_closer,status='active',
     commission_bps=excluded.commission_bps,hold_days=excluded.hold_days,renewal_rule=excluded.renewal_rule,
     commission_revision=public.sales_team_memberships_v1.commission_revision+1,accepted_commission_revision=null,
     accepted_at=clock_timestamp(),removed_at=null,updated_at=clock_timestamp() returning * into v_member;
   update public.sales_team_invitations_v1 set accepted_by=p_actor_id,accepted_at=clock_timestamp() where id=v_invite.id;
   v_id:=v_member.id; v_after:=to_jsonb(v_member);
   insert into public.sales_team_commission_terms_v1 values(v_id,v_member.commission_revision,
     jsonb_build_object('version','creatornet-team-commission-v1','commissionBps',v_member.commission_bps,'holdDays',v_member.hold_days,'renewals',v_member.renewal_rule),v_invite.invited_by,clock_timestamp());
 elsif p_action='accept_terms' then
   select * into v_member from public.sales_team_memberships_v1 where creator_id=p_creator_id and user_id=p_actor_id and status='active' for update;
   if v_member.id is null or (p_input->>'revision')::integer is distinct from v_member.commission_revision or
      p_input->>'version' is distinct from 'creatornet-team-commission-v1' or p_input->'accepted' is distinct from 'true'::jsonb then raise exception 'REVIEW_CURRENT_COMMISSION_TERMS'; end if;
   v_before:=to_jsonb(v_member); v_id:=v_member.id;
   update public.sales_team_memberships_v1 set accepted_commission_revision=commission_revision,updated_at=clock_timestamp() where id=v_id returning to_jsonb(sales_team_memberships_v1.*) into v_after;
 else
   if v_role is null or v_role not in ('owner','manager') then raise exception 'TEAM_MANAGER_REQUIRED'; end if;
   if p_action='configure_routing' then
     if jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then raise exception 'INVALID_ROUTING_SETTING'; end if;
     v_id:=p_creator_id;
     select to_jsonb(s.*) into v_before from public.sales_team_creator_settings_v1 s where creator_id=p_creator_id;
     insert into public.sales_team_creator_settings_v1(creator_id,routing_enabled,routing_enabled_at)
     values(p_creator_id,(p_input->>'enabled')::boolean,case when (p_input->>'enabled')::boolean then clock_timestamp() end)
     on conflict(creator_id) do update set routing_enabled=excluded.routing_enabled,
      routing_enabled_at=case when excluded.routing_enabled then coalesce(public.sales_team_creator_settings_v1.routing_enabled_at,clock_timestamp()) else null end,
      updated_at=clock_timestamp() returning to_jsonb(sales_team_creator_settings_v1.*) into v_after;
   elsif p_action='invite' then
     if p_input->>'role'='manager' and v_role<>'owner' then raise exception 'OWNER_REQUIRED'; end if;
     v_id:=coalesce((p_input->>'invitation_id')::uuid,gen_random_uuid());
     select * into v_invite from public.sales_team_invitations_v1 where id=v_id for update;
     if v_invite.id is not null then
       if v_invite.creator_id<>p_creator_id or v_invite.invited_by<>p_actor_id or
         v_invite.email is distinct from lower(btrim(p_input->>'email')) or v_invite.token_hash is distinct from p_input->>'token_hash' or
         v_invite.role is distinct from p_input->>'role' or v_invite.is_closer is distinct from (p_input->>'is_closer')::boolean or
         v_invite.commission_bps is distinct from (p_input->>'commission_bps')::integer or v_invite.hold_days is distinct from (p_input->>'hold_days')::integer or
         v_invite.renewal_rule is distinct from p_input->>'renewal_rule' then raise exception 'INVITATION_REQUEST_CONFLICT'; end if;
       return jsonb_build_object('id',v_id,'result',to_jsonb(v_invite)-'token_hash','reused',true);
     end if;
     insert into public.sales_team_invitations_v1(id,creator_id,email,role,is_closer,commission_bps,hold_days,renewal_rule,token_hash,invited_by,expires_at)
     values(v_id,p_creator_id,lower(btrim(p_input->>'email')),p_input->>'role',(p_input->>'is_closer')::boolean,
       (p_input->>'commission_bps')::integer,(p_input->>'hold_days')::integer,p_input->>'renewal_rule',p_input->>'token_hash',p_actor_id,clock_timestamp()+interval '7 days')
     returning id,to_jsonb(sales_team_invitations_v1.*)-'token_hash' into v_id,v_after;
   elsif p_action='revoke_invitation' then
     select * into v_invite from public.sales_team_invitations_v1 where id=(p_input->>'invitation_id')::uuid and creator_id=p_creator_id for update;
     if v_invite.id is null or v_invite.accepted_at is not null then raise exception 'INVITATION_UNAVAILABLE'; end if;
     if v_invite.role='manager' and v_role<>'owner' then raise exception 'OWNER_REQUIRED'; end if;
     v_id:=v_invite.id; v_before:=to_jsonb(v_invite)-'token_hash';
     update public.sales_team_invitations_v1 set revoked_at=clock_timestamp() where id=v_id returning to_jsonb(sales_team_invitations_v1.*)-'token_hash' into v_after;
   elsif p_action in ('configure_member','remove_member') then
     select * into v_member from public.sales_team_memberships_v1 where id=(p_input->>'membership_id')::uuid and creator_id=p_creator_id for update;
     if v_member.id is null then raise exception 'MEMBER_UNAVAILABLE'; end if;
     if (v_member.role='manager' or p_input->>'role'='manager') and v_role<>'owner' then raise exception 'OWNER_REQUIRED'; end if;
     v_id:=v_member.id; v_before:=to_jsonb(v_member);
     if p_action='remove_member' then
       update public.sales_team_memberships_v1 set status='removed',removed_at=clock_timestamp(),updated_at=clock_timestamp() where id=v_id returning to_jsonb(sales_team_memberships_v1.*) into v_after;
     else
       if v_member.status<>'active' then raise exception 'MEMBER_UNAVAILABLE'; end if;
       update public.sales_team_memberships_v1 set role=p_input->>'role',is_closer=(p_input->>'is_closer')::boolean,
        commission_bps=(p_input->>'commission_bps')::integer,hold_days=(p_input->>'hold_days')::integer,renewal_rule=p_input->>'renewal_rule',
        commission_revision=commission_revision+1,accepted_commission_revision=null,updated_at=clock_timestamp()
        where id=v_id returning * into v_member;
       v_after:=to_jsonb(v_member);
       insert into public.sales_team_commission_terms_v1 values(v_id,v_member.commission_revision,
         jsonb_build_object('version','creatornet-team-commission-v1','commissionBps',v_member.commission_bps,'holdDays',v_member.hold_days,'renewals',v_member.renewal_rule),p_actor_id,clock_timestamp());
     end if;
   elsif p_action='bind_destination' then
     select * into v_target from public.booking_targets where id=(p_input->>'target_id')::uuid and creator_id=p_creator_id for update;
     select * into v_member from public.sales_team_memberships_v1 where id=(p_input->>'membership_id')::uuid and creator_id=p_creator_id and status='active' and is_closer;
     if v_target.id is null or v_member.id is null then raise exception 'DESTINATION_MEMBER_MISMATCH'; end if;
     -- Existing assigned destinations cannot be rebound to a different person.
     v_id:=v_target.id;
     insert into public.sales_team_destination_bindings_v1(target_id,creator_id,membership_id) values(v_id,p_creator_id,v_member.id)
     on conflict(target_id) do update set membership_id=excluded.membership_id,updated_at=clock_timestamp()
     returning to_jsonb(sales_team_destination_bindings_v1.*) into v_after;
   else raise exception 'UNKNOWN_TEAM_ACTION'; end if;
 end if;
 insert into public.sales_team_audit_v1(creator_id,actor_id,action,subject_id,before_state,after_state)
 values(p_creator_id,p_actor_id,p_action,v_id,v_before,v_after);
 return jsonb_build_object('id',v_id,'result',v_after);
end $$;
revoke all on function public.manage_sales_team_v1(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.manage_sales_team_v1(uuid,uuid,text,jsonb) to service_role;

create function public.assign_sales_team_booking_v1(p_booking_id uuid,p_actor_id uuid,p_membership_id uuid default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_booking public.bookings; v_existing public.sales_team_assignments_v1; v_binding public.sales_team_destination_bindings_v1;
 v_creator uuid; v_role text; v_before jsonb; v_after jsonb; v_target public.booking_targets;
begin
 select creator_id into v_creator from public.bookings where id=p_booking_id;
 if v_creator is null then raise exception 'BOOKING_UNAVAILABLE'; end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||v_creator::text,0));
 select * into v_booking from public.bookings where id=p_booking_id for update;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled) then raise exception 'TEAM_SALES_DISABLED'; end if;
 v_role:=public.sales_team_actor_role_v1(v_creator,p_actor_id);
 if p_membership_id is not null then
   if v_role is null or v_role not in ('owner','manager') then raise exception 'TEAM_MANAGER_REQUIRED'; end if;
 elsif p_actor_id<>v_booking.buyer_id and (v_role is null or v_role not in ('owner','manager')) then raise exception 'BOOKING_UNAVAILABLE'; end if;
 -- A caller cannot forge a booking under someone else's attached offer.
 if not exists(select 1 from public.posts p where p.id=v_booking.post_id and p.creator_id=v_creator and p.allow_booking) then raise exception 'BOOKING_OFFER_MISMATCH'; end if;
 select * into v_existing from public.sales_team_assignments_v1 where booking_id=p_booking_id for update;
 if v_existing.booking_id is not null then
   if p_membership_id is null or p_membership_id=v_existing.membership_id then
     select * into v_target from public.booking_targets where id=v_existing.target_id;
     if not public.sales_team_member_ready_v1(v_existing.membership_id) or not v_target.is_active or not coalesce(v_target.active,false) or v_target.weight<=0 then raise exception 'ASSIGNED_MEMBER_UNAVAILABLE'; end if;
     return jsonb_build_object('assignment',to_jsonb(v_existing),'booking_url',v_target.booking_url,'reused',true);
   end if;
   if v_existing.accepted_sale_id is not null then raise exception 'SALE_ATTRIBUTION_FROZEN'; end if;
 end if;
 if v_booking.status='completed' or v_booking.linked_order_id is not null then raise exception 'HISTORICAL_PAYMENT_NOT_ASSIGNABLE'; end if;
 select b.* into v_binding from public.sales_team_destination_bindings_v1 b
 join public.booking_targets t on t.id=b.target_id and t.creator_id=b.creator_id
 where b.creator_id=v_creator and t.is_active and coalesce(t.active,false) and t.weight>0
 and public.sales_team_member_ready_v1(b.membership_id)
 and (p_membership_id is null or b.membership_id=p_membership_id)
 order by b.route_count::numeric/t.weight, b.last_assigned_at nulls first,b.target_id limit 1 for update of b;
 if v_binding.target_id is null then raise exception 'NO_ELIGIBLE_TEAM_DESTINATION'; end if;
 v_before:=to_jsonb(v_existing);
 insert into public.sales_team_assignments_v1(booking_id,creator_id,target_id,membership_id,source,assigned_by)
 values(p_booking_id,v_creator,v_binding.target_id,v_binding.membership_id,case when p_membership_id is null then 'weighted' else 'manual' end,p_actor_id)
 on conflict(booking_id) do update set target_id=excluded.target_id,membership_id=excluded.membership_id,source=excluded.source,
 assigned_by=p_actor_id,assigned_at=clock_timestamp(),revision=public.sales_team_assignments_v1.revision+1
 returning to_jsonb(sales_team_assignments_v1.*) into v_after;
 update public.sales_team_destination_bindings_v1 set route_count=route_count+1,last_assigned_at=clock_timestamp() where target_id=v_binding.target_id;
 insert into public.sales_team_audit_v1(creator_id,actor_id,action,subject_id,before_state,after_state)
 values(v_creator,p_actor_id,'assign_booking',p_booking_id,v_before,v_after);
 select * into v_target from public.booking_targets where id=v_binding.target_id;
 return jsonb_build_object('assignment',v_after,'booking_url',v_target.booking_url,'reused',false);
end $$;
revoke all on function public.assign_sales_team_booking_v1(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.assign_sales_team_booking_v1(uuid,uuid,uuid) to service_role;

-- All writes go through the authenticated server and service-only transactions.
do $$ declare v_name text; begin
 foreach v_name in array array['sales_team_controls_v1','sales_team_creator_settings_v1','sales_team_memberships_v1','sales_team_commission_terms_v1',
  'sales_team_invitations_v1','sales_team_recipients_v1','sales_team_destination_bindings_v1','sales_team_assignments_v1','sales_team_audit_v1'] loop
  execute format('alter table public.%I enable row level security',v_name);
  execute format('revoke all on public.%I from public,anon,authenticated',v_name);
  execute format('grant select,insert,update on public.%I to service_role',v_name);
 end loop;
end $$;
grant usage,select on sequence public.sales_team_audit_v1_id_seq to service_role;
revoke update on public.sales_team_audit_v1,public.sales_team_commission_terms_v1 from service_role;
create function creatornet_team_private.reject_history_change()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin raise exception 'TEAM_HISTORY_IS_IMMUTABLE'; end $$;
revoke all on function creatornet_team_private.reject_history_change() from public,anon,authenticated;
create trigger sales_team_audit_immutable_v1 before update or delete on public.sales_team_audit_v1
for each row execute function creatornet_team_private.reject_history_change();
create trigger sales_team_terms_immutable_v1 before update or delete on public.sales_team_commission_terms_v1
for each row execute function creatornet_team_private.reject_history_change();
grant select on public.sales_team_memberships_v1,public.sales_team_assignments_v1 to authenticated;
create policy sales_team_membership_read_v1 on public.sales_team_memberships_v1 for select to authenticated
 using (creatornet_team_private.current_role(creator_id) in ('owner','manager') or user_id=(select auth.uid()));
create policy sales_team_assignment_read_v1 on public.sales_team_assignments_v1 for select to authenticated
 using (creatornet_team_private.current_role(creator_id) in ('owner','manager') or
 (creatornet_team_private.current_role(creator_id)='closer' and exists
 (select 1 from public.sales_team_memberships_v1 m where m.id=membership_id and m.user_id=(select auth.uid()) and m.status='active')));
-- No broad team policy on bookings: the server returns a bounded, redacted DTO.
-- Existing buyer/creator policies and legacy routing protocols remain intact.
commit;
