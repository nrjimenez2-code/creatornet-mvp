begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Read-only operator projection. Applied observations never resolve a hold.
create function public.read_full_refund_review_admin_v1(p_context jsonb,p_after text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
  if p_context is null or not exists(select 1 from public.exact_installment_context_pin_v2 where singleton and context=p_context) then
    raise exception 'Current refund review context required'; end if;
  if p_after is not null and (length(p_after)>255 or p_after !~ '^evt_[A-Za-z0-9]+$') then
    raise exception 'Invalid refund review cursor'; end if;
  with page as (
    select e.event_id,e.attempt_id,e.refund_id,e.charge_id,e.observed_at,e.applied_at,e.disposition,
      h.payment_intent_id,h.financial_hold_at,h.revision,
      e.details->>'status' as refund_status,e.details->'amountCents' as amount_cents,
      (select count(*) from public.full_server_payment_refund_observations_v1 o where o.event_id=e.event_id) as observations
    from public.full_server_payment_refund_object_events_v1 e
    join public.full_server_payment_financial_holds_v1 h on h.attempt_id=e.attempt_id
    join public.server_payment_protocols_v1 s on s.attempt_id=e.attempt_id
    where s.context=p_context and s.kind='full' and (p_after is null or e.event_id collate "C">p_after collate "C")
    order by e.event_id collate "C" limit 26
  ) select jsonb_build_object('context',p_context,'backlog',public.read_full_refund_review_backlog_v1(p_context),
    'rows',coalesce(jsonb_agg(to_jsonb(page) order by event_id collate "C"),'[]'::jsonb)) into result from page;
  return result;
end $$;
revoke all on function public.read_full_refund_review_admin_v1(jsonb,text) from public,anon,authenticated;
grant execute on function public.read_full_refund_review_admin_v1(jsonb,text) to service_role;
commit;
