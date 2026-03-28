-- Task 8: Database updates (Sprint 5)
-- Run in Supabase SQL Editor (or migrate). Safe to re-run: uses IF NOT EXISTS.
--
-- Profiles: Connect flags (stripe_account_id + stripe_onboarding_complete may already exist from add_stripe_connect.sql)
-- Orders: one row per commercial checkout (source of truth keyed by id = order_id in app metadata)
-- Purchases: link to order + access_granted; buyer_user_id aligns with spec (mirrors buyer_id)

-- ---------------------------------------------------------------------------
-- 1) Profiles — creator / Connect fields
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS charges_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT false;

-- Sprint doc "onboarding_complete": keep in sync with existing flag (one-time backfill)
UPDATE public.profiles
SET onboarding_complete = stripe_onboarding_complete
WHERE onboarding_complete IS DISTINCT FROM stripe_onboarding_complete;

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_account_id
  ON public.profiles (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

COMMENT ON COLUMN public.profiles.charges_enabled IS 'Cached from Stripe Connect account; webhook may set.';
COMMENT ON COLUMN public.profiles.payouts_enabled IS 'Cached from Stripe Connect account; webhook may set.';
COMMENT ON COLUMN public.profiles.onboarding_complete IS 'Mirror of stripe_onboarding_complete for reporting; keep synced in app/webhook.';

-- ---------------------------------------------------------------------------
-- 2) Orders — checkout / payment record
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_user_id UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  creator_id UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
  post_id UUID REFERENCES public.posts (id) ON DELETE SET NULL,
  stripe_payment_id TEXT,
  gross_amount BIGINT NOT NULL DEFAULT 0,
  platform_fee BIGINT NOT NULL DEFAULT 0,
  creator_amount BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  booking_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_status_check CHECK (
    status IN (
      'pending',
      'processing',
      'paid',
      'failed',
      'refunded',
      'canceled'
    )
  )
);

-- If `orders` already existed with an older shape, CREATE TABLE is skipped — add columns FIRST
-- (comments/indexes below require these columns to exist).
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS buyer_user_id UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS post_id UUID REFERENCES public.posts (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stripe_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS gross_amount BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS platform_fee BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS creator_amount BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'usd',
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS booking_id UUID,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON TABLE public.orders IS 'Sprint 5: order per checkout; gross_amount/platform_fee/creator_amount in smallest currency unit (cents).';
COMMENT ON COLUMN public.orders.stripe_payment_id IS 'Primary Stripe id for support lookups (often payment_intent id).';

CREATE INDEX IF NOT EXISTS idx_orders_buyer_user_id ON public.orders (buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_creator_id ON public.orders (creator_id);
CREATE INDEX IF NOT EXISTS idx_orders_post_id ON public.orders (post_id);
CREATE INDEX IF NOT EXISTS idx_orders_checkout_session ON public.orders (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_payment_intent ON public.orders (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- Optional FK to bookings when that table exists (skip if bookings missing — comment and try)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'bookings'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_booking_id_fkey'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_booking_id_fkey
      FOREIGN KEY (booking_id) REFERENCES public.bookings (id) ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "orders_select_buyer_or_creator" ON public.orders;
CREATE POLICY "orders_select_buyer_or_creator"
  ON public.orders
  FOR SELECT
  TO authenticated
  USING (
    buyer_user_id = auth.uid()
    OR creator_id = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- 3) Purchases — spec fields + link to orders
-- ---------------------------------------------------------------------------
ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS buyer_user_id UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_id TEXT,
  ADD COLUMN IF NOT EXISTS access_granted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.orders (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchases_order_id ON public.purchases (order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchases_buyer_user_id ON public.purchases (buyer_user_id)
  WHERE buyer_user_id IS NOT NULL;

COMMENT ON COLUMN public.purchases.buyer_user_id IS 'Sprint spec; sync with buyer_id where both exist.';
COMMENT ON COLUMN public.purchases.access_granted IS 'True when content should be unlocked (set on successful payment).';

-- Backfill buyer_user_id from buyer_id (only safe rows).
-- Duplicates on (buyer_id, product_id) or unique (buyer_user_id, product_id) would error if we updated all rows at once.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'purchases'
      AND column_name = 'buyer_id'
  ) THEN
    UPDATE public.purchases p
    SET buyer_user_id = p.buyer_id
    WHERE p.buyer_user_id IS NULL
      AND p.buyer_id IS NOT NULL
      AND p.id IN (
        SELECT DISTINCT ON (p1.buyer_id, p1.product_id)
          p1.id
        FROM public.purchases p1
        WHERE p1.buyer_user_id IS NULL
          AND p1.buyer_id IS NOT NULL
        ORDER BY
          p1.buyer_id,
          p1.product_id,
          p1.created_at ASC NULLS LAST,
          p1.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.purchases o
        WHERE o.id <> p.id
          AND o.buyer_user_id IS NOT DISTINCT FROM p.buyer_id
          AND o.product_id IS NOT DISTINCT FROM p.product_id
      );
  END IF;
END $$;
