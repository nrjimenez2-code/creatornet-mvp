-- Local candidate. Retained shares offset duplicate cash encumbrance only;
-- accepted earnings, tax, reserves and provider identities are not rewritten.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column retained_refund_funding_enabled boolean not null default false;
alter table public.sales_team_cash_policy_v1 add column retained_contract_sha256 text check(retained_contract_sha256~'^[a-f0-9]{64}$');
alter table public.sales_team_cash_reservations_v1
 add column retained_creator_cents bigint not null default 0 check(retained_creator_cents>=0),
 add column retained_commission_cents bigint not null default 0 check(retained_commission_cents>=0),
 add column creator_unpaid_floor_cents bigint not null default 0 check(creator_unpaid_floor_cents>=0),
 add column commission_unpaid_floor_cents bigint not null default 0 check(commission_unpaid_floor_cents>=0),
 add column retained_evidence jsonb not null default '{}',
 add constraint sales_team_retained_principal_v1 check(retained_creator_cents+retained_commission_cents<=principal_cents);

create function creatornet_team_private.refund_retained_cash_plan_v1(p_request_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q public.sales_team_refund_requests_v1;r public.sales_team_receipts_v1;a public.sales_team_sale_agreements_v1;item record;
 net bigint;cum bigint:=0;previous bigint:=0;commission bigint;creator numeric;creator_unpaid bigint;commission_unpaid bigint;
 original_creator_unpaid bigint;original_commission_unpaid bigint;target_creator_floor bigint;target_commission_floor bigint;
 old_total numeric:=0;new_total numeric:=0;platform_return bigint;fee_upper bigint;platform_total bigint;new_loss bigint;
 creator_credit bigint:=0;commission_credit bigint:=0;budget bigint;eligible boolean;bps integer;
begin
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and retained_refund_funding_enabled) then
  return jsonb_build_object('creatorCents',0,'commissionCents',0,'creatorFloorCents',0,'commissionFloorCents',0,'evidence','{}'::jsonb);
 end if;
 if not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1()) then raise exception 'RETAINED_CASH_CONTRACT_REVIEW_REQUIRED';end if;
 select * into q from public.sales_team_refund_requests_v1 where id=p_request_id;
 select * into r from public.sales_team_receipts_v1 where id=q.receipt_id;
 select * into a from public.sales_team_sale_agreements_v1 where id=q.sale_id;
 if q.id is null or r.id is null or a.id is null or q.creator_id<>a.creator_id or r.sale_id<>a.id or q.context is distinct from a.context or r.processing_cost_cents is null or
  r.confirmed_loss_subtotal_cents>r.refunded_subtotal_cents or q.refunded_before_cents<>r.refunded_subtotal_cents or q.amount_cents>r.subtotal_cents-r.refunded_subtotal_cents then raise exception 'CURRENT_RETAINED_REFUND_SOURCE_REQUIRED';end if;
 if exists(select 1 from public.sales_team_cash_reservations_v1 reserved join public.sales_team_refund_requests_v1 other on other.id=reserved.request_id
  where other.sale_id=q.sale_id and not exists(select 1 from public.sales_team_cash_resolutions_v1 done where done.operation_id=reserved.operation_id)) then raise exception 'ORIGINAL_RETAINED_RESERVATION_REQUIRED';end if;
 bps:=(a.terms->'commission'->>'commissionBps')::integer;
 platform_total:=floor((r.subtotal_cents::numeric*1200+5000)/10000)::bigint;new_loss:=r.refunded_subtotal_cents+q.amount_cents;
 platform_return:=greatest(0,floor(((r.processing_cost_cents+platform_total)::numeric*new_loss+r.subtotal_cents/2)/r.subtotal_cents)::bigint-
  creatornet_team_private.financial_processing_share_v1(r.subtotal_cents,r.processing_cost_cents,new_loss)-coalesce(r.platform_fee_return_cents,0));
 -- Upper-bound all still-uncredited actual processing/adjustment costs. This
 -- deliberately does not predict a provider fee, a fee refund or refund order.
 fee_upper:=greatest(0,r.processing_cost_cents-r.platform_processing_credit_cents)+greatest(0,r.financial_adjustment_cost_cents-r.financial_processing_credit_cents);
 for item in select receipt.*,o.period_number,c.creator_proceeds_cents,c.creator_released_cents,c.creator_reversed_cents,c.creator_id balance_creator,c.sale_id balance_sale,
  b.earned_cents,b.released_cents,b.reversed_cents,b.creator_id commission_creator,b.sale_id commission_sale,b.membership_id commission_member
  from public.sales_team_receipts_v1 receipt join public.sales_team_payment_obligations_v1 o on o.id=receipt.obligation_id
  join public.sales_team_creator_balances_v1 c on c.receipt_id=receipt.id join public.sales_team_commission_balances_v1 b on b.receipt_id=receipt.id
  where receipt.sale_id=a.id order by o.period_number,receipt.id loop
  if item.balance_creator<>a.creator_id or item.commission_creator<>a.creator_id or item.balance_sale<>a.id or item.commission_sale<>a.id or item.commission_member<>a.membership_id then raise exception 'OWNED_RETAINED_SHARES_REQUIRED';end if;
  net:=item.subtotal_cents-greatest(item.refunded_subtotal_cents,item.confirmed_loss_subtotal_cents)-case when item.id=r.id then q.amount_cents else 0 end;
  eligible:=a.terms->>'paymentKind'<>'monthly' or a.terms->'commission'->>'renewals'='every_renewal' or item.period_number<=coalesce((a.terms->>'initialCommitmentMonths')::integer,1);
  if eligible then cum:=cum+net;commission:=floor((cum::numeric*bps+5000)/10000)::bigint-previous;previous:=previous+commission;else commission:=0;end if;
  creator:=greatest(0,item.creator_proceeds_cents::numeric+item.earned_cents-commission+case when item.id=r.id then -q.amount_cents+platform_return+fee_upper else 0 end);
  creator_unpaid:=greatest(0,item.creator_proceeds_cents-item.creator_released_cents+item.creator_reversed_cents);
  commission_unpaid:=greatest(0,item.earned_cents-item.released_cents+item.reversed_cents);
  old_total:=old_total+creator_unpaid+commission_unpaid;
  new_total:=new_total+greatest(0,creator-item.creator_released_cents+item.creator_reversed_cents)+greatest(0,commission-item.released_cents+item.reversed_cents);
  if item.id=r.id then
   original_creator_unpaid:=creator_unpaid;original_commission_unpaid:=commission_unpaid;
   target_creator_floor:=greatest(0,creator-item.creator_released_cents+item.creator_reversed_cents);
   target_commission_floor:=greatest(0,commission-item.released_cents+item.reversed_cents);
   creator_credit:=greatest(0,creator_unpaid-target_creator_floor);commission_credit:=greatest(0,commission_unpaid-target_commission_floor);
  end if;
 end loop;
 if original_creator_unpaid is null or (select count(*) from public.sales_team_receipts_v1 where sale_id=a.id)<>(select count(*) from public.sales_team_receipts_v1 receipt join public.sales_team_creator_balances_v1 c on c.receipt_id=receipt.id join public.sales_team_commission_balances_v1 b on b.receipt_id=receipt.id where receipt.sale_id=a.id) then raise exception 'COMPLETE_RETAINED_SHARES_REQUIRED';end if;
 -- Cumulative rounding can move a cent between later installments. Cap this
 -- receipt's offset by the complete sale's projected unpaid-liability reduction.
 budget:=least(q.amount_cents,greatest(0,old_total-new_total))::bigint;
 commission_credit:=least(commission_credit,budget);creator_credit:=least(creator_credit,budget-commission_credit);
 return jsonb_build_object('creatorCents',creator_credit,'commissionCents',commission_credit,'creatorFloorCents',original_creator_unpaid-creator_credit,'commissionFloorCents',original_commission_unpaid-commission_credit,
  'evidence',jsonb_build_object('receiptId',r.id,'creatorId',a.creator_id,'receiptRevision',r.observation_revision,'refundedBeforeCents',r.refunded_subtotal_cents,'amountCents',q.amount_cents,'platformReturnUpperCents',platform_return,'actualCostCreditUpperCents',fee_upper,'saleUnpaidBeforeCents',old_total,'saleUnpaidAfterUpperCents',new_total,'contractSha256',creatornet_team_private.retained_cash_contract_digest_v1()));
