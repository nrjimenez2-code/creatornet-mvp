-- Local review history only. A review never confirms BANK or releases money.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ begin
 perform 'public.read_sales_team_payout_statement_v1(uuid,uuid,uuid,integer)'::regprocedure;
 perform 'public.sales_team_actor_role_v1(uuid,uuid)'::regprocedure;
end $parents$;

create table public.sales_team_bank_review_policy_v1 (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 contract_sha256 text check(contract_sha256~'^[a-f0-9]{64}$')
);
insert into public.sales_team_bank_review_policy_v1(singleton) values(true);
create table public.sales_team_bank_exception_reviews_v1 (
 id uuid primary key,
 request_id uuid not null references public.sales_team_transfer_completions_v1(request_id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 actor_id uuid not null references auth.users(id) on delete restrict,
 actor_role text not null check(actor_role in ('owner','manager')),
 action text not null check(action in ('acknowledged','escalated')),
 state_sha256 text not null check(state_sha256~'^[a-f0-9]{64}$'),
 snapshot jsonb not null check(snapshot->'bankConfirmed'='false'::jsonb and snapshot->'outstanding'='true'::jsonb),
 created_at timestamptz not null default clock_timestamp()
);
create index sales_team_bank_exception_review_history_v1 on public.sales_team_bank_exception_reviews_v1(request_id,created_at desc,id desc);
create trigger sales_team_bank_exception_review_immutable_v1 before update or delete on public.sales_team_bank_exception_reviews_v1
 for each row execute function creatornet_team_private.reject_history_change();

create function creatornet_team_private.bank_exception_snapshot_v1(p_creator_id uuid,p_request_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q public.sales_team_transfer_requests_v1;d public.sales_team_transfer_completions_v1;
 o public.sales_team_beneficiary_payout_observations_v1;reversed bigint;reason text;
begin
 select * into q from public.sales_team_transfer_requests_v1 where id=p_request_id and creator_id=p_creator_id;
 select * into d from public.sales_team_transfer_completions_v1 where request_id=p_request_id;
 if q.id is null or d.request_id is null then raise exception 'BANK_REVIEW_ORIGINAL_REQUIRED';end if;
 select * into o from public.sales_team_beneficiary_payout_observations_v1
 where request_id=q.id and context=q.context and connected_account_id=q.destination_id
  and proof->>'transferId'=d.transfer_id and proof->'bankConfirmed'='false'::jsonb
  and proof->'payout'->>'status' in ('pending','in_transit','paid','failed','canceled')
 order by created_at desc,check_id desc limit 1;
 select coalesce(sum(amount_cents),0) into reversed from public.sales_team_transfer_reversal_completions_v1 where transfer_request_id=q.id;
 reason:=case when reversed>0 then 'transfer_reversed' when o.check_id is null then 'payout_observation_missing'
  when o.proof->'payout'->>'status'='failed' then 'payout_failed' when o.proof->'payout'->>'status'='canceled' then 'payout_canceled'
  else 'bank_confirmation_pending' end;
 return jsonb_build_object('requestId',q.id,'creatorId',q.creator_id,'beneficiary',q.beneficiary,
  'transferredCents',q.amount_cents::text,'transferredAt',to_char(d.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'reversedCents',reversed::text,
  'checkId',o.check_id,'payoutStatus',coalesce(o.proof->'payout'->>'status','not_recorded'),
  'observedAt',to_char(o.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'reason',reason,'bankConfirmed',false,'outstanding',true);
end $$;

create function creatornet_team_private.bank_review_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\n' order by p.oid::regprocedure::text collate "C"),'UTF8')),'hex')
 from pg_proc p where (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in
 ('bank_exception_snapshot_v1','bank_review_contract_digest_v1','bank_review_authority_v1','reject_history_change')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('sales_team_actor_role_v1','read_sales_team_statement_v1',
 'read_sales_team_bank_exception_v1','record_sales_team_bank_exception_review_v1'))
$$;
create function creatornet_team_private.bank_review_authority_v1()
returns void language plpgsql stable security invoker set search_path=pg_catalog as $$
begin
 if not exists(select 1 from public.sales_team_bank_review_policy_v1 where singleton and enabled
  and contract_sha256=creatornet_team_private.bank_review_contract_digest_v1())
 then raise exception 'BANK_REVIEW_AUTHORITY_REQUIRED';end if;
end $$;

create function public.read_sales_team_bank_exception_v1(p_creator_id uuid,p_actor_id uuid,p_request_id uuid,p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare access jsonb;snapshot jsonb;digest text;cursor_at timestamptz;history jsonb;more boolean;
begin
 access:=public.read_sales_team_statement_v1(p_creator_id,p_actor_id,null,1);
 if coalesce(access->>'scope','') not in ('creator','closer') or access->>'creatorId' is distinct from p_creator_id::text or
  not exists(select 1 from public.sales_team_transfer_requests_v1 q where q.id=p_request_id and q.creator_id=p_creator_id
   and (access->>'scope'='creator' or q.beneficiary='closer' and q.beneficiary_user_id=p_actor_id))
 then raise exception 'BANK_REVIEW_ACCESS_DENIED';end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'INVALID_BANK_REVIEW_LIMIT';end if;
 if p_cursor is not null then
  select created_at into cursor_at from public.sales_team_bank_exception_reviews_v1 where id=p_cursor and request_id=p_request_id;
  if cursor_at is null then raise exception 'INVALID_BANK_REVIEW_CURSOR';end if;
 end if;
 snapshot:=creatornet_team_private.bank_exception_snapshot_v1(p_creator_id,p_request_id);
 digest:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 with rows as materialized (
  select id,created_at,actor_role,action,state_sha256 from public.sales_team_bank_exception_reviews_v1
  where request_id=p_request_id and (p_cursor is null or (created_at,id)<(cursor_at,p_cursor))
  order by created_at desc,id desc limit p_limit+1
 ), visible as (select * from rows order by created_at desc,id desc limit p_limit)
 select coalesce((select jsonb_agg(jsonb_build_object('reviewId',id,'reviewedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'actorRole',actor_role,
   'action',action,'appliesToCurrentState',state_sha256=digest) order by created_at desc,id desc) from visible),'[]'::jsonb),
  (select count(*)>p_limit from rows) into history,more;
 return jsonb_build_object('state',snapshot,'stateSha256',digest,'history',history,'hasMoreHistory',more,
  'nextCursor',case when more then history->(jsonb_array_length(history)-1)->>'reviewId' else null end);
end $$;

create function public.record_sales_team_bank_exception_review_v1(p_review_id uuid,p_creator_id uuid,p_actor_id uuid,p_request_id uuid,p_action text,p_state_sha256 text)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare actor_role text;old public.sales_team_bank_exception_reviews_v1;snapshot jsonb;digest text;
begin
 if p_review_id is null or p_creator_id is null or p_actor_id is null or p_request_id is null or
  p_action is null or p_action not in ('acknowledged','escalated') or p_state_sha256 is null or p_state_sha256!~'^[a-f0-9]{64}$'
 then raise exception 'CURRENT_BANK_REVIEW_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||p_creator_id::text,0));
 actor_role:=public.sales_team_actor_role_v1(p_creator_id,p_actor_id);
 if actor_role is null or actor_role not in ('owner','manager') then raise exception 'TEAM_MANAGER_REQUIRED';end if;
 perform creatornet_team_private.bank_review_authority_v1();
 select * into old from public.sales_team_bank_exception_reviews_v1 where id=p_review_id;
 if old.id is not null then
  if old.creator_id is distinct from p_creator_id or old.actor_id is distinct from p_actor_id or old.request_id is distinct from p_request_id
   or old.action is distinct from p_action or old.state_sha256 is distinct from p_state_sha256 then raise exception 'ORIGINAL_BANK_REVIEW_REQUIRED';end if;
  return jsonb_build_object('reviewId',old.id,'recorded',false,'bankConfirmed',false,'outstanding',true);
 end if;
 snapshot:=creatornet_team_private.bank_exception_snapshot_v1(p_creator_id,p_request_id);
 digest:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 if digest is distinct from p_state_sha256 then raise exception 'BANK_REVIEW_STATE_CHANGED';end if;
 insert into public.sales_team_bank_exception_reviews_v1(id,request_id,creator_id,actor_id,actor_role,action,state_sha256,snapshot)
 values(p_review_id,p_request_id,p_creator_id,p_actor_id,actor_role,p_action,digest,snapshot);
 if public.sales_team_actor_role_v1(p_creator_id,p_actor_id) is distinct from actor_role then raise exception 'TEAM_MANAGER_REQUIRED';end if;
 perform creatornet_team_private.bank_review_authority_v1();
 return jsonb_build_object('reviewId',p_review_id,'recorded',true,'bankConfirmed',false,'outstanding',true);
end $$;

alter table public.sales_team_bank_review_policy_v1 enable row level security;
alter table public.sales_team_bank_exception_reviews_v1 enable row level security;
revoke all on public.sales_team_bank_review_policy_v1,public.sales_team_bank_exception_reviews_v1 from public,anon,authenticated,service_role;
grant select on public.sales_team_bank_review_policy_v1,public.sales_team_bank_exception_reviews_v1 to service_role;
revoke all on function creatornet_team_private.bank_exception_snapshot_v1(uuid,uuid),creatornet_team_private.bank_review_contract_digest_v1(),creatornet_team_private.bank_review_authority_v1() from public,anon,authenticated,service_role;
revoke all on function public.read_sales_team_bank_exception_v1(uuid,uuid,uuid,uuid,integer),public.record_sales_team_bank_exception_review_v1(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.read_sales_team_bank_exception_v1(uuid,uuid,uuid,uuid,integer),public.record_sales_team_bank_exception_review_v1(uuid,uuid,uuid,uuid,text,text) to service_role;
commit;
