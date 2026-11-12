-- Prepared locally. No hosted installation or financial activation is implied.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.sales_team_financial_config_v1 (
 singleton boolean primary key default true check(singleton),
 context jsonb,
 processing_fees jsonb,
 payout_cost_estimate_cents integer not null default 0 check(payout_cost_estimate_cents>=0),
 fee_disclosure_version text,
 commission_disclosure_version text,
 actual_pricing_verified boolean not null default false,
 reserves_verified boolean not null default false,
 disclosures_approved boolean not null default false,
 evidence jsonb not null default '{}',
 revision integer not null default 1,
 updated_at timestamptz not null default now()
);
insert into public.sales_team_financial_config_v1(singleton) values(true);

create table public.sales_team_offer_approvals_v1 (
 id uuid primary key,
 creator_id uuid not null references auth.users(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 revision integer not null check(revision>0),
 amount_cents integer not null check(amount_cents between 50 and 99999999),
 installment_counts smallint[] not null default '{}',
 source_snapshot jsonb not null,
 approved_by uuid not null references auth.users(id) on delete restrict,
 approved_at timestamptz not null default now(),
 revoked_at timestamptz,
 unique(product_id,revision),unique(id,creator_id,product_id),
 check(public.valid_mentorship_installment_options_v1(installment_counts))
);
create unique index sales_team_one_current_approval_v1 on public.sales_team_offer_approvals_v1(product_id) where revoked_at is null;

create table public.sales_team_offer_options_v1 (
 id uuid primary key default gen_random_uuid(),
 approval_id uuid not null,
 creator_id uuid not null,
 product_id uuid not null,
 kind text not null check(kind in ('full','installments','monthly')),
 payment_count integer not null check(payment_count between 1 and 24),
 foreign key(approval_id,creator_id,product_id) references public.sales_team_offer_approvals_v1(id,creator_id,product_id) on delete restrict,
 unique(approval_id,kind,payment_count),
 check((kind='installments' and payment_count>=2) or (kind in ('full','monthly') and payment_count=1))
);

create table public.sales_team_sale_requests_v1 (
 id uuid primary key,
 booking_id uuid not null references public.bookings(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 prepared_by uuid not null references auth.users(id) on delete restrict,
 option_id uuid not null references public.sales_team_offer_options_v1(id) on delete restrict,
 source_snapshot jsonb not null,
 terms jsonb not null,
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 status text not null default 'review' check(status in ('review','accepted','superseded','closed_unpaid')),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '48 hours'
);
create unique index sales_team_one_live_sale_v1 on public.sales_team_sale_requests_v1(booking_id) where status in ('review','accepted');

create table public.sales_team_sale_agreements_v1 (
 id uuid primary key references public.sales_team_sale_requests_v1(id) on delete restrict,
 booking_id uuid not null references public.bookings(id) on delete restrict,
 creator_id uuid not null references auth.users(id) on delete restrict,
 buyer_id uuid not null references auth.users(id) on delete restrict,
 membership_id uuid not null references public.sales_team_memberships_v1(id) on delete restrict,
 closer_id uuid not null references auth.users(id) on delete restrict,
 acting_user_id uuid not null references auth.users(id) on delete restrict,
 protocol text not null check(protocol='creatornet-team-distribution-v1'),
 terms jsonb not null,
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 context jsonb not null,
 accepted_at timestamptz not null default now()
);
alter table public.sales_team_assignments_v1 add constraint sales_team_assignment_sale_v1 foreign key(accepted_sale_id)
 references public.sales_team_sale_agreements_v1(id) on delete restrict;

create function public.sales_team_product_snapshot_v1(p_product_id uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
 select jsonb_build_object('id',p.id,'creator_id',p.creator_id,'title',p.title,'description',p.description,'type',p.type,
  'amount_cents',p.amount_cents,'price_cents',p.price_cents,'currency',p.currency,'membership_terms',p.membership_terms,
  'fixed_service_months',p.fixed_service_months,'delivery_revision',p.delivery_revision,'active',p.active,'is_active',p.is_active)
 from public.products p where p.id=p_product_id
$$;

create function public.configure_sales_team_offer_v1(p_creator_id uuid,p_actor_id uuid,p_product_id uuid,p_request_id uuid,p_amount_cents integer,p_counts smallint[])
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_role text;v_product jsonb;v_approval public.sales_team_offer_approvals_v1;v_revision integer;v_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||p_creator_id::text,0));
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled) then raise exception 'TEAM_ACCESS_DISABLED'; end if;
 v_role:=public.sales_team_actor_role_v1(p_creator_id,p_actor_id);
 if coalesce(v_role,'') not in ('owner','manager') then raise exception 'TEAM_MANAGER_REQUIRED'; end if;
 v_product:=public.sales_team_product_snapshot_v1(p_product_id);
 if v_product is null or v_product->>'creator_id' is distinct from p_creator_id::text or v_product->>'type' not in ('video','course','mentorship','bundle','call') or
  v_product->>'currency' is distinct from 'usd' or v_product->'active'='false'::jsonb or v_product->'is_active'='false'::jsonb or
  not exists(select 1 from public.posts p where p.creator_id=p_creator_id and p.allow_booking and p.product_id in
    (select id from public.products where id=p_product_id union select product_id from public.products where id=p_product_id)) then raise exception 'BOOKED_OFFER_REQUIRED'; end if;
 if p_amount_cents is null or p_amount_cents not between 50 and 99999999 or p_counts is null or
  not public.valid_mentorship_installment_options_v1(p_counts) or
  (cardinality(p_counts)>0 and (v_product->'membership_terms'<>'null'::jsonb or p_amount_cents < p_counts[cardinality(p_counts)]::integer*50)) then raise exception 'INVALID_APPROVED_PAYMENT_OPTIONS'; end if;
 select * into v_approval from public.sales_team_offer_approvals_v1 where id=p_request_id;
 if v_approval.id is not null then
  if v_approval.creator_id<>p_creator_id or v_approval.product_id<>p_product_id or v_approval.amount_cents<>p_amount_cents or
   v_approval.installment_counts<>p_counts or v_approval.source_snapshot<>v_product or v_approval.approved_by<>p_actor_id or
   v_approval.revoked_at is not null then raise exception 'OFFER_APPROVAL_REQUEST_CONFLICT'; end if;
 else
  select coalesce(max(revision),0)+1 into v_revision from public.sales_team_offer_approvals_v1 where product_id=p_product_id;
  update public.sales_team_offer_approvals_v1 set revoked_at=clock_timestamp() where product_id=p_product_id and revoked_at is null;
  insert into public.sales_team_offer_approvals_v1(id,creator_id,product_id,revision,amount_cents,installment_counts,source_snapshot,approved_by)
   values(p_request_id,p_creator_id,p_product_id,v_revision,p_amount_cents,p_counts,v_product,p_actor_id) returning * into v_approval;
  insert into public.sales_team_offer_options_v1(approval_id,creator_id,product_id,kind,payment_count)
   values(p_request_id,p_creator_id,p_product_id,case when v_product->'membership_terms'<>'null'::jsonb then 'monthly' else 'full' end,1);
  insert into public.sales_team_offer_options_v1(approval_id,creator_id,product_id,kind,payment_count)
   select p_request_id,p_creator_id,p_product_id,'installments',n from unnest(p_counts)n;
  insert into public.sales_team_audit_v1(creator_id,actor_id,action,subject_id,after_state)
   values(p_creator_id,p_actor_id,'approve_sales_offer',p_request_id,to_jsonb(v_approval));
 end if;
 return jsonb_build_object('approval',to_jsonb(v_approval),'options',(select jsonb_agg(to_jsonb(o)) from public.sales_team_offer_options_v1 o where approval_id=v_approval.id));
