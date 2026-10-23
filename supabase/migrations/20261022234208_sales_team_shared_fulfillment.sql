-- Local candidate. Shared delivery/accounting for the separate-charge protocol.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
alter table public.sales_team_controls_v1 add column fulfillment_enabled boolean not null default false;
alter table public.sales_team_receipts_v1 add constraint sales_team_receipt_sale_pair_v1 unique(id,sale_id);
alter table public.purchases add column sales_team_sale_id uuid unique references public.sales_team_sale_agreements_v1(id) on delete restrict;
alter table public.orders add column sales_team_sale_id uuid references public.sales_team_sale_agreements_v1(id) on delete restrict,
 add column sales_team_receipt_id uuid unique,
 add constraint sales_team_order_receipt_pair_v1 foreign key(sales_team_receipt_id,sales_team_sale_id) references public.sales_team_receipts_v1(id,sale_id) on delete restrict;
alter table public.payment_fee_ledger
 add column sales_team_sale_id uuid references public.sales_team_sale_agreements_v1(id) on delete restrict,
 add column sales_team_receipt_id uuid unique,
 add column team_commission_cents bigint not null default 0 check(team_commission_cents>=0),
 add column team_processing_reserve_cents bigint not null default 0 check(team_processing_reserve_cents>=0),
 add column team_payout_reserve_cents bigint not null default 0 check(team_payout_reserve_cents>=0),
 add column team_tax_reserve_cents bigint not null default 0 check(team_tax_reserve_cents>=0),
 add column team_loss_subtotal_cents bigint not null default 0 check(team_loss_subtotal_cents>=0),
 add column team_processing_credit_cents bigint not null default 0 check(team_processing_credit_cents>=0),
 add column team_creator_deficit_cents bigint not null default 0 check(team_creator_deficit_cents>=0),
 add column team_financial_hold boolean not null default false,
 add constraint sales_team_ledger_receipt_pair_v1 foreign key(sales_team_receipt_id,sales_team_sale_id) references public.sales_team_receipts_v1(id,sale_id) on delete restrict,
 add constraint sales_team_ledger_exclusive_v1 check((sales_team_sale_id is null and sales_team_receipt_id is null and team_commission_cents=0 and team_processing_reserve_cents=0 and
  team_payout_reserve_cents=0 and team_tax_reserve_cents=0 and team_loss_subtotal_cents=0 and team_processing_credit_cents=0 and team_creator_deficit_cents=0 and not team_financial_hold) or
  (sales_team_sale_id is not null and sales_team_receipt_id is not null and purchase_id is not null and order_id is not null and stripe_checkout_session_id is null and stripe_invoice_id is null and booking_payment_id is null));

-- Preserve the exact installed legacy expressions inside their original branch.
-- An unknown installed definition is a compatibility stop, never a blanket drop.
do $guard$ declare split_def text;refund_def text;split_expr text;refund_expr text;begin
 select pg_get_constraintdef(oid) into split_def from pg_constraint where conrelid='public.payment_fee_ledger'::regclass and conname='payment_fee_ledger_split_check';
 select pg_get_constraintdef(oid) into refund_def from pg_constraint where conrelid='public.payment_fee_ledger'::regclass and conname='payment_fee_ledger_refund_check';
 if regexp_replace(coalesce(split_def,''),'[[:space:]]','','g')<>'CHECK((((platform_fee_cents+processing_fee_cents)=total_creator_deduction_cents)AND((total_creator_deduction_cents+creator_net_cents)=gross_amount_cents)))' or
  regexp_replace(coalesce(refund_def,''),'[[:space:]]','','g')<>$expected$CHECK(((refunded_amount_cents<=gross_amount_cents)AND(disputed_amount_cents<=gross_amount_cents)AND(earnings_reversed_cents<=creator_net_cents)AND(platform_fee_refund_attribution_cents<=platform_fee_cents)AND(processing_fee_refund_attribution_cents<=processing_fee_cents)AND((refund_allocation_rounding_cents>='-2'::integer)AND(refund_allocation_rounding_cents<=2))AND((((earnings_reversed_cents+platform_fee_refund_attribution_cents)+processing_fee_refund_attribution_cents)+refund_allocation_rounding_cents)=refunded_amount_cents)))$expected$ then raise exception 'TEAM_SHARED_LEDGER_DEPENDENCY_DIFFERS';end if;
 split_expr:=substring(split_def from 7);refund_expr:=substring(refund_def from 7);
 alter table public.payment_fee_ledger drop constraint payment_fee_ledger_split_check,drop constraint payment_fee_ledger_refund_check;
 execute 'alter table public.payment_fee_ledger add constraint payment_fee_ledger_split_check check((sales_team_receipt_id is null and '||split_expr||') or (sales_team_receipt_id is not null and
  platform_fee_cents+processing_fee_cents+team_commission_cents+team_processing_reserve_cents+team_payout_reserve_cents+team_tax_reserve_cents=total_creator_deduction_cents and
  total_creator_deduction_cents+creator_net_cents=gross_amount_cents-team_loss_subtotal_cents+team_processing_credit_cents+team_creator_deficit_cents))';
 execute 'alter table public.payment_fee_ledger add constraint payment_fee_ledger_refund_check check((sales_team_receipt_id is null and '||refund_expr||') or (sales_team_receipt_id is not null and
  refunded_amount_cents<=gross_amount_cents and disputed_amount_cents<=gross_amount_cents and team_loss_subtotal_cents between refunded_amount_cents and gross_amount_cents and
  earnings_reversed_cents=0 and platform_fee_refund_attribution_cents=0 and processing_fee_refund_attribution_cents=0 and refund_allocation_rounding_cents=0))';
