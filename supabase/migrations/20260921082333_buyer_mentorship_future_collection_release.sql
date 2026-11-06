begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create table public.buyer_mentorship_collection_releases_v1 (
  quote_id uuid primary key references public.buyer_mentorship_future_card_authorizations_v1(quote_id),
  reservation_id uuid not null references public.buyer_mentorship_billing_state_v1(reservation_id),
  held_revision bigint not null,
  held_at timestamptz not null,
  verified_basis jsonb not null,
  released_at timestamptz not null default clock_timestamp(),
  unique(reservation_id,held_revision)
);
alter table public.buyer_mentorship_collection_releases_v1 enable row level security;
revoke all on public.buyer_mentorship_collection_releases_v1 from public,anon,authenticated,service_role;
grant select,insert on public.buyer_mentorship_collection_releases_v1 to service_role;

-- Preserve one-time initial activation and irreversible debit revocation. A
-- later hold can clear only with the exact persisted release revision/timestamp.
create or replace function public.guard_buyer_mentorship_collection_controls_v1() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if (old.collection_enabled_at is not null and new.collection_enabled_at is distinct from old.collection_enabled_at) or
    (old.debit_revoked_at is not null and new.debit_revoked_at is distinct from old.debit_revoked_at) or
    (old.collection_hold_at is not null and new.collection_hold_at is null and
      (new.collection_enabled_at is null or new.debit_revoked_at is not null or new.financial_hold_at is not null or
        old.collection_enabled_at is not null and not exists(
          select 1 from public.buyer_mentorship_collection_releases_v1 release
          where release.reservation_id=old.reservation_id and release.held_revision=old.revision and release.held_at=old.collection_hold_at
            and new.revision=old.revision+1 and release.verified_basis->'billing'=to_jsonb(old)))) then
    raise exception 'Buyer collection controls cannot reopen stopped billing'; end if;
  return new;
end $$;

-- Runtime must freshly verify held provider subscription, card and captured
-- history. SQL rechecks the original receipt-backed context under the stop lock.
create function public.release_buyer_mentorship_future_collection_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_quote_id uuid,p_basis jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype;
  b public.buyer_mentorship_billing_state_v1%rowtype; a public.buyer_mentorship_future_card_authorizations_v1%rowtype;
  release public.buyer_mentorship_collection_releases_v1%rowtype; basis jsonb;
begin
  select * into r from public.buyer_mentorship_installment_reservations_v1 where request_id=p_request_id and buyer_id=p_buyer_id and context=p_context and status='reserved';
  if not found then raise exception 'Owned buyer collection release unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_buyer_id::text||':'||r.product_id::text,72913));
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id for update;
  select * into release from public.buyer_mentorship_collection_releases_v1 where quote_id=p_quote_id;
  if found then
    if release.reservation_id is distinct from r.id or release.verified_basis is distinct from p_basis or
      b.collection_hold_at is not null or b.debit_revoked_at is not null or b.financial_hold_at is not null or
      b.revision is distinct from release.held_revision+1 then raise exception 'Original buyer release cannot reopen later state'; end if;
    return jsonb_build_object('status','collection_resumed','reservationId',r.id,'quoteId',p_quote_id);
  end if;
  basis:=public.read_buyer_mentorship_future_card_context_v1(p_request_id,p_buyer_id,p_context,p_quote_id);
  select * into a from public.buyer_mentorship_future_card_authorizations_v1 where quote_id=p_quote_id and reservation_id=r.id;
  if p_basis is distinct from basis or a.verified_basis is distinct from basis or b.collection_enabled_at is null or
    b.next_payment_at is distinct from (basis#>>'{remainingPayments,0,dueAt}')::bigint then
    raise exception 'Buyer collection release requires original verified authorization'; end if;
  insert into public.buyer_mentorship_collection_releases_v1(quote_id,reservation_id,held_revision,held_at,verified_basis)
    values(p_quote_id,r.id,b.revision,b.collection_hold_at,basis);
  update public.buyer_mentorship_billing_state_v1 set collection_hold_at=null,revision=revision+1 where reservation_id=r.id;
  return jsonb_build_object('status','collection_resumed','reservationId',r.id,'quoteId',p_quote_id);
end $$;
revoke all on function public.release_buyer_mentorship_future_collection_v1(uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.release_buyer_mentorship_future_collection_v1(uuid,uuid,jsonb,uuid,jsonb) to service_role;
-- Replayed paid receipts must not re-hold already resumed collection.
create or replace function public.begin_buyer_mentorship_payment_recovery_v1(p_request_id uuid,p_buyer_id uuid,p_context jsonb,p_invoice_id text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare r public.buyer_mentorship_installment_reservations_v1%rowtype; a public.buyer_mentorship_payment_admissions_v1%rowtype;
  p public.buyer_mentorship_collection_periods_v1%rowtype; b public.buyer_mentorship_billing_state_v1%rowtype;
  recovery public.buyer_mentorship_payment_recoveries_v1%rowtype;
begin
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
    where reservation_id=r.id and collection_hold_at is null and p.counted_at is null;
  select * into b from public.buyer_mentorship_billing_state_v1 where reservation_id=r.id;
  if not found then raise exception 'Buyer recovery billing state unavailable'; end if;
  return jsonb_build_object('reservationId',r.id,'paymentIntentId',a.payment_intent_id,'paymentNumber',a.payment_number,
    'revision',b.revision,'recoveryRevision',recovery.revision,'paidCount',b.paid_count,'countedAt',p.counted_at);
end $$;
revoke all on function public.begin_buyer_mentorship_payment_recovery_v1(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.begin_buyer_mentorship_payment_recovery_v1(uuid,uuid,jsonb,text) to service_role;

commit;
