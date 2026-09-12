-- UNAPPLIED. Locked steps 1/4/5/8. Close an unpaid original monthly attempt without erasing history.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$ begin
  if current_user<>'postgres' or to_regprocedure('public.publish_monthly_mentorship_recovery_v1(uuid,uuid,jsonb)') is null or
    to_regclass('public.monthly_mentorship_initial_closures_v1') is not null then raise exception 'Initial close-out prerequisites differ'; end if;
end; $preflight$;
alter table public.monthly_mentorship_agreements_v1
  add column initial_abandon_requested_at timestamptz,
  add column initial_abandoned_at timestamptz,
  add column initial_abandon_snapshot jsonb,
  add column initial_abandon_proof jsonb,
  add constraint monthly_initial_abandoned_unpaid_v1 check(initial_abandoned_at is null or
    (covered_months=0 and anchor_at is null and initial_abandon_requested_at is not null and initial_abandon_snapshot is not null and initial_abandon_proof is not null));
alter table public.monthly_mentorship_agreements_v1 drop constraint monthly_mentorship_agreements_v1_buyer_id_product_id_key;
create unique index monthly_one_unclosed_offer_v1 on public.monthly_mentorship_agreements_v1(buyer_id,product_id) where initial_abandoned_at is null;
create table public.monthly_mentorship_initial_closures_v1 (
  id uuid primary key default gen_random_uuid(), agreement_id uuid not null references public.monthly_mentorship_agreements_v1(id),
  kind text not null check(kind in ('expire_checkout','cancel_subscription','hold_invoice','void_invoice')),
  resource_id text not null, request jsonb not null, admission_proof jsonb not null,
  admitted_at timestamptz not null default clock_timestamp(), provider_started_at timestamptz,
  status text not null default 'pending' check(status in ('pending','complete')),
  provider_proof jsonb, completed_at timestamptz,
  unique(agreement_id,kind,resource_id),
  check((status='complete' and provider_proof is not null and completed_at is not null) or
    (status='pending' and provider_proof is null and completed_at is null))
);
create unique index monthly_initial_one_root_closure_v1 on public.monthly_mentorship_initial_closures_v1(agreement_id,kind)
  where kind in ('expire_checkout','cancel_subscription');
alter table public.monthly_mentorship_initial_closures_v1 enable row level security;
revoke all on public.monthly_mentorship_initial_closures_v1 from public,anon,authenticated,service_role;
grant select on public.monthly_mentorship_initial_closures_v1 to service_role;

create function public.assert_monthly_initial_unpaid_v1(p_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; p public.purchases%rowtype;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  select * into p from public.purchases where id=a.purchase_id for update;
  if not found or a.covered_months<>0 or a.anchor_at is not null or a.financial_hold_at is not null or
    p.monthly_mentorship_id is distinct from a.id or p.kind<>'monthly_mentorship_v1' or p.access_granted is distinct from false or
    p.first_access_at is not null or p.paid_at is not null or p.earnings_credited_at is not null or coalesce(p.paid_count,0)<>0 or
    p.status not in ('pending','canceled') or exists(select 1 from public.payment_fee_ledger where purchase_id=a.purchase_id) or
    exists(select 1 from public.monthly_mentorship_receipts_v1 where agreement_id=a.id) or
    exists(select 1 from public.monthly_mentorship_payoffs_v1 where agreement_id=a.id) or
    exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind in ('activate','collect')) then
    raise exception 'Initial checkout is not proven unstarted and unpaid'; end if;