end $guard$;
comment on column public.payment_fee_ledger.team_processing_reserve_cents is 'Estimate held separately until actual attributable provider costs are verified. Not a processing charge or markup.';

create table public.sales_team_purchase_bindings_v1 (
 sale_id uuid primary key references public.sales_team_sale_agreements_v1(id) on delete restrict,
 purchase_id uuid not null unique default gen_random_uuid(),
 order_id uuid not null unique default gen_random_uuid(),
 buyer_id uuid not null references auth.users(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 revision_id uuid not null references public.product_delivery_revisions(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_shared_receipts_v1 (
 receipt_id uuid primary key references public.sales_team_receipts_v1(id) on delete restrict,
 sale_id uuid not null references public.sales_team_sale_agreements_v1(id) on delete restrict,
 purchase_id uuid not null references public.purchases(id) on delete restrict deferrable initially deferred,
 order_id uuid not null unique references public.orders(id) on delete restrict deferrable initially deferred,
 ledger_id uuid not null unique references public.payment_fee_ledger(id) on delete restrict deferrable initially deferred,
 booked_net_cents bigint not null default 0 check(booked_net_cents>=0),
 created_at timestamptz not null default clock_timestamp()
);
create table public.sales_team_purchase_statistics_v1 (
 sale_id uuid primary key references public.sales_team_sale_agreements_v1(id) on delete restrict,
 counted boolean not null default false
);

create function creatornet_team_private.freeze_team_delivery_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare p public.products;revision uuid;links jsonb:='[]';link text;label text;asset record;b public.sales_team_purchase_bindings_v1;videos integer:=0;
begin
 select * into p from public.products where id=(new.terms->>'productId')::uuid and creator_id=new.creator_id for share;
 if p.id is null then raise exception 'TEAM_DELIVERY_OWNER_REQUIRED';end if;
 if (select source_snapshot->'product'->>'delivery_revision' from public.sales_team_sale_requests_v1 where id=new.id) is distinct from p.delivery_revision::text then raise exception 'TEAM_DELIVERY_CHANGED';end if;
 revision:=p.delivery_revision;
 if revision is null then
  for label,link in select * from (values
   ('Content',to_jsonb(p)->>'deliver_url'),('Discord',coalesce(to_jsonb(p)->>'discord_invite_url',case when to_jsonb(p)->>'fulfillment'='DISCORD' then to_jsonb(p)->>'discord_channel_id' end)),
   ('Whop',coalesce(to_jsonb(p)->>'whop_listing_url',case when to_jsonb(p)->>'fulfillment'='WHOP' then to_jsonb(p)->>'whop_listing_id' end)),('Access',to_jsonb(p)->>'external_url')) q(label,url) loop
   if nullif(link,'') is not null then
    if length(link)>2048 or link!~'^https://[^/@[:space:]]+([/?#]|$)' then raise exception 'TEAM_DELIVERY_LINK_REQUIRES_REVIEW';end if;
    links:=links||jsonb_build_array(jsonb_build_object('label',label,'url',link));
   end if;
  end loop;
  insert into public.product_delivery_revisions(product_id,creator_id,links) values(p.id,new.creator_id,links) returning id into revision;
  for asset in select * from public.private_video_assets where legacy_post_id=(new.terms->>'postId')::uuid and creator_id=new.creator_id and status='ready' and provider_id is not null order by id for share loop
   insert into public.product_delivery_videos(revision_id,asset_id,creator_id,label,position) values(revision,asset.id,new.creator_id,coalesce(nullif(asset.name,''),'Purchased content'),videos);videos:=videos+1;
  end loop;
  if p.type in ('video','course','bundle') and videos=0 and jsonb_array_length(links)=0 then raise exception 'TEAM_DELIVERY_REQUIRED';end if;
 end if;
 if not exists(select 1 from public.product_delivery_revisions where id=revision and product_id=p.id and creator_id=new.creator_id) or
  exists(select 1 from public.product_delivery_videos v join public.private_video_assets a on a.id=v.asset_id where v.revision_id=revision and (a.creator_id<>new.creator_id or a.status<>'ready' or a.provider_id is null)) then raise exception 'TEAM_DELIVERY_REQUIRED';end if;
 insert into public.sales_team_purchase_bindings_v1(sale_id,buyer_id,creator_id,product_id,revision_id) values(new.id,new.buyer_id,new.creator_id,p.id,revision) returning * into b;
 insert into public.checkout_delivery_snapshots(order_id,buyer_id,creator_id,product_id,revision_id,title,product_type,amount_cents,currency,links)
 select b.order_id,new.buyer_id,new.creator_id,p.id,revision,new.terms->>'title',p.type,(new.terms->>'amountCents')::bigint,'usd',r.links from public.product_delivery_revisions r where id=revision;
 return new;
end $$;
create trigger sales_team_delivery_acceptance_v1 after insert on public.sales_team_sale_agreements_v1 for each row execute function creatornet_team_private.freeze_team_delivery_v1();
revoke all on function creatornet_team_private.freeze_team_delivery_v1() from public,anon,authenticated,service_role;

create function creatornet_team_private.guard_team_shared_rows_v1()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;b public.sales_team_purchase_bindings_v1;v jsonb:=to_jsonb(new);old_v jsonb;r public.sales_team_receipts_v1;
begin
 if tg_op='UPDATE' then old_v:=to_jsonb(old);end if;
 if v->>'sales_team_sale_id' is null and old_v->>'sales_team_sale_id' is null then return new;end if;
 if current_user not in ('service_role','postgres') then raise exception 'TEAM_SHARED_SERVICE_REQUIRED' using errcode='42501';end if;
 if tg_op='UPDATE' and (v->>'sales_team_sale_id' is distinct from old_v->>'sales_team_sale_id' or v->>'sales_team_receipt_id' is distinct from old_v->>'sales_team_receipt_id') then raise exception 'ORIGINAL_TEAM_ACCOUNTING_CHANGED';end if;
 select * into a from public.sales_team_sale_agreements_v1 where id=(v->>'sales_team_sale_id')::uuid;
 select * into b from public.sales_team_purchase_bindings_v1 where sale_id=a.id;
 if a.id is null or b.sale_id is null or v->>'creator_id' is distinct from a.creator_id::text then raise exception 'TEAM_SHARED_BINDING_REQUIRED';end if;
 if tg_table_name='purchases' then
  if v->>'id' is distinct from b.purchase_id::text or v->>'buyer_id' is distinct from a.buyer_id::text or v->>'buyer_user_id' is distinct from a.buyer_id::text or
   v->>'product_id' is distinct from b.product_id::text or v->>'post_id' is distinct from a.terms->>'postId' or v->>'order_id' is distinct from b.order_id::text or
   v->>'payment_intent_id' is distinct from (select receipt.payment_intent_id from public.sales_team_receipts_v1 receipt join public.sales_team_payment_obligations_v1 obligation on obligation.id=receipt.obligation_id where receipt.sale_id=a.id and obligation.period_number=1) or
   v->'access_granted' is distinct from 'false'::jsonb or v->>'amount_cents' is distinct from a.terms->>'amountCents' then raise exception 'ORIGINAL_TEAM_PURCHASE_CHANGED';end if;
 else
  select * into r from public.sales_team_receipts_v1 where id=(v->>'sales_team_receipt_id')::uuid and sale_id=a.id;
  if r.id is null then raise exception 'TEAM_SHARED_RECEIPT_REQUIRED';end if;
  if tg_table_name='payment_fee_ledger' and (v->>'purchase_id' is distinct from b.purchase_id::text or v->>'stripe_payment_intent_id' is distinct from r.payment_intent_id or v->>'stripe_charge_id' is distinct from r.charge_id) then raise exception 'ORIGINAL_TEAM_LEDGER_CHANGED';end if;
 end if;
 return new;
end $$;
create trigger sales_team_purchase_guard_v1 before insert or update on public.purchases for each row execute function creatornet_team_private.guard_team_shared_rows_v1();
create trigger sales_team_order_guard_v1 before insert or update on public.orders for each row execute function creatornet_team_private.guard_team_shared_rows_v1();
create trigger sales_team_fee_ledger_guard_v1 before insert or update on public.payment_fee_ledger for each row execute function creatornet_team_private.guard_team_shared_rows_v1();
revoke all on function creatornet_team_private.guard_team_shared_rows_v1() from public,anon,authenticated,service_role;

create function creatornet_team_private.reject_team_shared_delete_v1() returns trigger language plpgsql security invoker set search_path=pg_catalog as $$begin
 if to_jsonb(old)->>'sales_team_sale_id' is not null then raise exception 'TEAM_SHARED_HISTORY_IMMUTABLE';end if;return old;end $$;
create trigger sales_team_purchase_delete_guard_v1 before delete on public.purchases for each row execute function creatornet_team_private.reject_team_shared_delete_v1();
create trigger sales_team_order_delete_guard_v1 before delete on public.orders for each row execute function creatornet_team_private.reject_team_shared_delete_v1();
create trigger sales_team_ledger_delete_guard_v1 before delete on public.payment_fee_ledger for each row execute function creatornet_team_private.reject_team_shared_delete_v1();
revoke all on function creatornet_team_private.reject_team_shared_delete_v1() from public,anon,authenticated,service_role;

-- The old helpers remain byte-preserved behind scoped guards. Team accounting
-- books its own post-commission delta and cannot also use legacy earnings.
alter function public.credit_purchase_earnings(uuid,integer) rename to credit_purchase_earnings_before_team_v1;
create function public.credit_purchase_earnings(p_purchase_id uuid,p_creator_amount_cents integer) returns boolean language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from public.purchases where id=p_purchase_id and sales_team_sale_id is not null) then raise exception 'TEAM_EARNINGS_REQUIRE_OWN_ACCOUNTING';end if;
 return public.credit_purchase_earnings_before_team_v1(p_purchase_id,p_creator_amount_cents);end $$;
alter function public.reverse_purchase_earnings(uuid) rename to reverse_purchase_earnings_before_team_v1;
create function public.reverse_purchase_earnings(p_purchase_id uuid) returns boolean language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from public.purchases where id=p_purchase_id and sales_team_sale_id is not null) then raise exception 'TEAM_FINANCIAL_RECONCILIATION_REQUIRED';end if;
 return public.reverse_purchase_earnings_before_team_v1(p_purchase_id);end $$;
alter function public.credit_payment_fee_ledger_earnings(uuid) rename to credit_payment_fee_ledger_earnings_before_team_v1;
create function public.credit_payment_fee_ledger_earnings(p_ledger_id uuid) returns boolean language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from public.payment_fee_ledger where id=p_ledger_id and sales_team_sale_id is not null) then raise exception 'TEAM_EARNINGS_REQUIRE_OWN_ACCOUNTING';end if;
 return public.credit_payment_fee_ledger_earnings_before_team_v1(p_ledger_id);end $$;
