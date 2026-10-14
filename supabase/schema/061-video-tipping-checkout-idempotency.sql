-- Freeze the complete Stripe create request before any provider call. A repeated
-- request key must use the same Checkout parameters even when
-- the first provider response was lost before the Session ID was bound.
-- A nullable booking flag must not pass the tip-only CHECK via SQL UNKNOWN.
alter table public.posts drop constraint if exists posts_tip_only_check;
alter table public.posts add constraint posts_tip_only_check check (
  not tips_enabled or (
    nullif(btrim(video_url), '') is not null and
    product_id is null and offering_id is null and premium_path is null and
    coalesce(price_cents, 0) = 0 and allow_booking is false and
    booking_url is null and coalesce(cta_type, 'none') = 'none' and
    fulfillment_url is null and display_price is null and booking_url_override is null
  )
);

alter table public.tips
  add column if not exists stripe_checkout_params jsonb;

alter table public.tips
  add constraint tips_checkout_params_object_check
  check (stripe_checkout_params is null or jsonb_typeof(stripe_checkout_params) = 'object');

drop function public.create_or_get_video_tip(
  uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, bigint, bigint,
  boolean, integer, integer, text, text, text
);

create function public.create_or_get_video_tip(
  p_id uuid,
  p_tipper_id uuid,
  p_creator_id uuid,
  p_post_id uuid,
  p_client_request_key uuid,
  p_terms_fingerprint text,
  p_gross_amount_cents bigint,
  p_platform_fee_cents bigint,
  p_processing_fee_cents bigint,
  p_total_creator_deduction_cents bigint,
  p_creator_net_cents bigint,
  p_processing_fee_enabled boolean,
  p_processing_fee_basis_points integer,
  p_processing_fee_fixed_cents integer,
  p_fee_schedule_version text,
  p_currency text,
  p_destination_account_id text,
  p_checkout_params jsonb
)
returns public.tips
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tip public.tips%rowtype;
  v_open_count integer;
begin
  if jsonb_typeof(p_checkout_params) is distinct from 'object' or
     p_checkout_params->>'client_reference_id' is distinct from p_id::text or
     p_checkout_params->>'mode' is distinct from 'payment' or
     p_checkout_params->>'ui_mode' is distinct from 'custom' or
     p_checkout_params #>> '{line_items,0,price_data,unit_amount}' is distinct from p_gross_amount_cents::text or
     p_checkout_params #>> '{line_items,0,price_data,currency}' is distinct from p_currency or
     p_checkout_params #>> '{payment_intent_data,application_fee_amount}' is distinct from p_total_creator_deduction_cents::text or
     p_checkout_params #>> '{payment_intent_data,transfer_data,destination}' is distinct from p_destination_account_id or
     p_checkout_params #>> '{metadata,tip_id}' is distinct from p_id::text or
     p_checkout_params #>> '{metadata,checkout_terms_fingerprint}' is distinct from p_terms_fingerprint or
     nullif(p_checkout_params->>'return_url', '') is null or
     nullif(p_checkout_params->>'expires_at', '') is null then
    raise exception 'invalid frozen tip checkout parameters';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_tipper_id::text), hashtext(p_post_id::text));
  if not exists (
    select 1 from public.tips where tipper_id = p_tipper_id and client_request_key = p_client_request_key
  ) then
    select count(*) into v_open_count from public.tips
    where tipper_id = p_tipper_id and post_id = p_post_id
      and status in ('creating','open','processing');
    if v_open_count >= 3 then
      raise exception 'too many open tip attempts' using errcode = 'CN021';
    end if;
  end if;

  insert into public.tips (
    id, tipper_id, creator_id, post_id, client_request_key, terms_fingerprint,
    gross_amount_cents, platform_fee_cents, processing_fee_cents,
    total_creator_deduction_cents, creator_net_cents, processing_fee_enabled,
    processing_fee_basis_points, processing_fee_fixed_cents, fee_schedule_version,
    currency, status, stripe_destination_account_id, stripe_checkout_params
  ) values (
    p_id, p_tipper_id, p_creator_id, p_post_id, p_client_request_key, p_terms_fingerprint,
    p_gross_amount_cents, p_platform_fee_cents, p_processing_fee_cents,
    p_total_creator_deduction_cents, p_creator_net_cents, p_processing_fee_enabled,
    p_processing_fee_basis_points, p_processing_fee_fixed_cents, p_fee_schedule_version,
    p_currency, 'creating', p_destination_account_id, p_checkout_params
  )
  on conflict (tipper_id, client_request_key) do nothing;

  select * into v_tip from public.tips
  where tipper_id = p_tipper_id and client_request_key = p_client_request_key;
  if not found then raise exception 'tip attempt was not created'; end if;
  return v_tip;
end;
$$;