end;
$$;
create function public.request_monthly_initial_abandonment_v1(p_id uuid,p_buyer_id uuid,p_context jsonb,p_confirmed boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context or p_confirmed is distinct from true then
    raise exception 'Explicit owned initial close-out intent required'; end if;
  perform public.assert_monthly_initial_unpaid_v1(a.id);
  if a.initial_abandon_requested_at is null then
    update public.monthly_mentorship_agreements_v1 set initial_abandon_requested_at=clock_timestamp(),
      initial_abandon_snapshot=jsonb_build_object('version','monthly-initial-close-consent-v1','agreementId',a.id,'fingerprint',a.fingerprint,'terms',a.terms),
      renewal_stopped_at=coalesce(renewal_stopped_at,clock_timestamp()),billing_next_attempt_at='infinity',revision=revision+1 where id=a.id returning * into a;
  end if;
  return jsonb_build_object('membershipId',a.id,'requested',true,'abandoned',a.initial_abandoned_at is not null);
end;
$$;

create function public.monthly_initial_resource_matches_v1(p_id uuid,p_kind text,p_proof jsonb) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_customer text; v_subscription text; o public.monthly_mentorship_operations_v1%rowtype;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id;
  if not found or p_proof->>'version' is distinct from 'monthly-initial-resource-proof-v1' or
    p_proof->'paymentContext' is distinct from a.terms->'paymentContext' or
    not coalesce(p_proof->>'requestId' ~ '^req_[A-Za-z0-9]+$',false) then return false; end if;
  v_customer:=coalesce(a.stripe_customer_id,(select provider_id from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind='customer' and scope_key='initial' and status='complete'));
  v_subscription:=coalesce(a.stripe_subscription_id,(select provider_id from public.monthly_mentorship_operations_v1
    where agreement_id=a.id and kind='subscription' and scope_key='initial' and status='complete'),
    (select resource_id from public.monthly_mentorship_initial_closures_v1 where agreement_id=a.id and kind='cancel_subscription'));
  if v_customer is null or p_proof->>'customerId' is distinct from v_customer then return false; end if;
  if p_kind='cancel_subscription' then
    select * into o from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='subscription' and scope_key='initial';
    return coalesce(o.id is not null and p_proof->>'objectType'='subscription' and p_proof->>'objectId' ~ '^sub_[A-Za-z0-9]+$' and
      (v_subscription is null or p_proof->>'objectId'=v_subscription) and p_proof->'metadata' @> (o.request->'params'->'metadata') and
      o.request->'params'->>'customer'=v_customer and p_proof->'metadata'->>'creatornet_membership_id'=a.id::text and
      p_proof->'metadata'->>'creatornet_membership_fingerprint'=a.fingerprint,false);
  elsif p_kind='expire_checkout' then
    select * into o from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='checkout' and scope_key='initial';
    return coalesce(o.id is not null and v_subscription is not null and p_proof->>'objectType'='checkout.session' and
      p_proof->>'objectId' ~ '^cs_[A-Za-z0-9_]+$' and (o.provider_id is null or p_proof->>'objectId'=o.provider_id) and
      p_proof->'metadata'=o.request->'params'->'metadata' and p_proof->>'subscriptionId'=v_subscription and
      o.request->'params'->>'customer'=v_customer and p_proof->>'amountCents'=a.monthly_price_cents::text and
      p_proof->>'paymentStatus'='unpaid',false);
  elsif p_kind in ('hold_invoice','void_invoice') then
    return coalesce(v_subscription is not null and p_proof->>'objectType'='invoice' and p_proof->>'objectId' ~ '^in_[A-Za-z0-9]+$' and
      p_proof->>'subscriptionId'=v_subscription and p_proof->>'amountPaidCents'='0' and p_proof->>'currency'='usd',false);
  end if;
  return false;
end;
$$;
create function public.claim_monthly_initial_closure_v1(p_id uuid,p_buyer_id uuid,p_context jsonb,p_kind text,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_initial_closures_v1%rowtype;
  v_request jsonb; v_id text:=p_proof->>'objectId'; v_terminal boolean;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context or a.initial_abandon_requested_at is null then
    raise exception 'Initial closure lacks owned intent'; end if;
  perform public.assert_monthly_initial_unpaid_v1(a.id);
  if not public.monthly_initial_resource_matches_v1(a.id,p_kind,p_proof) then raise exception 'Initial closure resource differs'; end if;
  v_terminal:=case p_kind when 'expire_checkout' then p_proof->>'status'='expired' when 'cancel_subscription' then p_proof->>'status'='canceled'
    when 'hold_invoice' then p_proof->>'status'='draft' and p_proof->'autoAdvance'='false'::jsonb and p_proof->'hostedInvoiceUrlNull'='true'::jsonb when 'void_invoice' then p_proof->>'status'='void' else false end;
  if not coalesce(v_terminal,false) and not coalesce(case p_kind when 'expire_checkout' then p_proof->>'status'='open'
    when 'cancel_subscription' then p_proof->>'status' in ('trialing','active','past_due','unpaid','paused','incomplete','incomplete_expired')
    when 'hold_invoice' then p_proof->>'status'='draft' when 'void_invoice' then p_proof->>'status' in ('open','uncollectible') else false end,false) then
    raise exception 'Initial closure state is not safely stoppable'; end if;
  v_request:=case p_kind
    when 'expire_checkout' then jsonb_build_object('method','POST','path','/v1/checkout/sessions/'||v_id||'/expire','params','{}'::jsonb)
    when 'cancel_subscription' then jsonb_build_object('method','DELETE','path','/v1/subscriptions/'||v_id,'params',jsonb_build_object('invoice_now',false,'prorate',false))
    when 'hold_invoice' then jsonb_build_object('method','POST','path','/v1/invoices/'||v_id,'params',jsonb_build_object('auto_advance',false))
    when 'void_invoice' then jsonb_build_object('method','POST','path','/v1/invoices/'||v_id||'/void','params','{}'::jsonb) end;
  select * into o from public.monthly_mentorship_initial_closures_v1 where agreement_id=a.id and kind=p_kind and resource_id=v_id for update;
  if found then
    if o.request is distinct from v_request then raise exception 'Initial closure retry differs'; end if;
  else
    if a.initial_abandoned_at is not null then raise exception 'Initial closure cannot invent a retired resource'; end if;
    insert into public.monthly_mentorship_initial_closures_v1(agreement_id,kind,resource_id,request,admission_proof)
      values(a.id,p_kind,v_id,v_request,p_proof) returning * into o;
  end if;
  if not coalesce(v_terminal,false) and o.status<>'complete' and o.provider_started_at is null then
    update public.monthly_mentorship_initial_closures_v1 set provider_started_at=clock_timestamp() where id=o.id returning * into o;
  end if;
  -- These exact collection-stop operations cannot create a charge,
  -- invoice or credit. A fresh owned nonterminal read permits retry under the
  -- SAME resource and operation identity; timestamps are never reset.
  return to_jsonb(o);
end;
$$;
create function public.complete_monthly_initial_closure_v1(p_operation_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_initial_closures_v1%rowtype; v_id uuid;
begin
  select agreement_id into v_id from public.monthly_mentorship_initial_closures_v1 where id=p_operation_id;
  select * into a from public.monthly_mentorship_agreements_v1 where id=v_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context then raise exception 'Initial closure completion owner differs'; end if;
  select * into o from public.monthly_mentorship_initial_closures_v1 where id=p_operation_id for update;
  if p_proof->>'objectId' is distinct from o.resource_id or not public.monthly_initial_resource_matches_v1(a.id,o.kind,p_proof) or
    p_proof->>'status' is distinct from (case o.kind when 'expire_checkout' then 'expired' when 'cancel_subscription' then 'canceled'
      when 'hold_invoice' then 'draft' when 'void_invoice' then 'void' end) or
    (o.kind='hold_invoice' and (p_proof->'autoAdvance' is distinct from 'false'::jsonb or p_proof->'hostedInvoiceUrlNull' is distinct from 'true'::jsonb)) then
    raise exception 'Initial closure lacks terminal proof'; end if;
  if o.status='complete' then return false; end if;
  update public.monthly_mentorship_initial_closures_v1 set status='complete',provider_proof=p_proof,completed_at=clock_timestamp() where id=o.id;
  return true;
end;
$$;
create function public.complete_monthly_initial_abandonment_v1(p_id uuid,p_buyer_id uuid,p_context jsonb,p_proof jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_sub text; v_session text; v_customer text; v_payable boolean;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id and buyer_id=p_buyer_id for update;
  if not found or a.terms->'paymentContext' is distinct from p_context or a.initial_abandon_requested_at is null then
    raise exception 'Initial abandonment lacks owned intent'; end if;
  perform public.assert_monthly_initial_unpaid_v1(a.id);
  if a.initial_abandoned_at is not null then return false; end if;
  if p_proof->>'version' is distinct from 'monthly-initial-abandonment-proof-v1' or p_proof->'paymentContext' is distinct from p_context or
    p_proof->>'membershipId' is distinct from a.id::text then raise exception 'Initial abandonment context differs'; end if;
  select exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind in ('subscription','hold','checkout','activate','collect')) into v_payable;
  if p_proof->'neverPayable'='true'::jsonb then
    if v_payable or a.stripe_customer_id is not null or a.stripe_subscription_id is not null or a.stripe_checkout_session_id is not null then
      raise exception 'Initial provider work cannot be treated as never started'; end if;
  else
    select resource_id into v_sub from public.monthly_mentorship_initial_closures_v1 where agreement_id=a.id and kind='cancel_subscription' and status='complete';
    select resource_id into v_session from public.monthly_mentorship_initial_closures_v1 where agreement_id=a.id and kind='expire_checkout' and status='complete';
    v_customer:=coalesce(a.stripe_customer_id,(select provider_id from public.monthly_mentorship_operations_v1
      where agreement_id=a.id and kind='customer' and scope_key='initial' and status='complete'));
    if v_customer is null or p_proof->>'customerId' is distinct from v_customer or
      p_proof->'neverPayable' is distinct from 'false'::jsonb or
      jsonb_typeof(p_proof->'readRequestIds') is distinct from 'array' then raise exception 'Initial abandonment provider context differs'; end if;
    if jsonb_array_length(p_proof->'readRequestIds')<>6 or exists(select 1 from jsonb_array_elements_text(p_proof->'readRequestIds') r
      where not coalesce(r ~ '^req_[A-Za-z0-9]+$',false)) then raise exception 'Initial abandonment reads lack provenance'; end if;
    if v_sub is null or p_proof->>'subscriptionId' is distinct from v_sub or
      (exists(select 1 from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='checkout') and v_session is null) or
      p_proof->>'checkoutSessionId' is distinct from v_session or p_proof->'listsComplete' is distinct from 'true'::jsonb or
      p_proof->>'pendingInvoiceItemCount' is distinct from '0' or
      jsonb_typeof(p_proof->'paymentIntents') is distinct from 'array' or jsonb_typeof(p_proof->'charges') is distinct from 'array' or
      jsonb_typeof(p_proof->'invoices') is distinct from 'array' or jsonb_typeof(p_proof->'subscriptions') is distinct from 'array' or
      jsonb_typeof(p_proof->'checkouts') is distinct from 'array' then raise exception 'Initial abandonment provider barriers are incomplete'; end if;
    if exists(select 1 from jsonb_array_elements(p_proof->'paymentIntents') r where r->>'status' is distinct from 'canceled' or
      r->>'amountReceivedCents' is distinct from '0' or r->>'amountCapturableCents' is distinct from '0') or
      exists(select 1 from jsonb_array_elements(p_proof->'charges') r where r->'paid' is distinct from 'false'::jsonb or
        r->>'amountCapturedCents' is distinct from '0') or
      exists(select 1 from jsonb_array_elements(p_proof->'invoices') r where r->>'amountPaidCents' is distinct from '0' or
        not coalesce(r->>'status'='void' or (r->>'status'='paid' and r->>'totalCents'='0') or
          (r->>'status'='draft' and r->'autoAdvance'='false'::jsonb and r->'hostedInvoiceUrlNull'='true'::jsonb),false)) or
      exists(select 1 from jsonb_array_elements(p_proof->'subscriptions') r where r->>'status' is distinct from 'canceled') or
      exists(select 1 from jsonb_array_elements(p_proof->'checkouts') r where r->>'status' is distinct from 'expired' or r->>'paymentStatus' is distinct from 'unpaid') or
      not exists(select 1 from jsonb_array_elements(p_proof->'subscriptions') r where r->>'id'=v_sub) or
      (v_session is not null and not exists(select 1 from jsonb_array_elements(p_proof->'checkouts') r where r->>'id'=v_session)) or
      exists(select 1 from public.monthly_mentorship_initial_closures_v1 where agreement_id=a.id and status<>'complete') then
      raise exception 'Initial checkout still has money or payable provider state'; end if;
  end if;
  update public.monthly_mentorship_agreements_v1 set initial_abandoned_at=clock_timestamp(),initial_abandon_proof=p_proof,revision=revision+1 where id=a.id;
  update public.purchases set status='canceled' where id=a.purchase_id;
  return true;
end;
$$;

-- Only a proven unpaid monthly close-out is history, not the current slot.
do $purchase_preflight$ begin
  if (select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.purchases'::regclass and
    conname='purchases_buyer_post_unique') is distinct from 'UNIQUE (buyer_id, post_id)' or
    exists(select 1 from public.purchases where kind='monthly_mentorship_v1' and status='canceled') or
    not exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.purchases_unique_buyer_product') and
      i.indrelid='public.purchases'::regclass and i.indisunique and i.indisvalid and i.indnkeyatts=2 and
      pg_get_indexdef(i.indexrelid,1,true)='buyer_id' and pg_get_indexdef(i.indexrelid,2,true)='product_id' and
      pg_get_expr(i.indpred,i.indrelid)='(product_id IS NOT NULL)') then
    raise exception 'Initial close-out purchase uniqueness prerequisites differ'; end if;
end; $purchase_preflight$;
create function public.guard_monthly_initial_purchase_close_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
begin
  if new.kind is distinct from 'monthly_mentorship_v1' and new.monthly_mentorship_id is null then return new; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=new.monthly_mentorship_id and purchase_id=new.id;
  if not found or new.kind is distinct from 'monthly_mentorship_v1' then raise exception 'Initial close-out purchase identity differs'; end if;
  if (new.status='canceled' and (a.initial_abandoned_at is null or a.covered_months<>0 or a.initial_abandon_proof is null)) or
    (a.initial_abandoned_at is not null and new.status is distinct from 'canceled') then
    raise exception 'Monthly canceled purchase requires proven unpaid close-out'; end if;
  return new;
end;
$$;
create trigger guard_monthly_initial_purchase_close_v1 before insert or update on public.purchases
for each row execute function public.guard_monthly_initial_purchase_close_v1();
revoke all on function public.guard_monthly_initial_purchase_close_v1() from public,anon,authenticated,service_role;
alter table public.purchases drop constraint purchases_buyer_post_unique;
create unique index purchases_buyer_post_unique on public.purchases(buyer_id,post_id)
  where kind is distinct from 'monthly_mentorship_v1' or status is distinct from 'canceled';
drop index public.purchases_unique_buyer_product;
create unique index purchases_unique_buyer_product on public.purchases(buyer_id,product_id)
  where product_id is not null and (kind is distinct from 'monthly_mentorship_v1' or status is distinct from 'canceled');
create or replace function public.reserve_monthly_mentorship_v1(p_buyer_id uuid,p_product_id uuid,p_post_id uuid,
  p_terms jsonb,p_fingerprint text,p_accepted boolean) returns uuid
language plpgsql security definer set search_path=pg_catalog as $$
declare p public.products%rowtype; v_id uuid; v_purchase uuid:=gen_random_uuid(); a public.monthly_mentorship_agreements_v1%rowtype;
begin
  if p_accepted is distinct from true or p_buyer_id is null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Explicit current membership acceptance is required'; end if;
  select * into p from public.products where id=p_product_id for share;
  if not found or p.membership_terms is null or not public.valid_monthly_mentorship_terms_v1(p.type,p.membership_terms) or
    p.creator_id is null or p.creator_id=p_buyer_id or p.currency is distinct from 'usd' or p.price_cents is distinct from p.amount_cents or
    p_terms->>'version' is distinct from 'monthly-mentorship-purchase-v1' or p_terms->>'kind' is distinct from 'monthly_mentorship' or
    p_terms->>'buyerId' is distinct from p_buyer_id::text or p_terms->>'creatorId' is distinct from p.creator_id::text or
    p_terms->>'productId' is distinct from p_product_id::text or p_terms->>'postId' is distinct from p_post_id::text or
    p_terms->>'title' is distinct from p.title or p_terms->>'description' is distinct from coalesce(p.description,'') or
    p_terms->>'currency' is distinct from 'usd' or p_terms->>'monthlyPriceCents' is distinct from p.price_cents::text or
    p_terms->>'minimumMonths' is distinct from p.membership_terms->>'minimumMonths' or
    p_terms->>'autoRenew' is distinct from p.membership_terms->>'autoRenew' or
    p_terms->>'minimumTotalCents' is distinct from (p.price_cents::bigint*(p.membership_terms->>'minimumMonths')::integer)::text or
    p_terms->>'policyVersion' is distinct from 'creatornet-purchase-2026-09-09-v1' or
    p_terms#>>'{policy,version}' is distinct from 'creatornet-purchase-2026-09-09-v1' or
    not public.valid_monthly_fee_snapshot_v1(p_terms->'firstMonthFees',p.price_cents) or
    not public.valid_monthly_fee_snapshot_v1(p_terms->'recurringMonthFees',p.price_cents) or
    not coalesce(p_terms#>>'{paymentContext,stripeAccountId}' ~ '^acct_[A-Za-z0-9]+$',false) or
    not coalesce(p_terms#>>'{paymentContext,mode}' in ('test','live'),false) or
    p_terms#>>'{paymentContext,apiVersion}' is distinct from '2025-10-29.clover' or
    not coalesce(p_terms#>>'{paymentContext,supabaseProjectRef}' ~ '^[a-z0-9]{20}$',false) or
    not coalesce(p_terms#>>'{paymentContext,siteOrigin}' ~ '^https://[^/?#@]+$',false) then
    raise exception 'Monthly consent does not match the owned current offer'; end if;
  if not exists(select 1 from public.posts where id=p_post_id and creator_id=p.creator_id and product_id=p.id) then
    raise exception 'Post does not sell the monthly offer'; end if;
  if not exists(select 1 from public.profiles where id=p.creator_id and stripe_account_id=p_terms->>'destinationId' and
    stripe_account_id ~ '^acct_[A-Za-z0-9]+$') then raise exception 'Monthly creator payout binding differs'; end if;
  insert into public.monthly_mentorship_agreements_v1(purchase_id,buyer_id,creator_id,product_id,post_id,terms,fingerprint,
    monthly_price_cents,minimum_months,auto_renew)
    values(v_purchase,p_buyer_id,p.creator_id,p.id,p_post_id,p_terms,p_fingerprint,p.price_cents,
      (p.membership_terms->>'minimumMonths')::integer,(p.membership_terms->>'autoRenew')::boolean)
    on conflict(buyer_id,product_id) where initial_abandoned_at is null do nothing returning id into v_id;
  if v_id is null then
    select * into a from public.monthly_mentorship_agreements_v1 where buyer_id=p_buyer_id and product_id=p.id and initial_abandoned_at is null;
    if a.id is null or a.fingerprint is distinct from p_fingerprint or a.terms is distinct from p_terms or a.post_id is distinct from p_post_id then
      raise exception 'Existing monthly agreement differs; it cannot be reinterpreted'; end if;
    return a.id;
  end if;
  insert into public.purchases(id,buyer_id,buyer_user_id,creator_id,product_id,post_id,amount_cents,currency,status,kind,
    product_type,title,access_granted,monthly_mentorship_id)
    values(v_purchase,p_buyer_id,p_buyer_id,p.creator_id,p.id,p_post_id,p.price_cents,'usd','pending','monthly_mentorship_v1',
      'mentorship',p.title,false,v_id);
  return v_id;
end;
$$;

revoke all on function public.assert_monthly_initial_unpaid_v1(uuid),public.monthly_initial_resource_matches_v1(uuid,text,jsonb),
  public.request_monthly_initial_abandonment_v1(uuid,uuid,jsonb,boolean),
  public.claim_monthly_initial_closure_v1(uuid,uuid,jsonb,text,jsonb),
  public.complete_monthly_initial_closure_v1(uuid,uuid,jsonb,jsonb),
  public.complete_monthly_initial_abandonment_v1(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.request_monthly_initial_abandonment_v1(uuid,uuid,jsonb,boolean),
  public.claim_monthly_initial_closure_v1(uuid,uuid,jsonb,text,jsonb),
  public.complete_monthly_initial_closure_v1(uuid,uuid,jsonb,jsonb),
  public.complete_monthly_initial_abandonment_v1(uuid,uuid,jsonb,jsonb) to service_role;
create or replace function public.read_monthly_mentorship_management_v1(p_actor_id uuid,p_view text,p_context jsonb,
  p_after timestamptz default null,p_after_id uuid default null,p_limit integer default 12)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_items jsonb:='[]'::jsonb; v_count integer:=0;
  v_last_at timestamptz; v_last_id uuid; v_next jsonb; v_payoff jsonb; v_access jsonb; v_quote jsonb; v_exit jsonb;
begin
  if p_actor_id is null or p_view is null or p_view not in ('buyer','creator') or p_limit is null or p_limit<1 or p_limit>12 or
    jsonb_typeof(p_context) is distinct from 'object' or (p_after is null)<>(p_after_id is null) or
    (p_after is not null and not isfinite(p_after)) then raise exception 'Monthly management request differs'; end if;
  for a in select * from public.monthly_mentorship_agreements_v1 m where
    (case p_view when 'buyer' then m.buyer_id=p_actor_id else m.creator_id=p_actor_id end) and m.terms->'paymentContext'=p_context and
    (p_after is null or (m.accepted_at,m.id)<(p_after,p_after_id)) order by m.accepted_at desc,m.id desc limit p_limit+1
  loop
    v_count:=v_count+1;
    if v_count>p_limit then v_next:=jsonb_build_object('acceptedAt',v_last_at,'id',v_last_id); exit; end if;
    v_payoff:=null;
    select jsonb_build_object('id',pf.id,'status',pf.status) into v_payoff from public.monthly_mentorship_payoffs_v1 pf
      where pf.agreement_id=a.id and pf.status<>'abandoned' order by pf.accepted_at desc,pf.id desc limit 1;
    v_access:=public.read_monthly_mentorship_entitlement_v1(a.purchase_id,a.buyer_id);
    v_quote:=public.read_monthly_mentorship_exit_quote_v1(a.id,a.buyer_id,p_context);
    v_exit:=public.read_monthly_mentorship_exit_status_v1(a.id,a.buyer_id,p_context);
    v_items:=v_items||jsonb_build_array(jsonb_build_object('id',a.id,'acceptedAt',a.accepted_at,'title',a.terms->>'title',
      'postId',a.post_id,'productId',a.product_id,'counterpartyId',case p_view when 'buyer' then a.creator_id else a.buyer_id end,
      'monthlyPriceCents',a.monthly_price_cents,'minimumMonths',a.minimum_months,'autoRenew',a.auto_renew,
      'initialAbandoned',a.initial_abandoned_at is not null,
      'firstPaymentRecorded',a.covered_months>0,'billingReview',a.billing_review_at is not null,
      'quote',v_quote,'access',v_access,'exitStatus',v_exit,'payoff',v_payoff));
    v_last_at:=a.accepted_at; v_last_id:=a.id;
  end loop;
  return jsonb_build_object('view',p_view,'items',v_items,'nextCursor',v_next);
end;
$$;
commit;