alter function public.apply_purchase_refund_earnings(uuid,bigint) rename to apply_purchase_refund_earnings_before_team_v1;
create function public.apply_purchase_refund_earnings(p_purchase_id uuid,p_refunded_gross_cents bigint) returns bigint language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from public.purchases where id=p_purchase_id and sales_team_sale_id is not null) then raise exception 'TEAM_FINANCIAL_RECONCILIATION_REQUIRED';end if;
 return public.apply_purchase_refund_earnings_before_team_v1(p_purchase_id,p_refunded_gross_cents);end $$;
alter function public.apply_payment_fee_ledger_refund(uuid,bigint) rename to apply_payment_fee_ledger_refund_before_team_v1;
create function public.apply_payment_fee_ledger_refund(p_ledger_id uuid,p_refunded_gross_cents bigint) returns bigint language plpgsql security definer set search_path=pg_catalog as $$begin
 if exists(select 1 from public.payment_fee_ledger where id=p_ledger_id and sales_team_sale_id is not null) then raise exception 'TEAM_FINANCIAL_RECONCILIATION_REQUIRED';end if;
 return public.apply_payment_fee_ledger_refund_before_team_v1(p_ledger_id,p_refunded_gross_cents);end $$;

create function public.sync_sales_team_shared_accounting_v1(p_sale_id uuid)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;b public.sales_team_purchase_bindings_v1;s record;delta bigint;total_net bigint:=0;loss bigint;deduction bigint;v_counted boolean;want_count boolean;purchase_status text;runtime public.sales_team_payment_runtime_v1;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id;
 if a.id is null then raise exception 'SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into b from public.sales_team_purchase_bindings_v1 where sale_id=a.id;
 if b.sale_id is null or not exists(select 1 from public.purchases where id=b.purchase_id) then return;end if;
 for s in select m.*,r.subtotal_cents,r.tax_cents,r.processing_cost_cents,r.balance_transaction_id,r.refunded_subtotal_cents,r.confirmed_loss_subtotal_cents,r.review_hold,r.dispute_hold,r.payment_intent_id,r.charge_id,
  c.platform_revenue_cents,c.creator_proceeds_cents,c.processing_reserve_cents,c.payout_cost_reserve_cents,c.actual_processing_cost_cents,c.platform_processing_credit_cents,c.creator_deficit_cents,c.tax_reserve_cents,comm.earned_cents
  from public.sales_team_shared_receipts_v1 m join public.sales_team_receipts_v1 r on r.id=m.receipt_id join public.sales_team_creator_balances_v1 c on c.receipt_id=r.id join public.sales_team_commission_balances_v1 comm on comm.receipt_id=r.id
  where m.sale_id=a.id order by m.receipt_id for update of m loop
  loss:=greatest(s.refunded_subtotal_cents,s.confirmed_loss_subtotal_cents);deduction:=s.platform_revenue_cents+s.actual_processing_cost_cents+s.earned_cents+s.processing_reserve_cents+s.payout_cost_reserve_cents+s.tax_reserve_cents;
  update public.payment_fee_ledger set platform_fee_cents=s.platform_revenue_cents,processing_fee_cents=s.actual_processing_cost_cents,total_creator_deduction_cents=deduction,creator_net_cents=s.creator_proceeds_cents,
   actual_stripe_fee_cents=s.processing_cost_cents,processing_fee_variance_cents=case when s.processing_cost_cents is null then null else 0 end,stripe_balance_transaction_id=s.balance_transaction_id,
   refunded_amount_cents=s.refunded_subtotal_cents,team_commission_cents=s.earned_cents,team_processing_reserve_cents=s.processing_reserve_cents,team_payout_reserve_cents=s.payout_cost_reserve_cents,
   team_tax_reserve_cents=s.tax_reserve_cents,team_loss_subtotal_cents=loss,team_processing_credit_cents=s.platform_processing_credit_cents,team_creator_deficit_cents=s.creator_deficit_cents,
   team_financial_hold=s.review_hold or s.dispute_hold,status=case when s.refunded_subtotal_cents=s.subtotal_cents then 'refunded' else 'paid' end,updated_at=clock_timestamp()
   where id=s.ledger_id and sales_team_receipt_id=s.receipt_id;
  if not found then raise exception 'ORIGINAL_TEAM_LEDGER_MISSING';end if;
  update public.orders set platform_fee=s.platform_revenue_cents,processing_fee=s.actual_processing_cost_cents,total_creator_deduction=deduction,creator_amount=s.creator_proceeds_cents,
   stripe_balance_transaction_id=s.balance_transaction_id,actual_stripe_fee=s.processing_cost_cents,processing_fee_variance=case when s.processing_cost_cents is null then null else 0 end,
   status=case when s.refunded_subtotal_cents=s.subtotal_cents then 'refunded' else 'paid' end,updated_at=clock_timestamp() where id=s.order_id and sales_team_receipt_id=s.receipt_id;
  delta:=s.creator_proceeds_cents-s.booked_net_cents;
  if delta<>0 then update public.profiles set total_earnings_cents=greatest(0,coalesce(total_earnings_cents,0)+delta) where id=a.creator_id;if not found then raise exception 'TEAM_CREATOR_PROFILE_REQUIRED';end if;end if;
  update public.sales_team_shared_receipts_v1 set booked_net_cents=s.creator_proceeds_cents where receipt_id=s.receipt_id;total_net:=total_net+s.creator_proceeds_cents;
 end loop;
 select * into runtime from public.sales_team_payment_runtime_v1 where sale_id=a.id;
 want_count:=exists(select 1 from public.sales_team_receipts_v1 where sale_id=a.id and subtotal_cents>greatest(refunded_subtotal_cents,confirmed_loss_subtotal_cents));
 select coalesce(sum(refunded_subtotal_cents),0)>=coalesce(sum(subtotal_cents),0) into v_counted from public.sales_team_receipts_v1 where sale_id=a.id;
 purchase_status:=case when v_counted then 'refunded' when a.terms->>'paymentKind'='monthly' or a.terms->>'paymentKind'='installments' and runtime.covered_periods<(a.terms->>'paymentCount')::integer then 'active' else 'paid' end;
 update public.purchases set status=purchase_status,access_granted=false,earnings_credited_cents=total_net,paid_count=runtime.covered_periods where id=b.purchase_id;
 insert into public.sales_team_purchase_statistics_v1(sale_id) values(a.id) on conflict do nothing;
 select stats.counted into v_counted from public.sales_team_purchase_statistics_v1 stats where sale_id=a.id for update;
 if v_counted is distinct from want_count then
  update public.posts set purchase_count=greatest(0,coalesce(purchase_count,0)+case when want_count then 1 else -1 end) where id=(a.terms->>'postId')::uuid;
  update public.sales_team_purchase_statistics_v1 set counted=want_count where sale_id=a.id;
 end if;
