-- Presentation capability only. Retain the F49 write owner and its contract.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ begin
 perform 'public.read_sales_team_bank_exception_v1(uuid,uuid,uuid,uuid,integer)'::regprocedure;
 perform 'public.record_sales_team_bank_exception_review_v1(uuid,uuid,uuid,uuid,text,text)'::regprocedure;
end $parents$;
create function public.read_sales_team_bank_review_view_v1(p_creator_id uuid,p_actor_id uuid,p_request_id uuid,p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare result jsonb;actor_role text;allowed boolean:=false;
begin
 -- Authorization, originals, snapshots and cursor/history remain owned by F49.
 result:=public.read_sales_team_bank_exception_v1(p_creator_id,p_actor_id,p_request_id,p_cursor,p_limit);
 actor_role:=public.sales_team_actor_role_v1(p_creator_id,p_actor_id);
 if actor_role in ('owner','manager') and current_setting('transaction_isolation')='read committed' then
  select exists(select 1 from public.sales_team_bank_review_policy_v1 where singleton and enabled
   and contract_sha256=creatornet_team_private.bank_review_contract_digest_v1()) into allowed;
 end if;
 return result||jsonb_build_object('canReview',allowed);
end $$;
-- Only this wrapper may promise the client that a stale new intent did not
-- commit. A legacy repeatable-read snapshot can miss a concurrent original.
create function public.record_sales_team_bank_review_action_v1(p_review_id uuid,p_creator_id uuid,p_actor_id uuid,p_request_id uuid,p_action text,p_state_sha256 text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
begin
 if current_setting('transaction_isolation')<>'read committed' then raise exception 'BANK_REVIEW_ACTION_ISOLATION_REQUIRED';end if;
 begin
  return public.record_sales_team_bank_exception_review_v1(p_review_id,p_creator_id,p_actor_id,p_request_id,p_action,p_state_sha256);
 exception when raise_exception then
  if sqlerrm='BANK_REVIEW_STATE_CHANGED' then raise exception 'BANK_REVIEW_ACTION_STATE_CHANGED';end if;
  raise;
 end;
end $$;
revoke all on function public.read_sales_team_bank_review_view_v1(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_sales_team_bank_review_view_v1(uuid,uuid,uuid,uuid,integer) to service_role;
revoke all on function public.record_sales_team_bank_review_action_v1(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.record_sales_team_bank_review_action_v1(uuid,uuid,uuid,uuid,text,text) to service_role;
commit;
