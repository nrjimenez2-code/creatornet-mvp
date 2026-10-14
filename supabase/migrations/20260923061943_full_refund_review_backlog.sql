begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create index full_refund_review_attempt_v1 on public.full_server_payment_refund_object_events_v1(attempt_id);

-- Monitoring only. A recorded observation is not a resolved financial hold.
-- Count original attempts once even with duplicate/out-of-order refund events.
create function public.read_full_refund_review_backlog_v1(p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
  if p_context is null or not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Current refund review context required'; end if;
  with events as (
    select e.* from public.full_server_payment_refund_object_events_v1 e
      join public.full_server_payment_financial_holds_v1 h on h.attempt_id=e.attempt_id
      join public.server_payment_protocols_v1 s on s.attempt_id=e.attempt_id
      where s.context=p_context and s.kind='full'
  ) select jsonb_build_object('context',p_context,'observedAt',statement_timestamp(),
    'needsReview',count(distinct attempt_id),'events',count(*),
    'unapplied',count(*) filter(where applied_at is null),
    'reviewRecorded',count(*) filter(where disposition='refund_review_recorded'),
    'oldestObservedAt',min(observed_at)) into result from events;
  return result;
end $$;
revoke all on function public.read_full_refund_review_backlog_v1(jsonb) from public,anon,authenticated;
grant execute on function public.read_full_refund_review_backlog_v1(jsonb) to service_role;
commit;