end $$;

create function public.fulfill_sales_team_receipt_v1(p_sale_id uuid,p_buyer_id uuid,p_receipt_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare a public.sales_team_sale_agreements_v1;b public.sales_team_purchase_bindings_v1;r public.sales_team_receipts_v1;o public.sales_team_payment_obligations_v1;m public.sales_team_shared_receipts_v1;
 c public.sales_team_creator_balances_v1;comm public.sales_team_commission_balances_v1;order_id uuid;ledger_id uuid:=gen_random_uuid();deduction bigint;loss bigint;product_type text;
begin
 select * into a from public.sales_team_sale_agreements_v1 where id=p_sale_id and buyer_id=p_buyer_id;
 if a.id is null then raise exception 'OWNED_SALE_REQUIRED';end if;
 perform pg_advisory_xact_lock(hashtextextended(a.buyer_id::text||':'||public.sales_team_canonical_product_v1((a.terms->>'productId')::uuid)::text,72913));
 perform pg_advisory_xact_lock(hashtextextended('sales-team-financial:'||a.creator_id::text,0));
 select * into b from public.sales_team_purchase_bindings_v1 where sale_id=a.id;
 select * into r from public.sales_team_receipts_v1 where id=p_receipt_id and sale_id=a.id;
 select * into o from public.sales_team_payment_obligations_v1 where id=r.obligation_id;
 if b.sale_id is null or r.id is null or not exists(select 1 from public.sales_team_capture_provenance_v1 where receipt_id=r.id and obligation_id=o.id) then raise exception 'VERIFIED_TEAM_FULFILLMENT_REQUIRED';end if;
 select * into m from public.sales_team_shared_receipts_v1 where receipt_id=r.id;
 if m.receipt_id is not null then perform public.sync_sales_team_shared_accounting_v1(a.id);return jsonb_build_object('purchaseId',m.purchase_id,'receiptId',r.id,'recorded',false);end if;
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and fulfillment_enabled) then raise exception 'TEAM_FULFILLMENT_HELD';end if;
 if o.period_number<>1 and not exists(select 1 from public.purchases where id=b.purchase_id and sales_team_sale_id=a.id) then raise exception 'TEAM_FIRST_FULFILLMENT_REQUIRED';end if;
 if exists(select 1 from public.purchases p where p.id<>b.purchase_id and p.buyer_id=a.buyer_id and (p.product_id=b.product_id or p.post_id=(a.terms->>'postId')::uuid)) or
  exists(select 1 from public.payment_fee_ledger where stripe_payment_intent_id=r.payment_intent_id or stripe_charge_id=r.charge_id) then raise exception 'TEAM_CANNOT_ADOPT_EXISTING_ACCOUNTING';end if;
 select * into c from public.sales_team_creator_balances_v1 where receipt_id=r.id;select * into comm from public.sales_team_commission_balances_v1 where receipt_id=r.id;
 if c.receipt_id is null or comm.receipt_id is null then raise exception 'TEAM_ACCOUNTING_REQUIRED';end if;
 select s.product_type into product_type from public.checkout_delivery_snapshots s where s.order_id=b.order_id and s.buyer_id=a.buyer_id and s.product_id=b.product_id and s.revision_id=b.revision_id and s.amount_cents=(a.terms->>'amountCents')::bigint;
 if product_type is null then raise exception 'ORIGINAL_TEAM_DELIVERY_REQUIRED';end if;
 order_id:=case when o.period_number=1 then b.order_id else gen_random_uuid() end;loss:=greatest(r.refunded_subtotal_cents,r.confirmed_loss_subtotal_cents);
 deduction:=c.platform_revenue_cents+c.actual_processing_cost_cents+comm.earned_cents+c.processing_reserve_cents+c.payout_cost_reserve_cents+c.tax_reserve_cents;
 insert into public.orders(id,buyer_id,creator_id,post_id,amount_cents,gross_amount,platform_fee,processing_fee,total_creator_deduction,creator_amount,fee_schedule_version,status,currency,
  stripe_payment_intent_id,stripe_payment_id,stripe_charge_id,stripe_balance_transaction_id,actual_stripe_fee,processing_fee_variance,sales_team_sale_id,sales_team_receipt_id)
 values(order_id,a.buyer_id,a.creator_id,(a.terms->>'postId')::uuid,r.subtotal_cents,r.subtotal_cents,c.platform_revenue_cents,c.actual_processing_cost_cents,deduction,c.creator_proceeds_cents,
  a.terms->'distribution'->>'feeDisclosureVersion','paid','usd',r.payment_intent_id,r.payment_intent_id,r.charge_id,r.balance_transaction_id,r.processing_cost_cents,case when r.processing_cost_cents is null then null else 0 end,a.id,r.id);
 if o.period_number=1 then
  insert into public.purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,order_id,booking_id,amount_cents,currency,status,kind,product_type,title,access_granted,payment_intent_id,paid_at,earnings_credited_at,earnings_credited_cents,paid_count,sales_team_sale_id)
  values(b.purchase_id,a.buyer_id,a.buyer_id,a.creator_id,b.product_id,(a.terms->>'postId')::uuid,b.order_id,a.booking_id,(a.terms->>'amountCents')::bigint,'usd','paid','creatornet_team_v1',product_type,a.terms->>'title',false,r.payment_intent_id,r.paid_at,clock_timestamp(),0,1,a.id);
  update public.bookings set linked_order_id=b.order_id where id=a.booking_id and buyer_id=a.buyer_id and creator_id=a.creator_id and (linked_order_id is null or linked_order_id=b.order_id);
  if not found then raise exception 'ORIGINAL_TEAM_BOOKING_CHANGED';end if;
 end if;
 insert into public.payment_fee_ledger(id,creator_id,purchase_id,order_id,stripe_payment_intent_id,stripe_charge_id,stripe_balance_transaction_id,gross_amount_cents,platform_fee_cents,processing_fee_cents,
  total_creator_deduction_cents,creator_net_cents,actual_stripe_fee_cents,processing_fee_variance_cents,currency,fee_schedule_version,status,earnings_credited_at,refunded_amount_cents,
  sales_team_sale_id,sales_team_receipt_id,team_commission_cents,team_processing_reserve_cents,team_payout_reserve_cents,team_tax_reserve_cents,team_loss_subtotal_cents,team_processing_credit_cents,team_creator_deficit_cents,team_financial_hold)
 values(ledger_id,a.creator_id,b.purchase_id,order_id,r.payment_intent_id,r.charge_id,r.balance_transaction_id,r.subtotal_cents,c.platform_revenue_cents,c.actual_processing_cost_cents,deduction,c.creator_proceeds_cents,
  r.processing_cost_cents,case when r.processing_cost_cents is null then null else 0 end,'usd',a.terms->'distribution'->>'feeDisclosureVersion','paid',clock_timestamp(),r.refunded_subtotal_cents,
  a.id,r.id,comm.earned_cents,c.processing_reserve_cents,c.payout_cost_reserve_cents,c.tax_reserve_cents,loss,c.platform_processing_credit_cents,c.creator_deficit_cents,r.review_hold or r.dispute_hold);
 insert into public.sales_team_shared_receipts_v1(receipt_id,sale_id,purchase_id,order_id,ledger_id) values(r.id,a.id,b.purchase_id,order_id,ledger_id);
 perform public.sync_sales_team_shared_accounting_v1(a.id);
 return jsonb_build_object('purchaseId',b.purchase_id,'receiptId',r.id,'recorded',true);
