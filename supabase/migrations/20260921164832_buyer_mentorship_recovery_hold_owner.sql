begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.buyer_mentorship_billing_state_v1
  add column collection_hold_generation bigint not null default 0;
create function public.advance_buyer_mentorship_hold_generation_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  new.collection_hold_generation:=old.collection_hold_generation+1;
  return new;
end $$;
revoke all on function public.advance_buyer_mentorship_hold_generation_v1() from public,anon,authenticated;
create trigger advance_buyer_mentorship_hold_generation_v1 before update of collection_hold_at
  on public.buyer_mentorship_billing_state_v1 for each row
  execute function public.advance_buyer_mentorship_hold_generation_v1();

-- Retain provenance only for a hold actually created by this recovery call.
-- Existing/legacy/operational holds can never be adopted by observing them.
create table public.buyer_mentorship_recovery_hold_owners_v1 (
  reservation_id uuid not null,
  payment_number integer not null,
  held_at timestamptz not null,
  held_revision bigint not null,
  held_generation bigint not null,
  primary key(reservation_id,payment_number),
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_payment_admissions_v1(reservation_id,payment_number)
);
create table public.buyer_mentorship_same_card_releases_v1 (
  reservation_id uuid not null,
  payment_number integer not null,
  held_at timestamptz not null,
  held_revision bigint not null,
  verified_basis jsonb not null,
  released_at timestamptz not null default clock_timestamp(),
  primary key(reservation_id,payment_number),
  foreign key(reservation_id,payment_number) references public.buyer_mentorship_recovery_hold_owners_v1(reservation_id,payment_number)
);
alter table public.buyer_mentorship_recovery_hold_owners_v1 enable row level security;
alter table public.buyer_mentorship_same_card_releases_v1 enable row level security;
revoke all on public.buyer_mentorship_recovery_hold_owners_v1,public.buyer_mentorship_same_card_releases_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_recovery_hold_owners_v1,public.buyer_mentorship_same_card_releases_v1 to service_role;

create or replace function public.begin_buyer_mentorship_payment_recovery_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_invoice_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; a public.buyer_mentorship_payment_admissions_v1%rowtype;
  p public.buyer_mentorship_collection_periods_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype;
  recovery public.buyer_mentorship_payment_recoveries_v1%rowtype;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Buyer recovery isolation differs'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer recovery unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into a from public.buyer_mentorship_payment_admissions_v1 where reservation_id=r.id and invoice_id=p_invoice_id;
  if not found then raise exception 'Buyer recovery requires original admission'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a.payment_intent_id,73591));
  select * into p from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number=a.payment_number;
  if p.invoice_id is distinct from a.invoice_id or p.admitted_at is distinct from a.admitted_at then raise exception 'Buyer recovery period differs'; end if;
  insert into public.buyer_mentorship_payment_recoveries_v1(reservation_id,payment_number,invoice_id,payment_intent_id)
    values(r.id,a.payment_number,a.invoice_id,a.payment_intent_id) on conflict(reservation_id,payment_number) do nothing;
  select * into recovery from public.buyer_mentorship_payment_recoveries_v1 where reservation_id=r.id and payment_number=a.payment_number;
  if recovery.invoice_id is distinct from a.invoice_id or recovery.payment_intent_id is distinct from a.payment_intent_id then raise exception 'Original buyer recovery differs'; end if;
  update public.buyer_mentorship_billing_state_v1 set collection_hold_at=clock_timestamp(),revision=revision+1
    where reservation_id=r.id and collection_hold_at is null and p.counted_at is null returning * into b;
  if found then
    insert into public.buyer_mentorship_recovery_hold_owners_v1(reservation_id,payment_number,held_at,held_revision,held_generation)
      values(r.id,a.payment_number,b.collection_hold_at,b.revision,b.collection_hold_generation);
  end if;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  if not found then raise exception 'Buyer recovery billing state unavailable'; end if;
  return jsonb_build_object('reservationId',r.id,'paymentIntentId',a.payment_intent_id,'paymentNumber',a.payment_number,
    'revision',b.revision,'recoveryRevision',recovery.revision,'paidCount',b.paid_count,'countedAt',p.counted_at);
end $$;

