-- Bounded discovery of completed transfer originals. No BANK confirmation,
-- financial mutation, provider call, review closure or feature activation.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ begin
 perform 'public.read_sales_team_bank_exception_v1(uuid,uuid,uuid,uuid,integer)'::regprocedure;
end $parents$;

create index sales_team_bank_queue_creator_v1 on public.sales_team_transfer_requests_v1(creator_id,created_at desc,id desc);
create index sales_team_bank_queue_closer_v1 on public.sales_team_transfer_requests_v1(creator_id,beneficiary_user_id,created_at desc,id desc) where beneficiary='closer';

create function public.read_sales_team_bank_exception_queue_v1(p_creator_id uuid,p_actor_id uuid,p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare access jsonb;cursor_at timestamptz;entries jsonb;more boolean;
begin
 -- Reuse historical statement authorization, including removed closer history.
 access:=public.read_sales_team_statement_v1(p_creator_id,p_actor_id,null,1);
 if coalesce(access->>'scope','') not in ('creator','closer') or access->>'creatorId' is distinct from p_creator_id::text
 then raise exception 'BANK_REVIEW_ACCESS_DENIED';end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'INVALID_BANK_QUEUE_LIMIT';end if;
 if p_cursor is not null then
  select q.created_at into cursor_at from public.sales_team_transfer_requests_v1 q
  join public.sales_team_transfer_completions_v1 d on d.request_id=q.id
  where q.id=p_cursor and q.creator_id=p_creator_id
   and (access->>'scope'='creator' or q.beneficiary='closer' and q.beneficiary_user_id=p_actor_id);
  if cursor_at is null then raise exception 'INVALID_BANK_QUEUE_CURSOR';end if;
 end if;
 with originals as materialized (
  select q.id,q.created_at from public.sales_team_transfer_requests_v1 q
  join public.sales_team_transfer_completions_v1 d on d.request_id=q.id
  where q.creator_id=p_creator_id
   and (access->>'scope'='creator' or q.beneficiary='closer' and q.beneficiary_user_id=p_actor_id)
   and (p_cursor is null or (q.created_at,q.id)<(cursor_at,p_cursor))
  order by q.created_at desc,q.id desc limit p_limit+1
 ), visible as materialized (
  select * from originals order by created_at desc,id desc limit p_limit
 ), snapshots as materialized (
  select v.*,creatornet_team_private.bank_exception_snapshot_v1(p_creator_id,v.id) state from visible v
 ), rows as (
  select s.id,s.created_at,jsonb_build_object('state',s.state,
   'latestReview',(select jsonb_build_object('reviewId',r.id,'action',r.action,'actorRole',r.actor_role,
    'reviewedAt',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'appliesToCurrentState',r.state_sha256=encode(sha256(convert_to(s.state::text,'UTF8')),'hex'))
    from public.sales_team_bank_exception_reviews_v1 r where r.request_id=s.id
    order by r.created_at desc,r.id desc limit 1)) entry from snapshots s
 )
 select coalesce((select jsonb_agg(entry order by created_at desc,id desc) from rows),'[]'::jsonb),
  (select count(*)>p_limit from originals) into entries,more;
 return jsonb_build_object('creatorId',p_creator_id,'scope',access->>'scope','membershipStatus',access->'membershipStatus',
  'entries',entries,'hasMore',more,'nextCursor',case when more then entries->(jsonb_array_length(entries)-1)->'state'->>'requestId' else null end,
  'readAt',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'bankConfirmed',false,'outstanding',true);
end $$;
revoke all on function public.read_sales_team_bank_exception_queue_v1(uuid,uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_sales_team_bank_exception_queue_v1(uuid,uuid,uuid,integer) to service_role;
commit;