revoke all on function public.create_or_get_video_tip(
  uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, bigint, bigint,
  boolean, integer, integer, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_or_get_video_tip(
  uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, bigint, bigint, bigint,
  boolean, integer, integer, text, text, text, jsonb
) to service_role;

-- The recovery row serializes dispute-event order. Update the tip's display
-- status in the same transaction so a late older event cannot overwrite "won".
drop function public.record_tip_dispute_recovery(
  text, uuid, text, text, text, bigint, bigint, bigint
);

create function public.record_tip_dispute_recovery(
  p_dispute_id text,
  p_tip_id uuid,
  p_payment_intent_id text,
  p_charge_id text,
  p_transfer_id text,
  p_disputed_amount_cents bigint,
  p_event_created bigint,
  p_reversal_amount_cents bigint,
  p_dispute_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_written boolean;
  v_existing public.tip_dispute_recoveries%rowtype;
begin
  select * into v_existing from public.tip_dispute_recoveries where stripe_dispute_id = p_dispute_id;
  if found and (
    v_existing.tip_id <> p_tip_id or
    v_existing.stripe_payment_intent_id <> p_payment_intent_id or
    v_existing.stripe_charge_id <> p_charge_id or
    v_existing.stripe_transfer_id <> p_transfer_id
  ) then
    raise exception 'tip dispute provider linkage differs';
  end if;
  insert into public.tip_dispute_recoveries (
    stripe_dispute_id, tip_id, stripe_payment_intent_id, stripe_charge_id,
    stripe_transfer_id, disputed_amount_cents, stripe_event_created, reversal_amount_cents
  ) values (
    p_dispute_id, p_tip_id, p_payment_intent_id, p_charge_id,
    p_transfer_id, p_disputed_amount_cents, p_event_created, p_reversal_amount_cents
  )
  on conflict (stripe_dispute_id) do update set
    tip_id = excluded.tip_id,
    stripe_payment_intent_id = excluded.stripe_payment_intent_id,
    stripe_charge_id = excluded.stripe_charge_id,
    stripe_transfer_id = excluded.stripe_transfer_id,
    disputed_amount_cents = greatest(public.tip_dispute_recoveries.disputed_amount_cents, excluded.disputed_amount_cents),
    stripe_event_created = excluded.stripe_event_created,
    updated_at = now()
  where public.tip_dispute_recoveries.stripe_event_created <= excluded.stripe_event_created
    and public.tip_dispute_recoveries.tip_id = excluded.tip_id
    and public.tip_dispute_recoveries.stripe_payment_intent_id = excluded.stripe_payment_intent_id
    and public.tip_dispute_recoveries.stripe_charge_id = excluded.stripe_charge_id
    and public.tip_dispute_recoveries.stripe_transfer_id = excluded.stripe_transfer_id
  returning true into v_written;
  if v_written then
    update public.tips set dispute_status = p_dispute_status, updated_at = now()
      where id = p_tip_id;
  end if;
  return coalesce(v_written, false);
end;
$$;

revoke all on function public.record_tip_dispute_recovery(
  text, uuid, text, text, text, bigint, bigint, bigint, text
) from public, anon, authenticated;
grant execute on function public.record_tip_dispute_recovery(
  text, uuid, text, text, text, bigint, bigint, bigint, text
) to service_role;

-- Provider writes can finish after a newer dispute event moves the audit
-- timestamp forward. Permit that result to bind by stable provider identity;
-- a succeeded result remains monotonic and cannot be replaced by a failure.
create or replace function public.record_tip_dispute_recovery_progress(
  p_dispute_id text,
  p_event_created bigint,
  p_kind text,
  p_status text,
  p_provider_id text,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_written boolean := false;
begin
  if p_kind not in ('reversal','restoration') or p_status not in ('pending','succeeded','failed') then
    raise exception 'invalid tip dispute recovery progress';
  end if;
  if p_status = 'succeeded' and p_kind = 'restoration' and p_provider_id is null then
    raise exception 'tip dispute restoration transfer identity is missing';
  end if;
  if p_status = 'succeeded' and p_kind = 'reversal' and p_provider_id is null and exists (
    select 1 from public.tip_dispute_recoveries where stripe_dispute_id = p_dispute_id
      and reversal_amount_cents > 0
  ) then
    raise exception 'tip dispute reversal identity is missing';
  end if;
  if p_kind = 'reversal' then
    update public.tip_dispute_recoveries set
      reversal_id = case when p_status = 'succeeded' then coalesce(reversal_id, p_provider_id) else reversal_id end,
      reversal_status = case when reversal_status = 'succeeded' then reversal_status else p_status end,
      reversal_error_code = case when reversal_status = 'succeeded' or p_status = 'succeeded' then null else p_error_code end,
      reversal_updated_at = now(), updated_at = now()
    where stripe_dispute_id = p_dispute_id
      and (reversal_id is null or reversal_id = p_provider_id)
    returning true into v_written;
  else
    update public.tip_dispute_recoveries set
      restoration_transfer_id = case when p_status = 'succeeded' then coalesce(restoration_transfer_id, p_provider_id) else restoration_transfer_id end,
      restoration_status = case when restoration_status = 'succeeded' then restoration_status else p_status end,
      restoration_error_code = case when restoration_status = 'succeeded' or p_status = 'succeeded' then null else p_error_code end,
      restoration_updated_at = now(), updated_at = now()
    where stripe_dispute_id = p_dispute_id
      and (restoration_transfer_id is null or restoration_transfer_id = p_provider_id)
    returning true into v_written;
  end if;
  return coalesce(v_written, false);
end;
$$;

revoke all on function public.record_tip_dispute_recovery_progress(
  text, bigint, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_tip_dispute_recovery_progress(
  text, bigint, text, text, text, text
) to service_role;
