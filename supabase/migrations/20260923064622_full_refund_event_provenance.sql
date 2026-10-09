begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Missing historical provenance stays missing. Never infer an event's creation
-- time from local receipt time, current time, or a different provider event.
alter table public.full_server_payment_refund_object_events_v1 add column event_created bigint
  check(event_created>0);

create function public.hold_full_server_refund_event_v1(p_attempt_id uuid,p_buyer_id uuid,p_context jsonb,
  p_event_id text,p_refund_id text,p_payment_intent_id text,p_charge_id text,p_event_created bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare basis jsonb; e public.full_server_payment_refund_object_events_v1%rowtype; current_revision bigint;
begin
  if p_event_created is null or p_event_created<=0 or p_event_created>extract(epoch from clock_timestamp()) then
    raise exception 'Original refund event time required'; end if;
  -- Reuse the owned source/PI/receipt locks, immutable locator and access hold.
  basis:=public.hold_full_server_payment_refund_object_v1(p_attempt_id,p_buyer_id,p_context,p_event_id,p_refund_id,p_payment_intent_id,p_charge_id);
  select * into e from public.full_server_payment_refund_object_events_v1 where event_id=p_event_id for update;
  if (e.event_created is not null and e.event_created<>p_event_created) or
    (e.details is not null and e.details->>'eventCreated' is distinct from p_event_created::text) or
    exists(select 1 from public.full_server_payment_refund_observations_v1 o where o.event_id=p_event_id and
      o.observation->>'eventCreated' is distinct from p_event_created::text) then
    raise exception 'Original refund event time differs'; end if;
  if e.event_created is null then
    update public.full_server_payment_refund_object_events_v1 set event_created=p_event_created where event_id=p_event_id;
    -- New durable evidence invalidates a previously reviewed financial basis.
    update public.full_server_payment_financial_holds_v1 set revision=revision+1 where attempt_id=p_attempt_id returning revision into current_revision;
    basis:=jsonb_set(basis,'{revision}',to_jsonb(current_revision));
  end if;
  return basis;
end $$;
revoke all on function public.hold_full_server_refund_event_v1(uuid,uuid,jsonb,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.hold_full_server_refund_event_v1(uuid,uuid,jsonb,text,text,text,text,bigint) to service_role;

create function public.guard_full_refund_event_time_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if old.event_created is not null and new.event_created is distinct from old.event_created then
    raise exception 'Original refund event time immutable'; end if;
  if new.event_created is not null and new.details is not null and new.details->>'eventCreated' is distinct from new.event_created::text then
    raise exception 'Original refund event details differ'; end if;
  return new;
end $$;
create trigger full_refund_event_time_v1 before update on public.full_server_payment_refund_object_events_v1
  for each row execute function public.guard_full_refund_event_time_v1();
revoke all on function public.guard_full_refund_event_time_v1() from public,anon,authenticated,service_role;

create function public.guard_full_refund_observation_time_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare original_created bigint;
begin
  select event_created into original_created from public.full_server_payment_refund_object_events_v1 where event_id=new.event_id;
  if original_created is null or new.observation->>'eventCreated' is distinct from original_created::text then
    raise exception 'Bound original refund event time required'; end if;
  return new;
end $$;
create trigger full_refund_observation_time_v1 before insert or update on public.full_server_payment_refund_observations_v1
  for each row execute function public.guard_full_refund_observation_time_v1();
revoke all on function public.guard_full_refund_observation_time_v1() from public,anon,authenticated,service_role;
commit;