end $$;

create function public.read_sales_team_sale_source_v1(p_booking_id uuid,p_actor_id uuid,p_option_id uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_booking public.bookings;v_assignment public.sales_team_assignments_v1;v_member public.sales_team_memberships_v1;
 v_approval public.sales_team_offer_approvals_v1;v_option public.sales_team_offer_options_v1;v_config public.sales_team_financial_config_v1;
 v_creator_recipient public.sales_team_recipients_v1;v_closer_recipient public.sales_team_recipients_v1;v_role text;v_product jsonb;
begin
 if not exists(select 1 from public.sales_team_controls_v1 where singleton and access_enabled and new_sales_enabled) then raise exception 'TEAM_SALES_DISABLED'; end if;
 select * into v_booking from public.bookings where id=p_booking_id;
 if v_booking.id is null or v_booking.status='completed' or v_booking.linked_order_id is not null then raise exception 'BOOKING_UNAVAILABLE'; end if;
 v_role:=public.sales_team_actor_role_v1(v_booking.creator_id,p_actor_id);
 select * into v_assignment from public.sales_team_assignments_v1 where booking_id=p_booking_id;
 select * into v_member from public.sales_team_memberships_v1 where id=v_assignment.membership_id;
 if v_assignment.booking_id is null or v_member.id is null or v_assignment.creator_id<>v_booking.creator_id or
  not public.sales_team_member_ready_v1(v_member.id) or
  (coalesce(v_role,'') not in ('owner','manager') and (v_role is distinct from 'closer' or v_member.user_id<>p_actor_id)) then raise exception 'BOOKING_CLOSER_ACCESS_REQUIRED'; end if;
 select * into v_option from public.sales_team_offer_options_v1 where id=p_option_id and creator_id=v_booking.creator_id;
 select * into v_approval from public.sales_team_offer_approvals_v1 where id=v_option.approval_id and revoked_at is null;
 v_product:=public.sales_team_product_snapshot_v1(v_option.product_id);
 if v_option.id is null or v_approval.id is null or v_product is distinct from v_approval.source_snapshot or
  not exists(select 1 from public.posts p join public.products product on product.id=v_option.product_id
   where p.id=v_booking.post_id and p.creator_id=v_booking.creator_id and p.allow_booking and p.product_id in (product.id,product.product_id)) then raise exception 'APPROVED_OFFER_CHANGED'; end if;
 if exists(select 1 from public.booking_payments where booking_id=p_booking_id) then raise exception 'EXISTING_PAYMENT_REQUIRES_RECOVERY'; end if;
 select * into v_config from public.sales_team_financial_config_v1 where singleton;
 if not v_config.actual_pricing_verified or not v_config.reserves_verified or not v_config.disclosures_approved or
  v_config.context is null or v_config.processing_fees is null or v_config.fee_disclosure_version is null or v_config.commission_disclosure_version is null then raise exception 'TEAM_FINANCIAL_CONFIG_REQUIRED'; end if;
 select * into v_creator_recipient from public.sales_team_recipients_v1 where user_id=v_booking.creator_id;
 select * into v_closer_recipient from public.sales_team_recipients_v1 where user_id=v_member.user_id;
 if v_creator_recipient.user_id is null or not v_creator_recipient.transfers_active or not v_creator_recipient.payouts_ready or not v_creator_recipient.ownership_verified or
  v_creator_recipient.verified_at<=clock_timestamp()-interval '15 minutes' or
  v_creator_recipient.platform_account_id is distinct from v_config.context->>'platformAccountId' or
  v_closer_recipient.platform_account_id is distinct from v_config.context->>'platformAccountId' or
  v_creator_recipient.mode is distinct from v_config.context->>'mode' or v_closer_recipient.mode is distinct from v_config.context->>'mode' or
  v_creator_recipient.account_id=v_closer_recipient.account_id then raise exception 'TEAM_RECIPIENT_VERIFICATION_REQUIRED'; end if;
 return jsonb_build_object('booking',jsonb_build_object('id',v_booking.id,'buyerId',v_booking.buyer_id,'creatorId',v_booking.creator_id,'postId',v_booking.post_id),
 'assignment',jsonb_build_object('membershipId',v_member.id,'closerId',v_member.user_id,'actingUserId',p_actor_id,'revision',v_assignment.revision),
 'commission',jsonb_build_object('commissionBps',v_member.commission_bps,'holdDays',v_member.hold_days,'renewals',v_member.renewal_rule,'revision',v_member.commission_revision),
 'option',jsonb_build_object('id',v_option.id,'approvalId',v_approval.id,'creatorId',v_approval.creator_id,'productId',v_option.product_id,
  'kind',v_option.kind,'paymentCount',v_option.payment_count,'amountCents',v_approval.amount_cents,'revision',v_approval.revision,'sourceSnapshot',v_product),
 'product',v_product,'creatorRecipientId',v_creator_recipient.account_id,'closerRecipientId',v_closer_recipient.account_id,
 'financialConfig',jsonb_build_object('context',v_config.context,'processingFees',v_config.processing_fees,'payoutCostEstimateCents',v_config.payout_cost_estimate_cents,
  'feeDisclosureVersion',v_config.fee_disclosure_version,'commissionDisclosureVersion',v_config.commission_disclosure_version,'revision',v_config.revision));
end $$;

create function public.prepare_sales_team_sale_v1(p_request_id uuid,p_booking_id uuid,p_actor_id uuid,p_option_id uuid,p_source jsonb,p_terms jsonb,p_fingerprint text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_creator uuid;v_source jsonb;v_request public.sales_team_sale_requests_v1;
begin
 select creator_id into v_creator from public.bookings where id=p_booking_id;
 if v_creator is null then raise exception 'BOOKING_UNAVAILABLE'; end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||v_creator::text,0));
 perform 1 from public.bookings where id=p_booking_id for update;
 v_source:=public.read_sales_team_sale_source_v1(p_booking_id,p_actor_id,p_option_id);
 if p_source is distinct from v_source or p_terms->>'protocol' is distinct from 'creatornet-team-distribution-v1' or
  p_terms->>'saleId' is distinct from p_request_id::text or p_terms->>'bookingId' is distinct from p_booking_id::text or
  p_terms->>'buyerId' is distinct from v_source->'booking'->>'buyerId' or p_terms->>'creatorId' is distinct from v_creator::text or
  p_terms->>'closerId' is distinct from v_source->'assignment'->>'closerId' or p_terms->>'membershipId' is distinct from v_source->'assignment'->>'membershipId' or
  p_terms->>'actingUserId' is distinct from p_actor_id::text or p_terms->'amountCents' is distinct from v_source->'option'->'amountCents' or
  p_terms->'optionId' is distinct from v_source->'option'->'id' or p_terms->'assignmentRevision' is distinct from v_source->'assignment'->'revision' or
  p_terms->'commissionRevision' is distinct from v_source->'commission'->'revision' or
  p_terms->'commission'->'commissionBps' is distinct from v_source->'commission'->'commissionBps' or
  p_terms->'commission'->'holdDays' is distinct from v_source->'commission'->'holdDays' or
  p_terms->'commission'->'renewals' is distinct from v_source->'commission'->'renewals' or
  p_terms->'distribution'->'creatorRecipientId' is distinct from v_source->'creatorRecipientId' or
  p_terms->'distribution'->'closerRecipientId' is distinct from v_source->'closerRecipientId' or
  p_terms->'distribution'->'processingFees' is distinct from v_source->'financialConfig'->'processingFees' then raise exception 'SALE_TERMS_CHANGED'; end if;
 select * into v_request from public.sales_team_sale_requests_v1 where id=p_request_id;
 if v_request.id is not null then
  if v_request.booking_id<>p_booking_id or v_request.prepared_by<>p_actor_id or v_request.option_id<>p_option_id or
   v_request.source_snapshot<>p_source or v_request.terms<>p_terms or v_request.fingerprint<>p_fingerprint or
   v_request.status<>'review' then raise exception 'SALE_REQUEST_CONFLICT'; end if;
  return to_jsonb(v_request);
 end if;
 if exists(select 1 from public.sales_team_assignments_v1 where booking_id=p_booking_id and accepted_sale_id is not null) or
  exists(select 1 from public.sales_team_sale_requests_v1 where booking_id=p_booking_id and status='accepted') then raise exception 'EXISTING_PAYMENT_REQUIRES_RECOVERY'; end if;
 -- Review-only requests have no provider operation. Accepted paths cannot be replaced here.
 update public.sales_team_sale_requests_v1 set status='superseded' where booking_id=p_booking_id and status='review';
 insert into public.sales_team_sale_requests_v1(id,booking_id,creator_id,buyer_id,prepared_by,option_id,source_snapshot,terms,fingerprint)
 values(p_request_id,p_booking_id,v_creator,(v_source->'booking'->>'buyerId')::uuid,p_actor_id,p_option_id,p_source,p_terms,p_fingerprint) returning * into v_request;
 insert into public.sales_team_audit_v1(creator_id,actor_id,action,subject_id,after_state) values(v_creator,p_actor_id,'prepare_sale',p_request_id,jsonb_build_object('booking_id',p_booking_id,'option_id',p_option_id,'fingerprint',p_fingerprint));
 return to_jsonb(v_request);
