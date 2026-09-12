begin;

-- Prospective exact-cents-held-v1 only. Requires 040-043; no backfill, Stripe
-- calls, link publication, collection enablement or policy change occurs here.
alter table public.exact_installment_agreements
  add column purchase_seeded_at timestamptz,
  add column first_fulfilled_at timestamptz;

-- Only a newly inserted purchase can become this agreement's purchase. In
-- particular, a retry MUST NOT upsert over a buyer's earlier course purchase.
create function public.seed_exact_installment_purchase(p_agreement_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  bp public.booking_payments%rowtype;
  b public.bookings%rowtype;
  p public.purchases%rowtype;
  product public.products%rowtype;
  new_id uuid;
  gross integer;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status not in ('awaiting_first','active','complete') or
     a.stripe_checkout_session_id is null or a.stripe_subscription_id is null or a.stripe_customer_id is null then
    raise exception 'exact Checkout binding not ready';
  end if;
  if a.purchase_id is not null then
    if a.purchase_seeded_at is null then raise exception 'existing purchase requires review, not adoption'; end if;
    perform public.bind_exact_installment_purchase(a.id,a.purchase_id);
    return a.purchase_id;
  end if;
  if a.status <> 'awaiting_first' or a.purchase_seeded_at is not null or
     exists(select 1 from public.exact_installment_receipts where agreement_id=a.id) then
    raise exception 'new purchase must precede payment evidence';
  end if;
  select * into bp from public.booking_payments where id=a.booking_payment_id for update;
  select * into b from public.bookings where id=bp.booking_id for update;
  if bp.id is null or b.id is null or bp.status::text not in ('pending','link_sent') or
     b.status is distinct from 'booked' or bp.plan_type::text is distinct from 'installment' or
     bp.booking_id::text is distinct from a.terms->>'bookingId' or
     bp.buyer_id::text is distinct from a.terms->>'buyerId' or
     bp.product_id::text is distinct from a.terms->>'productId' or
     b.buyer_id::text is distinct from a.terms->>'buyerId' or
     b.creator_id::text is distinct from a.terms->>'creatorId' or
     b.post_id::text is distinct from a.terms->>'postId' or
     bp.amount_total_cents is distinct from (a.terms->>'totalCents')::bigint or
     bp.installment_months is distinct from (a.terms->>'paymentCount')::integer or
     lower(trim(bp.currency)) is distinct from 'usd' or
     bp.link_url is not null or
     (bp.stripe_checkout_session_id is not null and bp.stripe_checkout_session_id<>a.stripe_checkout_session_id) or
     (bp.stripe_subscription_id is not null and bp.stripe_subscription_id<>a.stripe_subscription_id) then
    raise exception 'booking changed or already has a payment path';
  end if;
  -- productId is the products ROW id (the purchases FK), not its public alias.
  select * into product from public.products where id=(a.terms->>'productId')::uuid;
  if not found or product.creator_id::text is distinct from a.terms->>'creatorId' or
     product.type not in ('video','course','mentorship') or not product.is_active or
     not exists(select 1 from public.posts where id=(a.terms->>'postId')::uuid
       and product_id=product.id and creator_id=(a.terms->>'creatorId')::uuid) then
    raise exception 'product and post ownership mismatch';
  end if;
  if exists(select 1 from public.purchases where buyer_id=(a.terms->>'buyerId')::uuid
      and (post_id=(a.terms->>'postId')::uuid or product_id=product.id)) then
    raise exception 'buyer already has a purchase; no replacement permitted';
  end if;
  gross := (a.terms->>'totalCents')::bigint / (a.terms->>'paymentCount')::integer;
  new_id := gen_random_uuid();
  insert into public.purchases(id,buyer_id,buyer_user_id,creator_id,post_id,product_id,booking_id,
    session_id,subscription_id,currency,status,is_refund,is_suspect,access_granted,paid_count,
    target_months,plan_months,plan_amount_cents,amount_cents,product_type,kind,title,created_at)
  values(new_id,(a.terms->>'buyerId')::uuid,(a.terms->>'buyerId')::uuid,(a.terms->>'creatorId')::uuid,
    (a.terms->>'postId')::uuid,product.id,b.id,a.stripe_checkout_session_id,a.stripe_subscription_id,
    'usd','pending',false,false,false,0,(a.terms->>'paymentCount')::integer,
    (a.terms->>'paymentCount')::integer,gross,gross,product.type,'installment',a.terms->>'title',now());
  perform public.bind_exact_installment_purchase(a.id,new_id);
  update public.exact_installment_agreements set purchase_seeded_at=now(),updated_at=now() where id=a.id;
  -- Reserve the matching identifiers, but do not mark paid or expose a URL.
  update public.booking_payments set stripe_checkout_session_id=a.stripe_checkout_session_id,
    stripe_subscription_id=a.stripe_subscription_id,updated_at=now() where id=bp.id;
  return new_id;
end;
$$;

-- Prevent the old pending-link code from publishing a second Stripe session
-- for a reserved exact agreement. Other booking payments are unaffected.
-- This does not claim to prevent an already in-flight remote Stripe creation;
-- that unpublished object needs reconciliation before rollout acceptance.
create function public.guard_exact_installment_booking_binding()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.exact_installment_agreements%rowtype;
begin
  select * into a from public.exact_installment_agreements where booking_payment_id=old.id;
  if not found then return new; end if;
  if new.booking_id is distinct from old.booking_id or new.buyer_id is distinct from old.buyer_id or
     new.product_id is distinct from old.product_id or new.plan_type is distinct from old.plan_type or
     new.amount_total_cents is distinct from old.amount_total_cents or
     new.installment_months is distinct from old.installment_months or new.currency is distinct from old.currency or
     (new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id and
       (a.stripe_checkout_session_id is null or new.stripe_checkout_session_id is distinct from a.stripe_checkout_session_id)) or
     (new.stripe_subscription_id is distinct from old.stripe_subscription_id and
       (a.stripe_subscription_id is null or new.stripe_subscription_id is distinct from a.stripe_subscription_id)) or
     (new.link_url is distinct from old.link_url and
       (a.purchase_seeded_at is null or new.stripe_checkout_session_id is distinct from a.stripe_checkout_session_id or
        new.stripe_subscription_id is distinct from a.stripe_subscription_id)) then
    raise exception 'exact booking payment identity is reserved';
  end if;
  return new;
end;
$$;
create trigger exact_installment_booking_binding before update on public.booking_payments
  for each row execute function public.guard_exact_installment_booking_binding();

-- Receipt accounting already grants paid access atomically. This separate,
-- retryable delivery step attaches current creator-supplied resources and
-- completes the SALES booking, NOT the installment balance. Never set
-- first_access_at here: attaching a resource is not evidence it was opened.
create function public.fulfill_exact_installment_first_payment(p_agreement_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  a public.exact_installment_agreements%rowtype;
  p public.purchases%rowtype;
  r public.exact_installment_receipts%rowtype;
  l public.payment_fee_ledger%rowtype;
  bp public.booking_payments%rowtype;
  b public.bookings%rowtype;
  product public.products%rowtype;
  delivery_kind text;
  delivery_url text;
begin
  select * into a from public.exact_installment_agreements where id=p_agreement_id for update;
  if not found or a.status not in ('awaiting_first','active','complete') or a.purchase_seeded_at is null then
    raise exception 'exact purchase not ready for delivery';
  end if;
  select * into r from public.exact_installment_receipts where agreement_id=a.id and payment_number=1;
  select * into l from public.payment_fee_ledger where id=r.ledger_id for update;
  select * into p from public.purchases where id=a.purchase_id for update;
  if p.id is null or r.counted_at is null or l.id is null or l.earnings_credited_at is null or
     l.purchase_id is distinct from p.id or l.booking_payment_id is distinct from a.booking_payment_id or
     l.stripe_payment_intent_id is distinct from r.stripe_payment_intent_id or
     p.status not in ('active','complete') or not p.access_granted or coalesce(p.paid_count,0)<1 or
     p.paid_count>(a.terms->>'paymentCount')::integer or
     p.target_months is distinct from (a.terms->>'paymentCount')::integer or lower(p.currency) is distinct from 'usd' or
     p.is_refund or p.is_suspect or l.status is distinct from 'paid' or
     (l.dispute_status is not null and l.dispute_status not in ('won','warning_closed')) or
     coalesce(l.refunded_amount_cents,0)>0 or coalesce(l.earnings_reversed_cents,0)>0 or
     p.session_id is distinct from a.stripe_checkout_session_id or
     p.subscription_id is distinct from a.stripe_subscription_id or
     p.buyer_id::text is distinct from a.terms->>'buyerId' or
     p.creator_id::text is distinct from a.terms->>'creatorId' or
     p.post_id::text is distinct from a.terms->>'postId' or
     p.product_id::text is distinct from a.terms->>'productId' or
     p.booking_id::text is distinct from a.terms->>'bookingId' or
     exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=r.stripe_payment_intent_id and refunded_amount_cents>0) or
     exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=r.stripe_payment_intent_id and status not in ('won','warning_closed')) or
     exists(select 1 from public.refund_operations where stripe_payment_intent_id=r.stripe_payment_intent_id and status not in ('failed','completed')) then
    raise exception 'verified unrefunded first credit required for delivery';
  end if;
  select * into bp from public.booking_payments where id=a.booking_payment_id for update;
  select * into b from public.bookings where id=(a.terms->>'bookingId')::uuid for update;
  if bp.id is null or b.id is null or bp.booking_id<>b.id or
     bp.status::text not in ('pending','link_sent','completed') or b.status not in ('booked','completed') or
     bp.stripe_checkout_session_id is distinct from a.stripe_checkout_session_id or
     bp.stripe_subscription_id is distinct from a.stripe_subscription_id or
     b.buyer_id is distinct from p.buyer_id or b.creator_id is distinct from p.creator_id or b.post_id is distinct from p.post_id then
    raise exception 'booking no longer eligible for completion';
  end if;
  if a.first_fulfilled_at is not null then return; end if;
  select * into product from public.products where id=p.product_id;
  if not found or product.creator_id is distinct from p.creator_id then raise exception 'delivery product mismatch'; end if;
  delivery_url := coalesce(nullif(trim(product.discord_invite_url),''),nullif(trim(product.whop_listing_url),''));
  delivery_kind := case when nullif(trim(product.discord_invite_url),'') is not null then 'discord'
    when nullif(trim(product.whop_listing_url),'') is not null then 'whop' else null end;
  if delivery_url is not null and delivery_url !~ '^https://[^[:space:]/?#]+(/[^[:space:]]*)?$' then
    raise exception 'delivery URL requires review';
  end if;
  if p.fulfillment_url is not null or p.fulfillment is not null or p.fulfillment_payload is not null then
    raise exception 'unexpected preexisting delivery; do not overwrite';
  end if;
  -- A native video has no external URL; its existing access-controlled player
  -- uses this same purchase/access grant. No fabricated invite is substituted.
  update public.purchases set fulfillment=delivery_kind,fulfillment_url=delivery_url,
    fulfillment_payload=case when delivery_url is not null then jsonb_build_object('source','product',
      'product_id',product.product_id,'title',product.title,'note','creator-supplied fulfillment link') else null end,
    paid_at=coalesce(paid_at,r.paid_at) where id=p.id;
  update public.booking_payments set status='completed',completed_at=coalesce(completed_at,r.paid_at),
    stripe_payment_intent_id=r.stripe_payment_intent_id,updated_at=now() where id=bp.id;
  update public.bookings set status='completed' where id=b.id;
  update public.exact_installment_agreements set first_fulfilled_at=now(),updated_at=now() where id=a.id;
end;
$$;

revoke all on function public.seed_exact_installment_purchase(uuid) from public,anon,authenticated;
revoke all on function public.fulfill_exact_installment_first_payment(uuid) from public,anon,authenticated;
revoke all on function public.guard_exact_installment_booking_binding() from public,anon,authenticated,service_role;
grant execute on function public.seed_exact_installment_purchase(uuid) to service_role;
grant execute on function public.fulfill_exact_installment_first_payment(uuid) to service_role;
commit;
