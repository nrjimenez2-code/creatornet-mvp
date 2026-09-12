-- UNAPPLIED. #3: publish only the verified original Checkout URL. This is link
-- delivery metadata, NOT a payment, purchase, receipt, credit or entitlement.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or current_setting('transaction_isolation')<>'read committed' or
    to_regprocedure('public.resolve_exact_context_event_v2(text,text,uuid)') is null or
    to_regclass('public.exact_context_checkout_publications_v2') is not null then
    raise exception 'Context publication prerequisites or collision'; end if;
end;
$preflight$;
create table public.exact_context_checkout_publications_v2 (
  reservation_id uuid primary key references public.exact_installment_context_reservations_v2(id) on delete restrict,
  session_id text not null unique references public.exact_context_checkout_results_v2(session_id) on delete restrict,
  url text not null check(length(url) between 1 and 8192),
  expires_at bigint not null,
  published_at timestamptz not null default clock_timestamp()
);
alter table public.exact_context_checkout_publications_v2 enable row level security;
revoke all on public.exact_context_checkout_publications_v2 from public,anon,authenticated,service_role;
create trigger immutable before update or delete on public.exact_context_checkout_publications_v2
  for each row execute function public.guard_exact_context_immutable_v2();
create trigger no_truncate before truncate on public.exact_context_checkout_publications_v2
  for each statement execute function public.guard_exact_context_immutable_v2();

create function public.publish_exact_context_checkout_v2(p_reservation_id uuid,p_actor_id uuid,p_context jsonb,p_proof jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare state jsonb; r public.exact_installment_context_reservations_v2%rowtype;
  prior public.exact_context_checkout_publications_v2%rowtype; b public.bookings%rowtype;
  now_seconds bigint:=floor(extract(epoch from clock_timestamp())); reused boolean;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Publication requires READ COMMITTED'; end if;
  state:=public.read_exact_context_checkout_v2(p_reservation_id,p_actor_id,p_context);
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id;
  select * into b from public.bookings where id=r.booking_id for update;
  if not found or b.creator_id is distinct from p_actor_id or b.buyer_id::text is distinct from r.terms->>'buyerId' or
    b.post_id::text is distinct from r.terms->>'postId' or b.status is distinct from 'booked' or
    jsonb_typeof(p_proof) is distinct from 'object' or
    (select count(*) from jsonb_object_keys(p_proof))<>4 or not(p_proof ?& array['sessionId','url','expiresAt','verifiedAt']) or
    jsonb_typeof(p_proof->'sessionId') is distinct from 'string' or jsonb_typeof(p_proof->'url') is distinct from 'string' or
    jsonb_typeof(p_proof->'expiresAt') is distinct from 'number' or jsonb_typeof(p_proof->'verifiedAt') is distinct from 'number' or
    p_proof->>'sessionId' is distinct from state#>>'{binding,session_id}' or state->'binding'='null'::jsonb or
    (p_proof->>'expiresAt')::numeric is distinct from (state#>>'{attempt,request,params,expires_at}')::numeric or
    (p_proof->>'expiresAt')::numeric<>trunc((p_proof->>'expiresAt')::numeric) or
    (p_proof->>'expiresAt')::bigint<=now_seconds+60 or
    (p_proof->>'verifiedAt')::numeric<>trunc((p_proof->>'verifiedAt')::numeric) or
    (p_proof->>'verifiedAt')::bigint not between now_seconds-30 and now_seconds or
    length(p_proof->>'url')>8192 or p_proof->>'url' ~ '[[:space:]]' or
    not(p_proof->>'url' ~ ('^https://checkout[.]stripe[.]com/c/pay/'||(p_proof->>'sessionId')||'([?#].*)?$')) or
    exists(select 1 from public.exact_context_first_receipts_v2 where reservation_id=r.id) or
    exists(select 1 from public.booking_payments where booking_id=b.id) then
    raise exception 'Checkout publication identity, freshness or unpaid state differs'; end if;
  select * into prior from public.exact_context_checkout_publications_v2 where reservation_id=r.id;
  reused:=found;
  if reused then
    if prior.session_id is distinct from p_proof->>'sessionId' or prior.url is distinct from p_proof->>'url' or
      prior.expires_at is distinct from (p_proof->>'expiresAt')::bigint then raise exception 'Published Checkout is immutable'; end if;
  else
    insert into public.exact_context_checkout_publications_v2(reservation_id,session_id,url,expires_at)
      values(r.id,p_proof->>'sessionId',p_proof->>'url',(p_proof->>'expiresAt')::bigint) returning * into prior;
  end if;
  return jsonb_build_object('reservationId',r.id,'sessionId',prior.session_id,'url',prior.url,
    'expiresAt',prior.expires_at,'publishedAt',prior.published_at,'reused',reused);
end;
$$;

-- Creator-authenticated application reads. Never expose URLs to the browser
-- database roles, or manufacture a booking_payments row before first capture.
create function public.read_exact_context_checkout_links_v2(p_actor_id uuid,p_booking_ids uuid[])
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  if p_actor_id is null or p_booking_ids is null or cardinality(p_booking_ids)>100 then
    raise exception 'Invalid creator booking selection'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('reservationId',r.id,'bookingId',b.id,'terms',r.terms,
    'createdAt',r.created_at,'sessionId',p.session_id,'url',case when p.expires_at>extract(epoch from clock_timestamp())+60 then p.url else null end,
    'expiresAt',p.expires_at,'publishedAt',p.published_at))
    from public.exact_installment_context_reservations_v2 r join public.bookings b on b.id=r.booking_id
    left join public.exact_context_checkout_publications_v2 p on p.reservation_id=r.id
    where b.id=any(p_booking_ids) and b.creator_id=p_actor_id and r.terms->>'creatorId'=p_actor_id::text
      and not exists(select 1 from public.booking_payments bp where bp.booking_id=b.id)), '[]'::jsonb);