end $$;

alter function public.recompute_sales_team_balances_v1(uuid,text,jsonb) rename to recompute_sales_team_balances_before_shared_v1;
create function public.recompute_sales_team_balances_v1(p_sale_id uuid,p_source_identity text,p_evidence jsonb) returns void language plpgsql security invoker set search_path=pg_catalog as $$begin
 perform public.recompute_sales_team_balances_before_shared_v1(p_sale_id,p_source_identity,p_evidence);perform public.sync_sales_team_shared_accounting_v1(p_sale_id);end $$;

create function public.read_sales_team_entitlement_v1(p_purchase_id uuid,p_buyer_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare p public.purchases;a public.sales_team_sale_agreements_v1;r public.sales_team_payment_runtime_v1;first_paid timestamptz;end_at timestamptz;seconds integer:=3600;at_time timestamptz:=clock_timestamp();
begin
 select * into p from public.purchases where id=p_purchase_id and buyer_id=p_buyer_id;
 if p.id is null then return jsonb_build_object('applicable',false,'allowed',false,'maxAgeSeconds',0);end if;
 if p.sales_team_sale_id is null then return jsonb_build_object('applicable',false,'allowed',coalesce(p.access_granted and p.status in ('paid','active','complete'),false),
  'maxAgeSeconds',case when p.access_granted and p.status in ('paid','active','complete') then 3600 else 0 end);end if;
 select * into a from public.sales_team_sale_agreements_v1 where id=p.sales_team_sale_id and buyer_id=p_buyer_id;
 select * into r from public.sales_team_payment_runtime_v1 where sale_id=a.id;
 if a.id is null or r.sale_id is null or r.financial_hold or r.covered_periods<1 or p.status not in ('paid','active','complete') or
  not exists(select 1 from public.sales_team_purchase_bindings_v1 b join public.purchase_deliveries d on d.purchase_id=b.purchase_id and d.order_id=b.order_id where b.sale_id=a.id and b.purchase_id=p.id) or
  not exists(select 1 from public.sales_team_receipts_v1 where sale_id=a.id and subtotal_cents>greatest(refunded_subtotal_cents,confirmed_loss_subtotal_cents)) or
  exists(select 1 from public.sales_team_receipts_v1 where sale_id=a.id and (review_hold or dispute_hold or confirmed_loss_subtotal_cents>refunded_subtotal_cents)) then return jsonb_build_object('applicable',true,'allowed',false,'maxAgeSeconds',0);end if;
 first_paid:=r.anchor_at;
 if a.terms->>'paymentKind'='monthly' or a.terms->>'paymentKind'='installments' and r.covered_periods<(a.terms->>'paymentCount')::integer then
  end_at:=((first_paid at time zone 'UTC')+make_interval(months=>r.covered_periods)) at time zone 'UTC';
 end if;
 if a.terms->>'serviceMonths' is not null then end_at:=least(end_at,((first_paid at time zone 'UTC')+make_interval(months=>(a.terms->>'serviceMonths')::integer)) at time zone 'UTC');end if;
 if first_paid is null or first_paid>at_time or end_at is not null and end_at<=at_time then seconds:=0;
 elsif end_at is not null then seconds:=least(3600,floor(extract(epoch from end_at-at_time))::integer);end if;
 return jsonb_build_object('applicable',true,'allowed',seconds>0,'maxAgeSeconds',greatest(0,seconds));
end $$;

alter function public.sales_team_payment_admitted_v1(uuid,jsonb) rename to sales_team_payment_admitted_before_fulfillment_v1;
create function public.sales_team_payment_admitted_v1(p_sale_id uuid,p_context jsonb) returns boolean language sql stable security invoker set search_path=pg_catalog as $$
 select public.sales_team_payment_admitted_before_fulfillment_v1(p_sale_id,p_context) and exists(select 1 from public.sales_team_controls_v1 where singleton and receipt_recording_enabled and fulfillment_enabled)
$$;
alter function public.read_sales_team_payment_v1(uuid,uuid) rename to read_sales_team_payment_before_fulfillment_v1;
create function public.read_sales_team_payment_v1(p_sale_id uuid,p_buyer_id uuid) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;r public.sales_team_receipts_v1;begin
 result:=public.read_sales_team_payment_before_fulfillment_v1(p_sale_id,p_buyer_id);
 if result->'receipt'<>'null'::jsonb then
  select * into r from public.sales_team_receipts_v1 where id=(result->'receipt'->>'id')::uuid;
  result:=jsonb_set(result,'{receipt}',result->'receipt'||jsonb_build_object('fulfilled',exists(select 1 from public.sales_team_shared_receipts_v1 where receipt_id=r.id),'held',r.review_hold or r.dispute_hold));
 end if;return result;
end $$;

do $$ declare n text;sig regprocedure;begin
 foreach n in array array['sales_team_purchase_bindings_v1','sales_team_shared_receipts_v1','sales_team_purchase_statistics_v1'] loop
  execute format('alter table public.%I enable row level security',n);execute format('revoke all on public.%I from public,anon,authenticated',n);execute format('grant select,insert on public.%I to service_role',n);
 end loop;
 grant update(booked_net_cents) on public.sales_team_shared_receipts_v1 to service_role;grant update(counted) on public.sales_team_purchase_statistics_v1 to service_role;
 create trigger sales_team_binding_immutable_v1 before update or delete on public.sales_team_purchase_bindings_v1 for each row execute function creatornet_team_private.reject_history_change();
 for sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('credit_purchase_earnings','reverse_purchase_earnings','credit_payment_fee_ledger_earnings','apply_purchase_refund_earnings','apply_payment_fee_ledger_refund',
  'credit_purchase_earnings_before_team_v1','reverse_purchase_earnings_before_team_v1','credit_payment_fee_ledger_earnings_before_team_v1','apply_purchase_refund_earnings_before_team_v1','apply_payment_fee_ledger_refund_before_team_v1',
  'sync_sales_team_shared_accounting_v1','fulfill_sales_team_receipt_v1','recompute_sales_team_balances_v1','recompute_sales_team_balances_before_shared_v1','read_sales_team_entitlement_v1',
  'sales_team_payment_admitted_v1','sales_team_payment_admitted_before_fulfillment_v1','read_sales_team_payment_v1','read_sales_team_payment_before_fulfillment_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',sig);execute format('grant execute on function %s to service_role',sig);
 end loop;
end $$;
commit;
