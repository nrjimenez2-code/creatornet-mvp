-- Default-off wrapper admission contract. No F49 owner/contract or activation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ begin
 perform 'public.read_sales_team_bank_review_view_v1(uuid,uuid,uuid,uuid,integer)'::regprocedure;
 perform 'public.record_sales_team_bank_review_action_v1(uuid,uuid,uuid,uuid,text,text)'::regprocedure;
end $parents$;
create table public.sales_team_bank_review_actions_policy_v1(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 contract_sha256 text check(contract_sha256~'^[a-f0-9]{64}$')
);
insert into public.sales_team_bank_review_actions_policy_v1(singleton) values(true);

create function creatornet_team_private.bank_review_actions_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(coalesce(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\n' order by p.oid::regprocedure::text collate "C"),'')
  ||':'||creatornet_team_private.bank_review_contract_digest_v1(),'UTF8')),'hex')
 from pg_proc p where p.pronamespace='creatornet_team_private'::regnamespace and p.proname in ('bank_review_actions_contract_digest_v1','bank_review_actions_ready_v1')
 or p.pronamespace='public'::regnamespace and p.proname in ('read_sales_team_bank_review_view_v1','record_sales_team_bank_review_action_v1')
$$;
create function creatornet_team_private.bank_review_actions_ready_v1()
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select exists(select 1 from public.sales_team_bank_review_actions_policy_v1 where singleton and enabled
  and contract_sha256=creatornet_team_private.bank_review_actions_contract_digest_v1())
$$;
create or replace function public.read_sales_team_bank_review_view_v1(p_creator_id uuid,p_actor_id uuid,p_request_id uuid,p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;actor_role text;allowed boolean:=false;
begin
 result:=public.read_sales_team_bank_exception_v1(p_creator_id,p_actor_id,p_request_id,p_cursor,p_limit);
 actor_role:=public.sales_team_actor_role_v1(p_creator_id,p_actor_id);
 if actor_role in ('owner','manager') and current_setting('transaction_isolation')='read committed' then
  select creatornet_team_private.bank_review_actions_ready_v1() and exists(select 1 from public.sales_team_bank_review_policy_v1 where singleton and enabled
   and contract_sha256=creatornet_team_private.bank_review_contract_digest_v1()) into allowed;
 end if;
 return result||jsonb_build_object('canReview',allowed);
end $$;
create or replace function public.record_sales_team_bank_review_action_v1(p_review_id uuid,p_creator_id uuid,p_actor_id uuid,p_request_id uuid,p_action text,p_state_sha256 text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'BANK_REVIEW_ACTION_ISOLATION_REQUIRED';end if;
 if not creatornet_team_private.bank_review_actions_ready_v1() then raise exception 'BANK_REVIEW_ACTION_AUTHORITY_REQUIRED';end if;
 begin
  result:=public.record_sales_team_bank_exception_review_v1(p_review_id,p_creator_id,p_actor_id,p_request_id,p_action,p_state_sha256);
  if not creatornet_team_private.bank_review_actions_ready_v1() then raise exception 'BANK_REVIEW_ACTION_AUTHORITY_REQUIRED';end if;
  return result;
 exception when raise_exception then
  if sqlerrm='BANK_REVIEW_STATE_CHANGED' then raise exception 'BANK_REVIEW_ACTION_STATE_CHANGED';end if;
  raise;
 end;
end $$;
alter table public.sales_team_bank_review_actions_policy_v1 enable row level security;
revoke all on public.sales_team_bank_review_actions_policy_v1 from public,anon,authenticated,service_role;
grant select on public.sales_team_bank_review_actions_policy_v1 to service_role;
revoke all on function creatornet_team_private.bank_review_actions_contract_digest_v1(),creatornet_team_private.bank_review_actions_ready_v1() from public,anon,authenticated,service_role;
revoke all on function public.read_sales_team_bank_review_view_v1(uuid,uuid,uuid,uuid,integer),public.record_sales_team_bank_review_action_v1(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.read_sales_team_bank_review_view_v1(uuid,uuid,uuid,uuid,integer),public.record_sales_team_bank_review_action_v1(uuid,uuid,uuid,uuid,text,text) to service_role;
commit;