-- Same admitted card only. Replacement-payment attempts still require their
-- separate saved future-card consent and existing release protocol.
create function public.read_buyer_mentorship_same_card_context_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_invoice_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  b public.buyer_mentorship_billing_state_v1%rowtype; a public.buyer_mentorship_payment_admissions_v1%rowtype;
  f public.buyer_mentorship_first_receipts_v1%rowtype; owner public.buyer_mentorship_recovery_hold_owners_v1%rowtype;
  card public.buyer_mentorship_invoice_cards_v1%rowtype;
  authority public.buyer_mentorship_future_card_authorizations_v1%rowtype;
  latest_b jsonb; receipt jsonb; prior jsonb:='[]'::jsonb; remaining jsonb; pi text; n integer;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Buyer continuation isolation differs'; end if;
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer continuation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into a from public.buyer_mentorship_payment_admissions_v1 where reservation_id=r.id and invoice_id=p_invoice_id;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  select * into f from public.buyer_mentorship_first_receipts_v1 where reservation_id=r.id;
  if a.reservation_id is null or b.reservation_id is null or f.reservation_id is null or
    exists(select 1 from public.buyer_mentorship_retry_admissions_v1 where reservation_id=r.id and payment_number=a.payment_number) then
    raise exception 'Buyer continuation requires the original admitted card'; end if;
  receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,a.payment_intent_id);
  if receipt is null or receipt->>'invoiceId' is distinct from a.invoice_id or
    receipt#>>'{proof,paymentMethodId}' is distinct from a.payment_method_id or receipt#>>'{proof,buyerCountry}' is distinct from 'US' then
    raise exception 'Buyer continuation requires accounted original capture'; end if;
  if b.collection_hold_at is null then return jsonb_build_object('status','not_held','reservationId',r.id); end if;
  if b.paid_count=(r.terms->>'paymentCount')::integer and b.next_payment_at is null then
    return jsonb_build_object('status','complete','reservationId',r.id); end if;
  select * into owner from public.buyer_mentorship_recovery_hold_owners_v1 where reservation_id=r.id and payment_number=a.payment_number;
  if owner.reservation_id is null or owner.held_at is distinct from b.collection_hold_at or owner.held_revision>b.revision or owner.held_generation is distinct from b.collection_hold_generation or
    b.collection_enabled_at is null or b.debit_revoked_at is not null or b.financial_hold_at is not null or b.paid_count<>a.payment_number or
    (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb or
    exists(select 1 from public.buyer_mentorship_same_card_releases_v1 where reservation_id=r.id and payment_number=a.payment_number) then
    raise exception 'Buyer recovery hold is not eligible for original continuation'; end if;
  for n in 1..a.payment_number loop
    if n=1 then pi:=f.payment_intent_id;
    else select payment_intent_id into pi from public.buyer_mentorship_later_receipts_v1 where reservation_id=r.id and payment_number=n; end if;
    perform pg_advisory_xact_lock(hashtextextended(pi,73591));
    receipt:=public.read_buyer_mentorship_credited_payment_v1(p_request_id,p_buyer_id,p_context,pi);
    if receipt is null or receipt#>'{proof,paymentNumber}' is distinct from to_jsonb(n) or
      exists(select 1 from public.payment_dispute_state where stripe_payment_intent_id=pi) or
      exists(select 1 from public.payment_refund_state where stripe_payment_intent_id=pi) or
      exists(select 1 from public.refund_operations where stripe_payment_intent_id=pi and status is distinct from 'failed') then raise exception 'Buyer continuation history requires review'; end if;
    prior:=prior||jsonb_build_array(jsonb_build_object('paymentNumber',n,'paymentIntentId',pi));
  end loop;
  select jsonb_agg(jsonb_build_object('paymentNumber',payment_number,'amountCents',amount_cents,'dueAt',due_at,'periodEnd',period_end) order by payment_number)
    into remaining from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number>a.payment_number;
  if remaining is null or jsonb_array_length(remaining)<>(r.terms->>'paymentCount')::integer-a.payment_number or
    b.next_payment_at is distinct from (remaining#>>'{0,dueAt}')::bigint or
    exists(select 1 from public.buyer_mentorship_collection_periods_v1 where reservation_id=r.id and payment_number>a.payment_number and
      (counted_at is not null or admitted_at is not null or invoice_id is not null or due_at<=extract(epoch from clock_timestamp()))) or
    exists(select 1 from public.buyer_mentorship_invoice_claims_v1 where reservation_id=r.id and payment_number>a.payment_number) then
    raise exception 'Buyer continuation remaining schedule requires review'; end if;
  -- Existing future authorization, if any, must still designate this same card
  -- for every remaining period; this does not create or extend card consent.
  if exists(select 1 from public.buyer_mentorship_future_card_authorizations_v1
    where reservation_id=r.id and after_payment_number>=a.payment_number) then raise exception 'Buyer future card authority changed'; end if;
  select * into card from public.buyer_mentorship_invoice_cards_v1 where reservation_id=r.id and payment_number=a.payment_number;
  if card.invoice_id is distinct from a.invoice_id or card.payment_method_id is distinct from a.payment_method_id or
    card.original_default_payment_method_id is distinct from f.proof->>'paymentMethodId' then
    raise exception 'Buyer continuation card binding differs'; end if;
  select * into authority from public.buyer_mentorship_future_card_authorizations_v1 where reservation_id=r.id
    order by after_payment_number desc limit 1;
  if authority.quote_id is null then
    if card.authorization_quote_id is not null or a.payment_method_id is distinct from f.proof->>'paymentMethodId' then
      raise exception 'Buyer continuation card authority unavailable'; end if;
  else
    if card.authorization_quote_id is distinct from authority.quote_id or authority.payment_method_id is distinct from a.payment_method_id or
      authority.original_default_payment_method_id is distinct from f.proof->>'paymentMethodId' or
      exists(select 1 from jsonb_array_elements(remaining) x where not (authority.remaining_periods @> jsonb_build_array(x))) then
      raise exception 'Buyer continuation card authority does not cover remaining periods'; end if;
  end if;
  -- Lock payment history before the billing row, matching financial handlers.
  select to_jsonb(current_b) into latest_b from public.buyer_mentorship_billing_state_v1 current_b
    where reservation_id=r.id for update;
  if latest_b is distinct from to_jsonb(b) or (public.read_buyer_mentorship_entitlement_v1(f.purchase_id,p_buyer_id)->'financialAccess') is distinct from 'true'::jsonb then raise exception 'Buyer continuation billing changed'; end if;
  return jsonb_build_object('status','held','reservationId',r.id,'invoiceId',a.invoice_id,'afterPaymentNumber',a.payment_number,
    'paymentMethodId',a.payment_method_id,'originalDefaultPaymentMethodId',f.proof->>'paymentMethodId',
    'cardAuthorizationId',card.authorization_quote_id,'remainingPayments',remaining,'billing',to_jsonb(b),'holdOwner',to_jsonb(owner),'prior',prior,'firstProof',f.proof);
end $$;

-- Reuse the existing control trigger's release proof shape, while keeping the
-- two release authorities separate and preserving irreversible debit revocation.
create or replace function public.guard_buyer_mentorship_collection_controls_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if (old.collection_enabled_at is not null and new.collection_enabled_at is distinct from old.collection_enabled_at) or
    (old.debit_revoked_at is not null and new.debit_revoked_at is distinct from old.debit_revoked_at) or
    (old.collection_hold_at is not null and new.collection_hold_at is null and
      (new.collection_enabled_at is null or new.debit_revoked_at is not null or new.financial_hold_at is not null or
        old.collection_enabled_at is not null and not (
          exists(select 1 from public.buyer_mentorship_collection_releases_v1 release where release.reservation_id=old.reservation_id and
            release.held_revision=old.revision and release.held_at=old.collection_hold_at and new.revision=old.revision+1 and release.verified_basis->'billing'=to_jsonb(old)) or
          exists(select 1 from public.buyer_mentorship_same_card_releases_v1 release where release.reservation_id=old.reservation_id and
            release.held_revision=old.revision and release.held_at=old.collection_hold_at and new.revision=old.revision+1 and release.verified_basis->'billing'=to_jsonb(old))))) then
    raise exception 'Buyer collection controls cannot reopen stopped billing'; end if;
  return new;
end $$;

create function public.release_buyer_mentorship_same_card_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_invoice_id text,p_basis jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare basis jsonb; r_id uuid;
  b public.buyer_mentorship_billing_state_v1%rowtype;
  saved public.buyer_mentorship_same_card_releases_v1%rowtype;
begin
  select r.id into r_id from public.buyer_mentorship_installment_reservations_v1 r
    where r.request_id=p_request_id and r.buyer_id=p_buyer_id and r.context=p_context and r.status='reserved';
  if r_id is null then raise exception 'Owned buyer release unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||(select product_id::text from public.buyer_mentorship_installment_reservations_v1 where id=r_id),72913));
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r_id;
  select release.* into saved from public.buyer_mentorship_same_card_releases_v1 release
    join public.buyer_mentorship_payment_admissions_v1 a using(reservation_id,payment_number)
    where release.reservation_id=r_id and a.invoice_id=p_invoice_id;
  if found then
    select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r_id for update;
    if saved.verified_basis is distinct from p_basis or b.collection_hold_at is not null or
      b.debit_revoked_at is not null or b.financial_hold_at is not null or b.revision<>saved.held_revision+1 or
      b.collection_hold_generation<>(saved.verified_basis#>>'{billing,collection_hold_generation}')::bigint+1 then
      raise exception 'Original buyer release cannot reopen later state'; end if;
    return jsonb_build_object('status','collection_resumed','reservationId',r_id,'invoiceId',p_invoice_id);
  end if;
  basis:=public.read_buyer_mentorship_same_card_context_v1(p_request_id,p_buyer_id,p_context,p_invoice_id);
  if basis->>'status' is distinct from 'held' or p_basis is distinct from basis then raise exception 'Buyer continuation verification became stale'; end if;
  r_id:=(basis->>'reservationId')::uuid;
  insert into public.buyer_mentorship_same_card_releases_v1(reservation_id,payment_number,held_at,held_revision,verified_basis)
    values(r_id,(basis->>'afterPaymentNumber')::integer,(basis#>>'{billing,collection_hold_at}')::timestamptz,(basis#>>'{billing,revision}')::bigint,basis);
  update public.buyer_mentorship_billing_state_v1 set collection_hold_at=null,revision=revision+1 where reservation_id=r_id;
  return jsonb_build_object('status','collection_resumed','reservationId',r_id,'invoiceId',p_invoice_id);
end $$;
revoke all on function public.begin_buyer_mentorship_payment_recovery_v1(uuid,uuid,jsonb,text),
  public.read_buyer_mentorship_same_card_context_v1(uuid,uuid,jsonb,text),public.release_buyer_mentorship_same_card_v1(uuid,uuid,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.begin_buyer_mentorship_payment_recovery_v1(uuid,uuid,jsonb,text),
  public.read_buyer_mentorship_same_card_context_v1(uuid,uuid,jsonb,text),public.release_buyer_mentorship_same_card_v1(uuid,uuid,jsonb,text,jsonb) to service_role;
-- Counted original payments can still need a hold release. Keep them eligible
-- for original-only recovery before the next calendar due date. Also revisit
-- a persisted failed worker outcome after an out-of-band release/lost reply;
-- only that original recovery can acknowledge and clear worker attention.
create or replace view public.buyer_mentorship_due_work_v1 with(security_invoker=true) as
select r.id reservation_id,r.request_id,r.buyer_id,r.context,
  coalesce(h.due_at,p.due_at,b.next_payment_at) due_at,coalesce(h.invoice_id,a.invoice_id) invoice_id,
  case when h.invoice_id is not null or a.invoice_id is not null then 'recover'
    when p.payment_number=b.paid_count+1 and p.due_at=b.next_payment_at and p.admitted_at is null and
      p.period_end>extract(epoch from clock_timestamp()) and b.collection_enabled_at is not null and
      b.collection_hold_at is null and b.financial_hold_at is null and b.debit_revoked_at is null
      then 'collect' else 'review' end action
from public.buyer_mentorship_installment_reservations_v1 r
join public.buyer_mentorship_billing_state_v1 b on b.reservation_id=r.id
left join public.buyer_mentorship_worker_v1 w on w.reservation_id=r.id
left join lateral (select a.invoice_id,p.due_at from public.buyer_mentorship_payment_admissions_v1 a
  join public.buyer_mentorship_collection_periods_v1 p using(reservation_id,payment_number)
  where a.reservation_id=r.id and p.payment_number=b.paid_count and p.counted_at is not null and
    ((b.collection_hold_at is not null and b.paid_count<(r.terms->>'paymentCount')::integer) or
      w.last_status in ('review_required','retry_required')) limit 1) h on true
left join lateral (select p.* from public.buyer_mentorship_collection_periods_v1 p
  where p.reservation_id=r.id and p.counted_at is null order by p.payment_number limit 1) p on true
left join public.buyer_mentorship_payment_admissions_v1 a on a.reservation_id=p.reservation_id and a.payment_number=p.payment_number
where r.status='reserved' and (h.invoice_id is not null or a.invoice_id is not null or
  (b.debit_revoked_at is null and b.next_payment_at<=extract(epoch from clock_timestamp())));

commit;
