-- Additive, service-only configuration. No product/account/payment rows change.
begin;
-- Service role has no direct SELECT on auth.users in the verified production schema.
-- Keep the two narrowly scoped identity readers outside the exposed API schema.
create schema website_release_private;
revoke all on schema website_release_private from public, anon, authenticated;
grant usage on schema website_release_private to service_role;
create function website_release_private.verified_account_v1(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=p_user and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null) and p.banned_at is null);
$$;
create function website_release_private.existing_email_v1(p_email text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email)=lower(p_email) and email_confirmed_at is not null limit 1;
$$;
revoke all on function website_release_private.verified_account_v1(uuid), website_release_private.existing_email_v1(text) from public, anon, authenticated;
grant execute on function website_release_private.verified_account_v1(uuid), website_release_private.existing_email_v1(text) to service_role;
create table public.website_release_settings_v1 (
  id uuid primary key check (id = '00000000-0000-4000-8000-000000000001'),
  owner_id uuid references auth.users(id),
  hidden boolean not null default true,
  features jsonb not null default '{"registration":false,"feed":false,"profiles":false,"search":false,"engagement":false,"publishing":false,"products":false,"checkout":false,"tips":false,"memberships":false,"scheduling":false,"notifications":false,"analytics":false,"creatorTools":false}',
  discord_invite text,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  check (discord_invite is null or discord_invite ~ '^https://(discord[.]gg/[A-Za-z0-9-]+|discord[.]com/invite/[A-Za-z0-9-]+)$')
);
create table public.website_release_testers_v1 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now()
);
alter table public.website_release_settings_v1 enable row level security;
alter table public.website_release_testers_v1 enable row level security;
revoke all on public.website_release_settings_v1, public.website_release_testers_v1 from public, anon, authenticated;
grant select, insert, update, delete on public.website_release_settings_v1, public.website_release_testers_v1 to service_role;
-- Owner verified through Auth and confirmed by the owner for this release.
insert into public.website_release_settings_v1(id,owner_id) values ('00000000-0000-4000-8000-000000000001','767658b6-7b2a-4cc4-91b4-6a0f78073a8e');

create function public.valid_website_release_flags_v1(p_flags jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select jsonb_typeof(p_flags) = 'object'
    and p_flags - array['registration','feed','profiles','search','engagement','publishing','products','checkout','tips','memberships','scheduling','notifications','analytics','creatorTools'] = '{}'::jsonb
    and p_flags ?& array['registration','feed','profiles','search','engagement','publishing','products','checkout','tips','memberships','scheduling','notifications','analytics','creatorTools']
    and not exists(select 1 from jsonb_each(p_flags) f where jsonb_typeof(f.value) <> 'boolean')
    and (p_flags->>'search' <> 'true' or (p_flags->>'feed' = 'true' and p_flags->>'profiles' = 'true'))
    and (p_flags->>'engagement' <> 'true' or (p_flags->>'feed' = 'true' and p_flags->>'profiles' = 'true'))
    and (p_flags->>'publishing' <> 'true' or p_flags->>'profiles' = 'true')
    and (p_flags->>'products' <> 'true' or p_flags->>'profiles' = 'true')
    and (p_flags->>'checkout' <> 'true' or p_flags->>'products' = 'true')
    and (p_flags->>'tips' <> 'true' or p_flags->>'feed' = 'true')
    and (p_flags->>'memberships' <> 'true' or (p_flags->>'products' = 'true' and p_flags->>'checkout' = 'true'))
    and (p_flags->>'scheduling' <> 'true' or (p_flags->>'profiles' = 'true' and p_flags->>'checkout' = 'true'))
    and (p_flags->>'analytics' <> 'true' or p_flags->>'publishing' = 'true')
    and (p_flags->>'creatorTools' <> 'true' or p_flags->>'profiles' = 'true');
$$;
alter table public.website_release_settings_v1 add constraint website_release_flags_valid check (public.valid_website_release_flags_v1(features));

create function public.update_website_release_v1(p_actor uuid, p_revision bigint, p_hidden boolean, p_features jsonb, p_invite text) returns void
language plpgsql security invoker set search_path = '' as $$
declare previous public.website_release_settings_v1;
begin
  select * into strict previous from public.website_release_settings_v1 where id='00000000-0000-4000-8000-000000000001' for update;
  if p_actor is distinct from previous.owner_id or p_actor is null or not website_release_private.verified_account_v1(p_actor) then raise exception 'Release owner required'; end if;
  if p_revision is null or previous.revision <> p_revision then raise exception 'Release settings changed; reload'; end if;
  if p_hidden is null or p_invite is null or p_invite !~ '^https://(discord[.]gg/[A-Za-z0-9-]+|discord[.]com/invite/[A-Za-z0-9-]+)$' or public.valid_website_release_flags_v1(p_features) is not true then raise exception 'Invalid release settings'; end if;
  update public.website_release_settings_v1 set hidden=p_hidden,features=p_features,discord_invite=p_invite,revision=revision+1,updated_at=now() where id=previous.id;
  insert into public.admin_actions(actor_id,action,target_table,target_id,reason) values(p_actor,'website_release_update','website_release_settings_v1',previous.id,jsonb_build_object('before',to_jsonb(previous),'after',jsonb_build_object('hidden',p_hidden,'features',p_features,'discord_invite',p_invite,'revision',p_revision+1))::text);
end;
$$;
create function public.set_website_tester_v1(p_actor uuid, p_revision bigint, p_user uuid, p_approved boolean) returns void
language plpgsql security invoker set search_path = '' as $$
declare current_settings public.website_release_settings_v1;
begin
  select * into strict current_settings from public.website_release_settings_v1 where id='00000000-0000-4000-8000-000000000001' for update;
  if p_actor is null or p_actor is distinct from current_settings.owner_id or not website_release_private.verified_account_v1(p_actor) then raise exception 'Release owner required'; end if;
  if p_revision is null or p_revision <> current_settings.revision then raise exception 'Release settings changed; reload'; end if;
  if p_user is null or p_approved is null or p_user=current_settings.owner_id then raise exception 'Invalid tester'; end if;
  if p_approved and not website_release_private.verified_account_v1(p_user) then raise exception 'Existing verified account required'; end if;
  if p_approved then
    insert into public.website_release_testers_v1(user_id,approved_by) values(p_user,p_actor) on conflict(user_id) do nothing;
  else delete from public.website_release_testers_v1 where user_id=p_user;
  end if;
  update public.website_release_settings_v1 set revision=revision+1,updated_at=now() where id=current_settings.id;
  insert into public.admin_actions(actor_id,action,target_table,target_id,reason) values(p_actor,case when p_approved then 'website_tester_approve' else 'website_tester_revoke' end,'website_release_testers_v1',p_user,jsonb_build_object('revision',p_revision+1)::text);
end;
$$;
-- Existing-account check for the website's custom email sign-in. Never client-callable.
create function public.website_existing_email_v1(p_email text) returns uuid
language sql stable security invoker set search_path = '' as $$
  select website_release_private.existing_email_v1(p_email);
$$;
revoke all on function public.valid_website_release_flags_v1(jsonb), public.update_website_release_v1(uuid,bigint,boolean,jsonb,text), public.set_website_tester_v1(uuid,bigint,uuid,boolean), public.website_existing_email_v1(text) from public, anon, authenticated;
grant execute on function public.valid_website_release_flags_v1(jsonb), public.update_website_release_v1(uuid,bigint,boolean,jsonb,text), public.set_website_tester_v1(uuid,bigint,uuid,boolean), public.website_existing_email_v1(text) to service_role;
commit;
