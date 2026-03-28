-- Stripe Connect: Express account id + onboarding flag on profiles.
-- Run in Supabase SQL Editor.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_account_id
  ON public.profiles(stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;
