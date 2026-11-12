-- Read-only local candidate. Reuse statement authorization and immutable owners.
-- A provider payout observation never establishes bank receipt.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $parents$ begin
 perform 'public.read_sales_team_statement_v1(uuid,uuid,uuid,integer)'::regprocedure;
 perform 'public.complete_sales_team_beneficiary_payout_check_v1(uuid,uuid,jsonb,jsonb)'::regprocedure;
end $parents$;
create index sales_team_payout_statement_requests_v1 on public.sales_team_transfer_requests_v1(receipt_id,creator_id,created_at,id);

create function public.read_sales_team_payout_statement_v1(p_creator_id uuid,p_actor_id uuid,p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;entry jsonb;entries jsonb:='[]';evidence jsonb;more boolean;begin
 -- This owner decides the actor scope, accessible receipts and cursor before any
 -- payout lookup. Its accounting fields, totals and pagination stay intact.
 result:=public.read_sales_team_statement_v1(p_creator_id,p_actor_id,p_cursor,p_limit);
 if coalesce(result->>'scope','') not in ('creator','closer') or result->>'creatorId' is distinct from p_creator_id::text then
  raise exception 'TEAM_STATEMENT_ACCESS_DENIED';
 end if;
 for entry in select value from jsonb_array_elements(result->'entries') loop
  with originals as materialized (
   select q.id,q.created_at requested_at,q.beneficiary,q.amount_cents,q.context,q.destination_id,done.transfer_id,done.created_at transferred_at
   from public.sales_team_transfer_requests_v1 q
   join public.sales_team_transfer_completions_v1 done on done.request_id=q.id
   where q.receipt_id=(entry->>'receiptId')::uuid and q.sale_id=(entry->>'saleId')::uuid and q.creator_id=p_creator_id
    and (result->>'scope'='creator' or q.beneficiary='closer' and q.beneficiary_user_id=p_actor_id)
   order by q.created_at desc,q.id desc limit 21
  ), visible as (select * from originals order by requested_at desc,id desc limit 20), rows as (
   select v.id,v.requested_at,jsonb_build_object(
    'beneficiary',v.beneficiary,'transferredCents',v.amount_cents::text,'transferredAt',v.transferred_at,
    'reversedCents',(select coalesce(sum(r.amount_cents),0)::text from public.sales_team_transfer_reversal_completions_v1 r where r.transfer_request_id=v.id),
    'payoutStatus',coalesce(observed.status,'not_recorded'),'observedAt',observed.created_at,'bankConfirmed',false) row
   from visible v left join lateral (
    select o.proof->'payout'->>'status' status,o.created_at
    from public.sales_team_beneficiary_payout_observations_v1 o
    where o.request_id=v.id and o.context=v.context and o.connected_account_id=v.destination_id
     and o.proof->>'transferId'=v.transfer_id and o.proof->'bankConfirmed'='false'::jsonb
     and o.proof->'payout'->>'status' in ('pending','in_transit','paid','failed','canceled')
    order by o.created_at desc,o.check_id desc limit 1
   ) observed on true
  )
  select coalesce((select jsonb_agg(row order by requested_at desc,id desc) from rows),'[]'::jsonb),
   (select count(*)>20 from originals) into evidence,more;
  entries:=entries||jsonb_build_array(entry||jsonb_build_object('payoutEvidence',evidence,'hasMorePayoutEvidence',more));
 end loop;
 return result||jsonb_build_object('entries',entries,'payoutEvidenceAsOf',statement_timestamp());
end $$;
revoke all on function public.read_sales_team_payout_statement_v1(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_sales_team_payout_statement_v1(uuid,uuid,uuid,integer) to service_role;
commit;