end $$;

create function public.accept_sales_team_sale_v1(p_request_id uuid,p_buyer_id uuid,p_fingerprint text,p_accepted boolean)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_request public.sales_team_sale_requests_v1;v_agreement public.sales_team_sale_agreements_v1;v_source jsonb;v_creator uuid;
begin
 select creator_id into v_creator from public.sales_team_sale_requests_v1 where id=p_request_id and buyer_id=p_buyer_id;
 if v_creator is null or p_accepted is distinct from true then raise exception 'BUYER_ACCEPTANCE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('sales-team:'||v_creator::text,0));
 select * into v_request from public.sales_team_sale_requests_v1 where id=p_request_id and buyer_id=p_buyer_id for update;
 if v_request.fingerprint is distinct from p_fingerprint then raise exception 'REVIEW_CURRENT_SALE_TERMS'; end if;
 select * into v_agreement from public.sales_team_sale_agreements_v1 where id=p_request_id;
 if v_agreement.id is not null then return to_jsonb(v_agreement); end if;
 if v_request.status<>'review' or v_request.expires_at<=clock_timestamp() then raise exception 'REVIEW_CURRENT_SALE_TERMS'; end if;
 v_source:=public.read_sales_team_sale_source_v1(v_request.booking_id,v_request.prepared_by,v_request.option_id);
 if v_source is distinct from v_request.source_snapshot then raise exception 'REVIEW_CURRENT_SALE_TERMS'; end if;
 insert into public.sales_team_sale_agreements_v1(id,booking_id,creator_id,buyer_id,membership_id,closer_id,acting_user_id,protocol,terms,fingerprint,context)
 values(p_request_id,v_request.booking_id,v_creator,p_buyer_id,(v_source->'assignment'->>'membershipId')::uuid,(v_source->'assignment'->>'closerId')::uuid,
  v_request.prepared_by,'creatornet-team-distribution-v1',v_request.terms,v_request.fingerprint,v_source->'financialConfig'->'context') returning * into v_agreement;
 update public.sales_team_assignments_v1 set accepted_sale_id=p_request_id where booking_id=v_request.booking_id and accepted_sale_id is null;
 if not found then raise exception 'SALE_ATTRIBUTION_FROZEN'; end if;
 update public.sales_team_sale_requests_v1 set status='accepted' where id=p_request_id;
 insert into public.sales_team_audit_v1(creator_id,actor_id,action,subject_id,after_state) values(v_creator,p_buyer_id,'accept_sale',p_request_id,jsonb_build_object('fingerprint',p_fingerprint));
 return to_jsonb(v_agreement);