end;
$$;
revoke all on function public.publish_exact_context_checkout_v2(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.read_exact_context_checkout_links_v2(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.publish_exact_context_checkout_v2(uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.read_exact_context_checkout_links_v2(uuid,uuid[]) to service_role;

-- #3: expose the existing recovery view under the same verified context. Its
-- eligibility check needs the private, transaction-scoped card-setup admission;
-- the admission is removed before return and permits no provider operation.
create function public.read_exact_context_buyer_view_v2(p_reservation_id uuid,p_buyer_id uuid,p_context jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare r public.exact_installment_context_reservations_v2%rowtype; a public.exact_installment_agreements%rowtype;
  v jsonb; invoice_id text;
begin
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'Context view requires READ COMMITTED'; end if;
  select * into r from public.exact_installment_context_reservations_v2 where id=p_reservation_id and terms->>'buyerId'=p_buyer_id::text;
  if not found then raise exception 'Owned buyer context required'; end if;
  perform public.read_exact_customer_operation_v2(r.id,(r.terms->>'creatorId')::uuid,p_context);
  select ag.* into a from public.exact_installment_agreements ag join public.exact_context_accounting_links_v2 link
    on link.agreement_id=ag.id and link.booking_payment_id=ag.booking_payment_id where link.reservation_id=r.id for update of ag;
  if not found or a.first_fulfilled_at is null or a.terms is distinct from r.terms||jsonb_build_object('bookingPaymentId',a.booking_payment_id) then
    raise exception 'Context buyer accounting identity differs'; end if;
  insert into public.exact_context_sql_admissions_v2 values(pg_current_xact_id(),r.id,'card_setup');
  v:=public.read_exact_buyer_recovery(r.id,p_buyer_id);
  delete from public.exact_context_sql_admissions_v2 where transaction_id=pg_current_xact_id() and reservation_id=r.id;
  select stripe_invoice_id into invoice_id from public.exact_installment_invoice_claims
    where agreement_id=r.id and payment_number=(v->>'paymentNumber')::integer;
  return jsonb_build_object('view',v,'agreementStatus',a.status,'invoiceId',invoice_id);
end;
$$;
revoke all on function public.read_exact_context_buyer_view_v2(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.read_exact_context_buyer_view_v2(uuid,uuid,jsonb) to service_role;
commit;
