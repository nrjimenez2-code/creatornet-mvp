-- UNAPPLIED. Locked steps 1/7/8. Existing journal + existing financial ledger.
-- A recorded collection request binds exactly one provider invoice to one
-- agreed service month. Observing a captured result never grants a new debit.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;
do $preflight$
begin
  if current_user<>'postgres' or to_regclass('public.monthly_mentorship_operations_v1') is null or
    to_regprocedure('public.guard_monthly_provider_publication_v1()') is null then
    raise exception 'Monthly collection prerequisites differ'; end if;
end;
$preflight$;
alter table public.monthly_mentorship_operations_v1 add column review_reason text;

create function public.guard_monthly_mentorship_billing_request_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; v_first jsonb; v_params jsonb; v_metadata jsonb;
begin
  if new.kind not in ('activate','collect') then return new; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=new.agreement_id;
  select provider_proof into v_first from public.monthly_mentorship_receipts_v1 where agreement_id=a.id and month_number=1;
  if not coalesce(v_first->>'paymentMethodId' ~ '^pm_[A-Za-z0-9_]+$',false) or a.anchor_at is null then
    raise exception 'Monthly billing requires the captured owned card and anchor'; end if;
  if new.kind='collect' then
    v_params:=jsonb_build_object('payment_method',v_first->>'paymentMethodId','off_session',true,'forgive',false,'paid_out_of_band',false);
    if new.request->'params' is distinct from v_params then raise exception 'Monthly collection request differs from captured-card authority'; end if;
  else
    v_metadata:=jsonb_build_object('creatornet_membership_version','monthly-mentorship-stripe-v1','creatornet_membership_id',a.id::text,
      'creatornet_membership_fingerprint',a.fingerprint,'buyer_id',a.buyer_id::text,'creator_id',a.creator_id::text,
      'product_id',a.product_id::text,'post_id',a.post_id::text,'creator_stripe_account_id',a.terms->>'destinationId',
      'kind','monthly_mentorship','operation_kind','subscription','creatornet_membership_activation','monthly-held-renewals-v1');
    v_params:=jsonb_build_object('trial_end',public.monthly_mentorship_boundary_v1(a.anchor_at,1),
      'cancel_at',case when a.auto_renew then to_jsonb(''::text) else to_jsonb(public.monthly_mentorship_boundary_v1(a.anchor_at,a.minimum_months)) end,
      'proration_behavior','none','default_payment_method',v_first->>'paymentMethodId',
      'pause_collection',jsonb_build_object('behavior','keep_as_draft'),
      'payment_settings',jsonb_build_object('payment_method_types',jsonb_build_array('card'),'save_default_payment_method','off'),
      'metadata',v_metadata);
    if new.request->>'path' is distinct from '/v1/subscriptions/'||a.stripe_subscription_id or
      new.request->'params' is distinct from v_params then raise exception 'Monthly activation differs from owned held schedule'; end if;
  end if;
  return new;
end;
$$;
create trigger guard_monthly_mentorship_billing_request_v1 before insert or update of request,agreement_revision
on public.monthly_mentorship_operations_v1 for each row execute function public.guard_monthly_mentorship_billing_request_v1();

create function public.guard_monthly_mentorship_collection_receipt_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype; o public.monthly_mentorship_operations_v1%rowtype; v_first jsonb; v_invoice text;
begin
  if new.month_number=1 then return new; end if;
  select * into a from public.monthly_mentorship_agreements_v1 where id=new.agreement_id;
  select provider_proof into v_first from public.monthly_mentorship_receipts_v1 where agreement_id=a.id and month_number=1;
  v_invoice:=new.provider_proof->>'invoiceId';
  select * into o from public.monthly_mentorship_operations_v1 where agreement_id=a.id and kind='collect'
    and scope_key=new.month_number::text for update;
  if not found or o.request->>'path' is distinct from '/v1/invoices/'||v_invoice||'/pay' or
    (o.status='complete' and o.provider_id is distinct from v_invoice) or
    new.provider_proof->>'paymentMethodId' is distinct from v_first->>'paymentMethodId' or
    not coalesce(new.provider_proof->>'collectionRequestId' ~ '^req_[A-Za-z0-9]+$',false) or
    (new.provider_proof->>'providerPeriodStart')::bigint is distinct from
      public.monthly_mentorship_boundary_v1(public.monthly_mentorship_boundary_v1(a.anchor_at,1),new.month_number-2) or
    (new.provider_proof->>'providerPeriodEnd')::bigint is distinct from
      public.monthly_mentorship_boundary_v1(public.monthly_mentorship_boundary_v1(a.anchor_at,1),new.month_number-1) then
    raise exception 'Monthly renewal receipt lacks its owned collection admission'; end if;
  -- A delayed captured result may finish an old/review operation. This is
  -- observation only; no expired idempotency key is reused and no debit sent.
  if o.status<>'complete' then
    update public.monthly_mentorship_operations_v1 set status='complete',provider_id=v_invoice,
      provider_request_id=new.provider_proof->>'collectionRequestId',completed_at=clock_timestamp() where id=o.id;
  end if;
  return new;
end;
$$;
create trigger guard_monthly_mentorship_collection_receipt_v1 before insert on public.monthly_mentorship_receipts_v1
for each row execute function public.guard_monthly_mentorship_collection_receipt_v1();

create function public.review_monthly_mentorship_collection_v1(p_id uuid,p_month integer,p_context jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog as $$
declare a public.monthly_mentorship_agreements_v1%rowtype;
begin
  select * into a from public.monthly_mentorship_agreements_v1 where id=p_id for update;
  if not found or p_context is distinct from a.terms->'paymentContext' or p_month<2 then raise exception 'Monthly review identity differs'; end if;
  update public.monthly_mentorship_operations_v1 set status='review_required',review_reason='payment_requires_review'
    where agreement_id=p_id and kind='collect' and scope_key=p_month::text and status='dispatched';
  return found;
end;
$$;
revoke all on function public.guard_monthly_mentorship_billing_request_v1(),public.guard_monthly_mentorship_collection_receipt_v1(),
  public.review_monthly_mentorship_collection_v1(uuid,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.review_monthly_mentorship_collection_v1(uuid,integer,jsonb) to service_role;
commit;
