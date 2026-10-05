begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.full_refund_review_acknowledgements_v1 (
  request_id uuid primary key,
  event_id text not null references public.full_server_payment_refund_object_events_v1(event_id),
  actor_id uuid not null references public.profiles(id),
  revision bigint not null check(revision>=0),
  context jsonb not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create index full_refund_review_ack_event_v1 on public.full_refund_review_acknowledgements_v1(event_id,recorded_at desc,request_id);
alter table public.full_refund_review_acknowledgements_v1 enable row level security;
revoke all on public.full_refund_review_acknowledgements_v1 from public,anon,authenticated,service_role;

-- An acknowledgement records human review only. Never remove a hold or suppress
-- monitoring. Replayed requests retain the original actor/event/revision.
create function public.acknowledge_full_refund_review_v1(p_context jsonb,p_actor_id uuid,p_request_id uuid,p_event_id text,p_revision bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare h public.full_server_payment_financial_holds_v1%rowtype; a public.full_refund_review_acknowledgements_v1%rowtype;
begin
  if p_context is null or not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) or
    not exists(select 1 from public.profiles where id=p_actor_id and role='admin') then raise exception 'Current admin review context required'; end if;
  if p_request_id is null or p_revision is null or p_revision<0 then raise exception 'Review identity required'; end if;
  -- Serializes duplicate request IDs even when they target different originals.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,73592));
  select hold.* into h from public.full_server_payment_financial_holds_v1 hold
    join public.full_server_payment_refund_object_events_v1 e on e.attempt_id=hold.attempt_id
    join public.server_payment_protocols_v1 s on s.attempt_id=hold.attempt_id
    where e.event_id=p_event_id and s.kind='full' and s.context=p_context for update of hold;
  if not found then raise exception 'Original held refund required'; end if;
  select * into a from public.full_refund_review_acknowledgements_v1 where request_id=p_request_id;
  if found then
    if a.event_id is distinct from p_event_id or a.actor_id is distinct from p_actor_id or a.revision is distinct from p_revision or a.context is distinct from p_context then
      raise exception 'Review request identity differs'; end if;
  else
    if h.revision<>p_revision then raise exception 'Review snapshot changed'; end if;
    insert into public.full_refund_review_acknowledgements_v1(request_id,event_id,actor_id,revision,context)
      values(p_request_id,p_event_id,p_actor_id,p_revision,p_context) returning * into a;
  end if;
  return jsonb_build_object('status','review_recorded_hold_retained','requestId',a.request_id,'eventId',a.event_id,
    'revision',a.revision,'recordedAt',a.recorded_at,'current',h.revision=a.revision);
end $$;
revoke all on function public.acknowledge_full_refund_review_v1(jsonb,uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.acknowledge_full_refund_review_v1(jsonb,uuid,uuid,text,bigint) to service_role;

create function public.read_full_refund_review_admin_ack_v1(p_context jsonb,p_after text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb; rows jsonb;
begin
  result:=public.read_full_refund_review_admin_v1(p_context,p_after);
  select coalesce(jsonb_agg(r.value || jsonb_build_object('last_review',(
    select jsonb_build_object('revision',a.revision,'recordedAt',a.recorded_at)
      from public.full_refund_review_acknowledgements_v1 a where a.event_id=r.value->>'event_id' and a.context=p_context
      order by a.recorded_at desc,a.request_id desc limit 1)) order by r.ordinality),'[]'::jsonb)
    into rows from jsonb_array_elements(result->'rows') with ordinality r;
  return jsonb_set(result,'{rows}',rows);
end $$;
revoke all on function public.read_full_refund_review_admin_ack_v1(jsonb,text) from public,anon,authenticated;
grant execute on function public.read_full_refund_review_admin_ack_v1(jsonb,text) to service_role;
commit;