end $$;

create function creatornet_team_private.retained_cash_contract_digest_v1()
returns text language sql stable security invoker set search_path=pg_catalog as $$
 select encode(sha256(convert_to(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid),E'\n' order by p.oid::regprocedure::text collate "C"),'UTF8')),'hex') from pg_proc p
 where (p.pronamespace='creatornet_team_private'::regnamespace and p.proname in ('refund_retained_cash_plan_v1','refund_retained_cash_credit_v1','retained_cash_contract_digest_v1','cash_encumbered_v1','cash_protection_v1','financial_processing_share_v1')) or
 (p.pronamespace='public'::regnamespace and p.proname in ('reserve_sales_team_refund_cash_v1','sales_team_refund_operation_admitted_v1','sales_team_refund_admitted_before_retained_v1','recompute_sales_team_balances_v1','resolve_sales_team_refund_cash_v1'))
$$;
create function creatornet_team_private.refund_retained_cash_credit_v1(p_operation_id uuid)
returns bigint language sql stable security invoker set search_path=pg_catalog as $$
 select coalesce((select least(reserved.retained_creator_cents,greatest(0,c.creator_proceeds_cents-c.creator_released_cents+c.creator_reversed_cents-reserved.creator_unpaid_floor_cents))+
  least(reserved.retained_commission_cents,greatest(0,b.earned_cents-b.released_cents+b.reversed_cents-reserved.commission_unpaid_floor_cents))
  from public.sales_team_cash_reservations_v1 reserved join public.sales_team_refund_requests_v1 q on q.id=reserved.request_id and q.context=reserved.context
  join public.sales_team_sale_agreements_v1 a on a.id=q.sale_id and a.creator_id=q.creator_id and a.context=q.context
  join public.sales_team_creator_balances_v1 c on c.receipt_id=q.receipt_id and c.creator_id=q.creator_id and c.sale_id=q.sale_id
  join public.sales_team_commission_balances_v1 b on b.receipt_id=q.receipt_id and b.creator_id=q.creator_id and b.sale_id=q.sale_id and b.membership_id=a.membership_id where reserved.operation_id=p_operation_id and
   exists(select 1 from public.sales_team_cash_policy_v1 where singleton and retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1())),0)::bigint