end $$;

do $$ declare v_name text;v_sig regprocedure;begin
 foreach v_name in array array['sales_team_financial_config_v1','sales_team_offer_approvals_v1','sales_team_offer_options_v1','sales_team_sale_requests_v1','sales_team_sale_agreements_v1'] loop
  execute format('alter table public.%I enable row level security',v_name);
  execute format('revoke all on public.%I from public,anon,authenticated',v_name);
  execute format('grant select,insert,update on public.%I to service_role',v_name);
 end loop;
 for v_sig in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
  ('sales_team_product_snapshot_v1','configure_sales_team_offer_v1','read_sales_team_sale_source_v1','prepare_sales_team_sale_v1','accept_sales_team_sale_v1') loop
  execute format('revoke all on function %s from public,anon,authenticated',v_sig);
  execute format('grant execute on function %s to service_role',v_sig);
 end loop;
end $$;
revoke update on public.sales_team_sale_agreements_v1,public.sales_team_offer_options_v1 from service_role;
create trigger sales_team_agreement_immutable_v1 before update or delete on public.sales_team_sale_agreements_v1
 for each row execute function creatornet_team_private.reject_history_change();
create trigger sales_team_option_immutable_v1 before update or delete on public.sales_team_offer_options_v1
 for each row execute function creatornet_team_private.reject_history_change();
commit;
