-- Create reviews table for storing user reviews with ratings and comments
CREATE TABLE IF NOT EXISTS public.reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT NOT NULL CHECK (char_length(comment) >= 10 AND char_length(comment) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(reviewer_id, creator_id) -- One review per user per creator
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_reviews_creator_id ON public.reviews(creator_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_id ON public.reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON public.reviews(created_at DESC);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_reviews_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_reviews_updated_at ON public.reviews;
CREATE TRIGGER update_reviews_updated_at
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.update_reviews_updated_at();

-- Function to calculate and update profile rating (backend calculation)
-- SECURITY DEFINER allows this function to update profiles table even with anon key
CREATE OR REPLACE FUNCTION public.update_profile_rating(p_profile_id UUID)
RETURNS TABLE(avg_rating NUMERIC, review_count BIGINT) 
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.profiles
  SET
    review_rating = (
      SELECT COALESCE(AVG(rating), 0)
      FROM public.reviews
      WHERE creator_id = p_profile_id
    ),
    review_count = (
      SELECT COUNT(*)
      FROM public.reviews
      WHERE creator_id = p_profile_id
    )
  WHERE id = p_profile_id;
  
  RETURN QUERY
  SELECT
    COALESCE(AVG(rating), 0)::NUMERIC(3, 2) as avg_rating,
    COUNT(*)::BIGINT as review_count
  FROM public.reviews
  WHERE creator_id = p_profile_id;
END;
$$ LANGUAGE plpgsql;

-- Function to get profile rating (reads from profiles table)
-- Drop existing function first if it exists with different signature
DROP FUNCTION IF EXISTS public.get_profile_rating(UUID);

CREATE FUNCTION public.get_profile_rating(p_profile_id UUID)
RETURNS TABLE(avg_rating NUMERIC, review_count BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(p.review_rating, 0)::NUMERIC(3, 2) as avg_rating,
    COALESCE(p.review_count, 0)::BIGINT as review_count
  FROM public.profiles p
  WHERE p.id = p_profile_id;
END;
$$ LANGUAGE plpgsql;

-- Ensure profiles table has review_rating and review_count columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'profiles' 
    AND column_name = 'review_rating'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN review_rating NUMERIC(3, 2) DEFAULT 0;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'profiles' 
    AND column_name = 'review_count'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN review_count INTEGER DEFAULT 0;
  END IF;
END $$;

-- RLS Policies
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Anyone can read reviews" ON public.reviews;
DROP POLICY IF EXISTS "Users can insert their own reviews" ON public.reviews;
DROP POLICY IF EXISTS "Users can update their own reviews" ON public.reviews;
DROP POLICY IF EXISTS "Users can delete their own reviews" ON public.reviews;

-- Anyone can read reviews
CREATE POLICY "Anyone can read reviews"
  ON public.reviews FOR SELECT
  USING (true);

-- Users can insert their own reviews
CREATE POLICY "Users can insert their own reviews"
  ON public.reviews FOR INSERT
  WITH CHECK (auth.uid() = reviewer_id);

-- Users can update their own reviews
CREATE POLICY "Users can update their own reviews"
  ON public.reviews FOR UPDATE
  USING (auth.uid() = reviewer_id)
  WITH CHECK (auth.uid() = reviewer_id);

-- Users can delete their own reviews
CREATE POLICY "Users can delete their own reviews"
  ON public.reviews FOR DELETE
  USING (auth.uid() = reviewer_id);