$$;
create or replace function creatornet_team_private.cash_encumbered_v1()
returns numeric language sql stable security invoker set search_path=pg_catalog as $$
 select coalesce(sum(principal_cents::numeric+cost_reserve_cents-creatornet_team_private.refund_retained_cash_credit_v1(operation_id)),0) from public.sales_team_cash_reservations_v1 r
 where not exists(select 1 from public.sales_team_cash_resolutions_v1 resolved where resolved.operation_id=r.operation_id)
$$;

-- Preserve the installed admission/source/replay checks; alter only its cash
-- threshold and immutable reservation insert. Refuse unknown source definitions.
do $patch$ declare src text;change record;begin
 src:=replace(pg_get_functiondef('public.reserve_sales_team_refund_cash_v1(uuid,uuid,uuid,jsonb)'::regprocedure),chr(13)||chr(10),chr(10));
 for change in select * from (values
  ('scope jsonb;begin','scope jsonb;retained jsonb;begin'),
  ('if not coalesce(creatornet_team_private.cash_available_floor_v1','retained:=creatornet_team_private.refund_retained_cash_plan_v1(q.id);if not coalesce(creatornet_team_private.cash_available_floor_v1'),
  ('+q.amount_cents+(protection->>''refundCostReserveCents'')::numeric','+q.amount_cents-(retained->>''creatorCents'')::numeric-(retained->>''commissionCents'')::numeric+(protection->>''refundCostReserveCents'')::numeric'),
  ('read_id,principal_cents,cost_reserve_cents,context)','read_id,principal_cents,cost_reserve_cents,context,retained_creator_cents,retained_commission_cents,creator_unpaid_floor_cents,commission_unpaid_floor_cents,retained_evidence)'),
  ('(protection->>''refundCostReserveCents'')::bigint,p_context) returning','(protection->>''refundCostReserveCents'')::bigint,p_context,(retained->>''creatorCents'')::bigint,(retained->>''commissionCents'')::bigint,(retained->>''creatorFloorCents'')::bigint,(retained->>''commissionFloorCents'')::bigint,retained->''evidence'') returning')
 ) changes(needle,replacement) loop
  if (length(src)-length(replace(src,change.needle,'')))/length(change.needle)<>1 then raise exception 'RETAINED_REFUND_DEPENDENCY_DIFFERS: %',change.needle;end if;
  src:=replace(src,change.needle,change.replacement);
 end loop;execute src;
end $patch$;

alter function public.sales_team_refund_operation_admitted_v1(jsonb,jsonb) rename to sales_team_refund_admitted_before_retained_v1;
create function public.sales_team_refund_operation_admitted_v1(p_scope jsonb,p_context jsonb)
returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select not exists(select 1 from public.sales_team_cash_reservations_v1 reserved where reserved.request_id=(p_scope->>'scopeId')::uuid and reserved.retained_creator_cents+reserved.retained_commission_cents>0 and
  (not exists(select 1 from public.sales_team_controls_v1 where singleton and retained_refund_funding_enabled) or not exists(select 1 from public.sales_team_cash_policy_v1 where singleton and retained_contract_sha256=creatornet_team_private.retained_cash_contract_digest_v1()))) and
  public.sales_team_refund_admitted_before_retained_v1(p_scope,p_context)
$$;
revoke all on function creatornet_team_private.refund_retained_cash_plan_v1(uuid),creatornet_team_private.refund_retained_cash_credit_v1(uuid),creatornet_team_private.retained_cash_contract_digest_v1(),public.sales_team_refund_admitted_before_retained_v1(jsonb,jsonb),public.sales_team_refund_operation_admitted_v1(jsonb,jsonb) from public,anon,authenticated;
grant execute on function creatornet_team_private.refund_retained_cash_plan_v1(uuid),creatornet_team_private.refund_retained_cash_credit_v1(uuid),creatornet_team_private.retained_cash_contract_digest_v1(),public.sales_team_refund_admitted_before_retained_v1(jsonb,jsonb),public.sales_team_refund_operation_admitted_v1(jsonb,jsonb) to service_role;
commit;
