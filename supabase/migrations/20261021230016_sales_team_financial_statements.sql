-- Local read model. Historical financial access never restores customer access.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
create index sales_team_commission_statement_v1 on public.sales_team_commission_balances_v1(creator_id,membership_id,receipt_id);
create index sales_team_receipt_sale_v1 on public.sales_team_receipts_v1(sale_id,paid_at,id);

create function public.read_sales_team_statement_v1(p_creator_id uuid,p_actor_id uuid,p_cursor uuid default null,p_limit integer default 20)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare v_member public.sales_team_memberships_v1;v_scope text;v_cursor_at timestamptz;v_result jsonb;
begin
 if p_actor_id is null or p_creator_id is null then raise exception 'TEAM_STATEMENT_ACCESS_DENIED'; end if;
 if p_actor_id=p_creator_id then v_scope:='creator';
 else
  select * into v_member from public.sales_team_memberships_v1 where creator_id=p_creator_id and user_id=p_actor_id;
  if v_member.id is null then raise exception 'TEAM_STATEMENT_ACCESS_DENIED'; end if;
  v_scope:=case when v_member.role='manager' and v_member.status='active' then 'creator' else 'closer' end;
 end if;
 if p_limit is null or p_limit not between 1 and 50 then raise exception 'INVALID_STATEMENT_LIMIT'; end if;
 if p_cursor is not null then
  select r.paid_at into v_cursor_at from public.sales_team_commission_balances_v1 c join public.sales_team_receipts_v1 r on r.id=c.receipt_id
   where c.creator_id=p_creator_id and r.id=p_cursor and (v_scope='creator' or c.membership_id=v_member.id);
  if v_cursor_at is null then raise exception 'INVALID_STATEMENT_CURSOR'; end if;
 end if;
 with records as materialized (
  select r.id,r.paid_at,c.earned_cents,c.released_cents,c.reversed_cents,
   greatest(0,c.earned_cents-c.released_cents+c.reversed_cents) unpaid_cents,
   greatest(0,c.released_cents-c.reversed_cents-c.earned_cents) recovery_cents,
   jsonb_build_object('receiptId',r.id,'saleId',s.id,'title',s.terms->>'title','periodNumber',o.period_number,
    'membershipId',c.membership_id,'paidAt',r.paid_at,'earnedCents',c.earned_cents,'releasedCents',c.released_cents,'reversedCents',c.reversed_cents,
    'unpaidCents',greatest(0,c.earned_cents-c.released_cents+c.reversed_cents),
    'recoveryCents',greatest(0,c.released_cents-c.reversed_cents-c.earned_cents),'holdUntil',c.hold_until,
    'status',case when c.released_cents-c.reversed_cents>c.earned_cents then 'recovery_required'
      when r.dispute_hold or r.review_hold or coalesce(rt.financial_hold,false) then 'financial_review'
      when c.earned_cents<=c.released_cents-c.reversed_cents then 'no_unpaid_commission'
      when c.hold_until>clock_timestamp() then 'holding'
      when not coalesce(rec.ownership_verified and rec.transfers_active and rec.payouts_ready and rec.country='US' and rec.currency='usd'
        and rec.verified_at>clock_timestamp()-interval '15 minutes' and rec.account_id=s.terms->'distribution'->>'closerRecipientId'
        and rec.mode=s.context->>'mode' and rec.platform_account_id=s.context->>'platformAccountId',false) then 'recipient_verification_required'
      when r.available_on is null or r.available_on>clock_timestamp() then 'funds_pending'
      when not exists(select 1 from public.sales_team_controls_v1 where singleton and settlement_enabled) then 'settlement_paused'
      else 'awaiting_settlement' end,
    'bankPayoutStatus','not_recorded',
    'creatorAccounting',case when v_scope='creator' then jsonb_build_object('saleSubtotalCents',r.subtotal_cents,'refundedSubtotalCents',r.refunded_subtotal_cents,
      'combinedLossSubtotalCents',r.confirmed_loss_subtotal_cents,'platformRevenueCents',b.platform_revenue_cents,'creatorProceedsCents',b.creator_proceeds_cents,
      'creatorTransferredCents',b.creator_released_cents-b.creator_reversed_cents,'processingReserveCents',b.processing_reserve_cents,
      'actualProcessingCostCents',b.actual_processing_cost_cents,'platformProcessingCreditCents',b.platform_processing_credit_cents,
      'payoutCostReserveCents',b.payout_cost_reserve_cents,'creatorDeficitCents',b.creator_deficit_cents,'taxReserveCents',b.tax_reserve_cents) else null end) row
  from public.sales_team_commission_balances_v1 c join public.sales_team_receipts_v1 r on r.id=c.receipt_id
   join public.sales_team_sale_agreements_v1 s on s.id=c.sale_id join public.sales_team_payment_obligations_v1 o on o.id=r.obligation_id
   join public.sales_team_creator_balances_v1 b on b.receipt_id=r.id
   left join public.sales_team_payment_runtime_v1 rt on rt.sale_id=s.id left join public.sales_team_recipients_v1 rec on rec.user_id=s.closer_id
  where c.creator_id=p_creator_id and s.creator_id=p_creator_id and (v_scope='creator' or c.membership_id=v_member.id)
 ), page as (
  select * from records where p_cursor is null or (paid_at,id)<(v_cursor_at,p_cursor) order by paid_at desc,id desc limit p_limit+1
 ), visible as (select * from page order by paid_at desc,id desc limit p_limit)
 select jsonb_build_object('creatorId',p_creator_id,'scope',v_scope,'currency','usd',
  'membershipStatus',case when v_scope='creator' then null else v_member.status end,
  'totals',(select jsonb_build_object('earnedCents',coalesce(sum(earned_cents),0)::text,'releasedCents',coalesce(sum(released_cents),0)::text,
    'reversedCents',coalesce(sum(reversed_cents),0)::text,'unpaidCents',coalesce(sum(unpaid_cents),0)::text,'recoveryCents',coalesce(sum(recovery_cents),0)::text) from records),
  'entries',coalesce((select jsonb_agg(row order by paid_at desc,id desc) from visible),'[]'::jsonb),
  'nextCursor',case when (select count(*) from page)>p_limit then (select id from visible order by paid_at,id limit 1) else null end,
  'bankPayoutStatus','not_recorded') into v_result;
 return v_result;
end $$;
revoke all on function public.read_sales_team_statement_v1(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_sales_team_statement_v1(uuid,uuid,uuid,integer) to service_role;
commit;
