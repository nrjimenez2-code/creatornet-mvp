-- Read-only snapshot from staging nwqfofezfzljhxolkycz, 2026-09-23 UTC.
-- Test fixture only; not a migration or production compatibility claim.
CREATE OR REPLACE FUNCTION public.credit_purchase_earnings(p_purchase_id uuid, p_creator_amount_cents integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_creator_id uuid;
  v_post_id    uuid;
begin
  if p_creator_amount_cents is null or p_creator_amount_cents < 0 then
    raise exception 'credit_purchase_earnings: creator amount must be >= 0 (got %)',
      p_creator_amount_cents;
  end if;

  -- The atomic claim. Postgres serialises concurrent UPDATEs of the same row,
  -- so exactly one caller can observe earnings_credited_at IS NULL and win it.
  -- Refunded/failed purchases are never credited.
  update public.purchases
     set earnings_credited_at    = now(),
         earnings_credited_cents = p_creator_amount_cents
   where id = p_purchase_id
     and earnings_credited_at is null
     and status not in ('refunded', 'failed')
  returning creator_id, post_id
    into v_creator_id, v_post_id;

  if not found then
    return false;  -- already credited, or terminal. Not an error.
  end if;

  -- The claim is held, so these increments cannot double-apply. Doing them in
  -- one statement each also removes the lost-update race the old read-modify-
  -- write helper had.
  if v_creator_id is not null and p_creator_amount_cents > 0 then
    update public.profiles
       set total_earnings_cents = coalesce(total_earnings_cents, 0) + p_creator_amount_cents
     where id = v_creator_id;
  end if;

  if v_post_id is not null then
    update public.posts
       set purchase_count = coalesce(purchase_count, 0) + 1
     where id = v_post_id;
  end if;

  return true;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.reverse_purchase_earnings(p_purchase_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_creator_id uuid;
  v_post_id    uuid;
  v_cents      integer;
begin
  -- Read the credited amount BEFORE clearing it, holding the row so no other
  -- caller can reverse the same purchase concurrently.
  select creator_id, post_id, earnings_credited_cents
    into v_creator_id, v_post_id, v_cents
    from public.purchases
   where id = p_purchase_id
     and earnings_credited_at is not null
   for update;

  if not found then
    return false;  -- never credited, or already reversed. Not an error.
  end if;

  update public.purchases
     set earnings_credited_at    = null,
         earnings_credited_cents = null
   where id = p_purchase_id;

  -- greatest(0, ...) so a bad historical value can never drive a balance negative.
  if v_creator_id is not null and coalesce(v_cents, 0) > 0 then
    update public.profiles
       set total_earnings_cents = greatest(0, coalesce(total_earnings_cents, 0) - v_cents)
     where id = v_creator_id;
  end if;

  if v_post_id is not null then
    update public.posts
       set purchase_count = greatest(0, coalesce(purchase_count, 0) - 1)
     where id = v_post_id;
  end if;

  return true;
end;
$function$
;
