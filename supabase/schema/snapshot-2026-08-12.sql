-- CreatorNet — public schema snapshot
-- Captured 2026-08-12 from the live database's catalog, read-only.
-- Reference and diff base. NOT a restore script — see README.md for what is missing
-- (custom types, function bodies, triggers, grants, data).
--
-- 27 tables. RLS state is recorded at the end of each block exactly as it is today.

-- =========================================================
CREATE TABLE public._patch_export (
  rn bigint,
  ord integer,
  ddl text
);
ALTER TABLE public._patch_export DISABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.booking_clicks (
  id uuid NOT NULL,
  post_id uuid,
  viewer_id uuid,
  closer_id uuid,
  creator_id uuid NOT NULL,
  ts timestamp with time zone,
  status text NOT NULL
);
ALTER TABLE public.booking_clicks ADD CONSTRAINT booking_clicks_closer_id_fkey FOREIGN KEY (closer_id) REFERENCES closers(id) ON DELETE SET NULL;
ALTER TABLE public.booking_clicks ADD CONSTRAINT booking_clicks_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE public.booking_clicks ADD CONSTRAINT booking_clicks_viewer_id_fkey FOREIGN KEY (viewer_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.booking_clicks ADD CONSTRAINT booking_clicks_pkey PRIMARY KEY (id);
CREATE INDEX booking_clicks_creator_ts ON public.booking_clicks USING btree (creator_id, ts DESC);
ALTER TABLE public.booking_clicks ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.booking_payments (
  id uuid NOT NULL,
  booking_id uuid NOT NULL,
  product_id uuid NOT NULL,
  closer_user_id uuid NOT NULL,
  buyer_id uuid,
  plan_type booking_payment_plan NOT NULL,   -- custom enum, not defined in this file
  installment_months integer,
  stripe_checkout_session_id text,
  stripe_price_id text,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  link_url text,
  status booking_payment_status NOT NULL,    -- custom enum, not defined in this file
  amount_total_cents bigint,
  installment_amount_cents bigint,
  platform_fee_cents bigint,
  currency character(3) NOT NULL,
  notes jsonb,
  completed_at timestamp with time zone,
  link_sent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL
);
ALTER TABLE public.booking_payments ADD CONSTRAINT booking_payments_installment_months_check CHECK (((installment_months IS NULL) OR (installment_months > 0)));
ALTER TABLE public.booking_payments ADD CONSTRAINT booking_payments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE public.booking_payments ADD CONSTRAINT booking_payments_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.booking_payments ADD CONSTRAINT booking_payments_closer_user_id_fkey FOREIGN KEY (closer_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
ALTER TABLE public.booking_payments ADD CONSTRAINT booking_payments_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE public.booking_payments ADD CONSTRAINT booking_payments_pkey PRIMARY KEY (id);
ALTER TABLE public.booking_payments ADD CONSTRAINT booking_payments_stripe_checkout_session_id_key UNIQUE (stripe_checkout_session_id);
CREATE INDEX idx_booking_payments_booking_id ON public.booking_payments USING btree (booking_id);
CREATE INDEX idx_booking_payments_closer_user ON public.booking_payments USING btree (closer_user_id);
CREATE INDEX idx_booking_payments_status ON public.booking_payments USING btree (status);
ALTER TABLE public.booking_payments DISABLE ROW LEVEL SECURITY;   -- ⚠️ open to the public key

-- =========================================================
CREATE TABLE public.booking_targets (
  id uuid NOT NULL,
  creator_id uuid NOT NULL,
  name text NOT NULL,
  booking_url text NOT NULL,
  weight integer NOT NULL,
  is_active boolean NOT NULL,
  uses_count integer NOT NULL,
  last_used_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL,
  active boolean
);
ALTER TABLE public.booking_targets ADD CONSTRAINT booking_targets_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.booking_targets ADD CONSTRAINT booking_targets_pkey PRIMARY KEY (id);
ALTER TABLE public.booking_targets ADD CONSTRAINT booking_targets_creator_url_key UNIQUE (creator_id, booking_url);
CREATE INDEX idx_booking_targets_creator_active ON public.booking_targets USING btree (creator_id, is_active);
ALTER TABLE public.booking_targets ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.bookings (
  id uuid NOT NULL,
  post_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  status text NOT NULL,
  linked_order_id uuid,
  created_at timestamp with time zone NOT NULL
);
ALTER TABLE public.bookings ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);
CREATE INDEX bookings_buyer_created_at_idx ON public.bookings USING btree (buyer_id, created_at DESC);
CREATE INDEX bookings_creator_created_at_idx ON public.bookings USING btree (creator_id, created_at DESC);
CREATE INDEX bookings_linked_order_id_idx ON public.bookings USING btree (linked_order_id);
CREATE INDEX bookings_linked_order_idx ON public.bookings USING btree (linked_order_id);  -- duplicate of the above
CREATE INDEX bookings_post_idx ON public.bookings USING btree (post_id);
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
-- NOTE: bookings has only INSERT and SELECT policies. No UPDATE, no DELETE.
-- Only the service role can change a booking's status.

-- =========================================================
CREATE TABLE public.clicks (
  id uuid NOT NULL,
  post_id uuid NOT NULL,
  target text NOT NULL,
  session_id text NOT NULL,
  created_at timestamp with time zone NOT NULL
);
ALTER TABLE public.clicks ADD CONSTRAINT clicks_target_check CHECK ((target = ANY (ARRAY['checkout'::text, 'booking'::text, 'external'::text])));
ALTER TABLE public.clicks ADD CONSTRAINT clicks_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.clicks ADD CONSTRAINT clicks_pkey PRIMARY KEY (id);
CREATE INDEX idx_clicks_post_created_at ON public.clicks USING btree (post_id, created_at);
CREATE INDEX idx_clicks_post_target_created_at ON public.clicks USING btree (post_id, target, created_at);
ALTER TABLE public.clicks ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.closers (
  id uuid NOT NULL,
  creator_id uuid NOT NULL,
  name text NOT NULL,
  booking_url text NOT NULL,
  active boolean NOT NULL,
  weight integer NOT NULL,
  created_at timestamp with time zone
);
ALTER TABLE public.closers ADD CONSTRAINT closers_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.closers ADD CONSTRAINT closers_pkey PRIMARY KEY (id);
CREATE INDEX closers_creator_idx ON public.closers USING btree (creator_id) WHERE (active = true);
ALTER TABLE public.closers ENABLE ROW LEVEL SECURITY;   -- carries 11 overlapping policies

-- =========================================================
CREATE TABLE public.comments (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  post_id uuid NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone
);
ALTER TABLE public.comments ADD CONSTRAINT comments_content_check CHECK ((length(content) <= 500));
ALTER TABLE public.comments ADD CONSTRAINT comments_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.comments ADD CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.comments ADD CONSTRAINT comments_pkey PRIMARY KEY (id);
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.follows (
  follower_id uuid NOT NULL,
  following_id uuid NOT NULL,
  created_at timestamp with time zone,
  followed_at timestamp with time zone
);
ALTER TABLE public.follows ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.follows ADD CONSTRAINT follows_following_id_fkey FOREIGN KEY (following_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.follows ADD CONSTRAINT follows_pkey PRIMARY KEY (follower_id, following_id);
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.likes (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  post_id uuid NOT NULL,
  created_at timestamp with time zone
);
ALTER TABLE public.likes ADD CONSTRAINT likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.likes ADD CONSTRAINT likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.likes ADD CONSTRAINT likes_pkey PRIMARY KEY (id);
ALTER TABLE public.likes ADD CONSTRAINT likes_user_id_post_id_key UNIQUE (user_id, post_id);
ALTER TABLE public.likes ENABLE ROW LEVEL SECURITY;
-- NOTE: coexists with post_likes below. Two generations of the same feature.

-- =========================================================
CREATE TABLE public.offerings (
  id uuid NOT NULL,
  creator_id uuid NOT NULL,
  title text NOT NULL,
  price_cents integer NOT NULL,
  currency text NOT NULL,
  type text NOT NULL,
  product_metadata jsonb,
  is_active boolean NOT NULL,
  created_at timestamp with time zone
);
ALTER TABLE public.offerings ADD CONSTRAINT offerings_price_cents_check CHECK ((price_cents >= 0));
ALTER TABLE public.offerings ADD CONSTRAINT offerings_type_check CHECK ((type = ANY (ARRAY['course'::text, 'mentorship'::text, 'call'::text, 'bundle'::text])));
ALTER TABLE public.offerings ADD CONSTRAINT offerings_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES auth.users(id);
ALTER TABLE public.offerings ADD CONSTRAINT offerings_pkey PRIMARY KEY (id);
ALTER TABLE public.offerings ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.orders (
  id uuid NOT NULL,
  buyer_id uuid,
  offering_id uuid,
  status text NOT NULL,
  stripe_session_id text,
  amount_cents integer NOT NULL,
  currency text NOT NULL,
  created_at timestamp with time zone,
  post_id uuid,
  creator_id uuid,
  booking_id uuid,
  buyer_user_id uuid,
  stripe_payment_id text,
  gross_amount bigint NOT NULL,
  platform_fee bigint NOT NULL,
  creator_amount bigint NOT NULL,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  updated_at timestamp with time zone NOT NULL
);
-- Table comment: 'Sprint 5: order per checkout; gross_amount/platform_fee/creator_amount
-- in smallest currency unit (cents).'
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['created'::text, 'paid'::text, 'refunded'::text, 'canceled'::text])));
ALTER TABLE public.orders ADD CONSTRAINT orders_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD CONSTRAINT orders_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES auth.users(id);
ALTER TABLE public.orders ADD CONSTRAINT orders_buyer_user_id_fkey FOREIGN KEY (buyer_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD CONSTRAINT orders_offering_id_fkey FOREIGN KEY (offering_id) REFERENCES offerings(id);
ALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
CREATE INDEX idx_orders_buyer_user_id ON public.orders USING btree (buyer_user_id);
CREATE INDEX idx_orders_checkout_session ON public.orders USING btree (stripe_checkout_session_id) WHERE (stripe_checkout_session_id IS NOT NULL);
CREATE INDEX idx_orders_creator_id ON public.orders USING btree (creator_id);
CREATE INDEX idx_orders_payment_intent ON public.orders USING btree (stripe_payment_intent_id) WHERE (stripe_payment_intent_id IS NOT NULL);
CREATE INDEX idx_orders_post_id ON public.orders USING btree (post_id);
CREATE INDEX orders_buyer_created_at_idx ON public.orders USING btree (buyer_id, created_at DESC);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
-- NOTE: buyer_id and buyer_user_id both exist and both FK to auth.users.

-- =========================================================
CREATE TABLE public.post_engagements (
  id bigint NOT NULL,
  post_id uuid NOT NULL,
  user_id uuid,
  watch_time_ms integer,
  liked boolean,
  commented boolean,
  created_at timestamp with time zone
);
ALTER TABLE public.post_engagements ADD CONSTRAINT post_engagements_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.post_engagements ADD CONSTRAINT post_engagements_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id);
ALTER TABLE public.post_engagements ADD CONSTRAINT post_engagements_pkey PRIMARY KEY (id);
CREATE INDEX idx_engagements_post_time ON public.post_engagements USING btree (post_id, created_at DESC);
ALTER TABLE public.post_engagements DISABLE ROW LEVEL SECURITY;   -- ⚠️ open to the public key

-- =========================================================
CREATE TABLE public.post_events (
  id bigint NOT NULL,
  post_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  user_id uuid,
  kind text NOT NULL,
  watch_seconds numeric,
  occurred_at timestamp with time zone NOT NULL
);
-- Table comment: 'Append-only event log for per-post engagement. Used by creator_kpis /
-- creator_views_timeseries for accurate windowed analytics.'
ALTER TABLE public.post_events ADD CONSTRAINT post_events_kind_check CHECK ((kind = ANY (ARRAY['impression'::text, 'view'::text, 'completion'::text, 'profile_click'::text, 'buy_click'::text, 'checkout_start'::text, 'hashtag_click'::text])));
ALTER TABLE public.post_events ADD CONSTRAINT post_events_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.post_events ADD CONSTRAINT post_events_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.post_events ADD CONSTRAINT post_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.post_events ADD CONSTRAINT post_events_pkey PRIMARY KEY (id);
CREATE INDEX idx_post_events_creator_occurred ON public.post_events USING btree (creator_id, occurred_at DESC);
CREATE INDEX idx_post_events_kind_occurred ON public.post_events USING btree (kind, occurred_at DESC);
CREATE INDEX idx_post_events_post_kind_occurred ON public.post_events USING btree (post_id, kind, occurred_at DESC);
ALTER TABLE public.post_events ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.post_likes (
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamp with time zone
);
ALTER TABLE public.post_likes ADD CONSTRAINT post_likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.post_likes ADD CONSTRAINT post_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.post_likes ADD CONSTRAINT post_likes_pkey PRIMARY KEY (post_id, user_id);
ALTER TABLE public.post_likes ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.post_metrics (
  post_id uuid NOT NULL,
  impressions integer NOT NULL,
  views integer NOT NULL,
  total_watch_seconds numeric NOT NULL,
  avg_watch_time_seconds numeric,
  completions integer NOT NULL,
  completion_rate numeric,
  profile_clicks integer NOT NULL,
  buy_clicks integer NOT NULL,
  checkout_starts integer NOT NULL,
  purchases integer NOT NULL,
  conversion_rate numeric,
  post_conversion_score numeric NOT NULL,
  updated_at timestamp with time zone
);
ALTER TABLE public.post_metrics ADD CONSTRAINT post_metrics_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.post_metrics ADD CONSTRAINT post_metrics_pkey PRIMARY KEY (post_id);
ALTER TABLE public.post_metrics ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.post_views (
  post_id uuid,
  user_id uuid,
  created_at timestamp with time zone
);
ALTER TABLE public.post_views ADD CONSTRAINT post_views_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
CREATE INDEX idx_post_views_post_created_at ON public.post_views USING btree (post_id, created_at);
ALTER TABLE public.post_views ENABLE ROW LEVEL SECURITY;
-- NOTE: no primary key, and its only policy is INSERT. Nothing but the service role reads it.

-- =========================================================
CREATE TABLE public.posts (
  id uuid NOT NULL,
  user_id uuid,
  content text,
  interests text[],
  created_at timestamp with time zone,
  type text,
  video_url text,
  poster_url text,
  duration_seconds integer,
  width integer,
  height integer,
  topics text[],
  views integer,
  likes integer,
  creator_id uuid,
  caption text,
  tags text[],
  likes_count integer NOT NULL,
  comments_count integer NOT NULL,
  shares_count integer NOT NULL,
  offering_id uuid,
  price_cents integer,
  title text,
  product_type text,
  fulfillment_url text,
  product_id uuid,
  premium_path text,
  allow_booking boolean NOT NULL,
  booking_url text,
  hashtags text[],
  active boolean NOT NULL,
  cta_type text,
  display_price text,
  booking_url_override text,
  purchase_count integer NOT NULL
);
ALTER TABLE public.posts ADD CONSTRAINT posts_cta_type_check CHECK ((cta_type = ANY (ARRAY['none'::text, 'stripe'::text, 'closer'::text])));
ALTER TABLE public.posts ADD CONSTRAINT posts_product_type_check CHECK ((product_type = ANY (ARRAY['paid_video'::text, 'course'::text, 'mentorship'::text])));
ALTER TABLE public.posts ADD CONSTRAINT posts_type_check CHECK ((type = ANY (ARRAY['text'::text, 'video'::text])));
ALTER TABLE public.posts ADD CONSTRAINT posts_offering_id_fkey FOREIGN KEY (offering_id) REFERENCES offerings(id);
ALTER TABLE public.posts ADD CONSTRAINT posts_product_fk FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE public.posts ADD CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.posts ADD CONSTRAINT posts_pkey PRIMARY KEY (id);
CREATE INDEX idx_posts_active_created ON public.posts USING btree (active, created_at DESC);
CREATE INDEX idx_posts_hashtags_gin ON public.posts USING gin (hashtags);
CREATE INDEX posts_hashtags_gin ON public.posts USING gin (hashtags);        -- duplicate of the above
CREATE INDEX posts_allow_booking_idx ON public.posts USING btree (allow_booking);
CREATE INDEX posts_creator_created_idx ON public.posts USING btree (creator_id, created_at);
CREATE INDEX posts_cta_type_idx ON public.posts USING btree (cta_type);
CREATE INDEX posts_offering_id_idx ON public.posts USING btree (offering_id);
CREATE INDEX posts_product_id_idx ON public.posts USING btree (product_id);
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
-- NOTE: carries 18 policies, 11 of which are SELECT and nearly all resolve to `true`.
-- Also has both `likes` and `likes_count`, and both `user_id` and `creator_id`.

-- =========================================================
CREATE TABLE public.products (
  id uuid NOT NULL,
  creator_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  type text NOT NULL,
  price_cents integer NOT NULL,
  external_url text,
  thumbnail_url text,
  is_active boolean NOT NULL,
  created_at timestamp with time zone NOT NULL,
  active boolean,
  updated_at timestamp with time zone,
  plan_months integer,
  stripe_price_id text,
  fulfillment fulfillment_type,              -- custom enum, not defined in this file
  discord_channel_id text,
  whop_listing_id text,
  deliver_url text,
  discord_invite_url text,
  whop_listing_url text,
  amount_cents integer NOT NULL,
  currency text NOT NULL,
  post_id uuid,
  product_type text,
  premium_video_url text,
  product_id uuid
);
ALTER TABLE public.products ADD CONSTRAINT products_amount_cents_min CHECK ((amount_cents >= 50));
ALTER TABLE public.products ADD CONSTRAINT products_amount_cents_min_check CHECK (((amount_cents IS NULL) OR (amount_cents >= 50)));
ALTER TABLE public.products ADD CONSTRAINT products_external_url_required CHECK (((type <> 'external'::text) OR ((external_url IS NOT NULL) AND (external_url <> ''::text))));
ALTER TABLE public.products ADD CONSTRAINT products_price_cents_check CHECK ((price_cents > 0));
ALTER TABLE public.products ADD CONSTRAINT products_type_check CHECK ((type = ANY (ARRAY['video'::text, 'course'::text, 'mentorship'::text])));
ALTER TABLE public.products ADD CONSTRAINT products_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.products ADD CONSTRAINT products_pkey PRIMARY KEY (id);
ALTER TABLE public.products ADD CONSTRAINT products_product_id_key UNIQUE (product_id);
CREATE INDEX products_active_idx ON public.products USING btree (is_active);
CREATE INDEX products_creator_id_idx ON public.products USING btree (creator_id);
CREATE INDEX products_post_id_idx ON public.products USING btree (post_id);
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
-- NOTE: `products_type_check` forbids 'external', but `products_external_url_required`
-- is written for a type that the other constraint makes impossible. Dead constraint.
-- Also has both `is_active` and `active`, and both `price_cents` and `amount_cents`.

-- =========================================================
CREATE TABLE public.profile_reviews (
  profile_id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  rating integer NOT NULL,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
ALTER TABLE public.profile_reviews ADD CONSTRAINT profile_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE public.profile_reviews ADD CONSTRAINT profile_reviews_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.profile_reviews ADD CONSTRAINT profile_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.profile_reviews ADD CONSTRAINT profile_reviews_pkey PRIMARY KEY (profile_id, reviewer_id);
ALTER TABLE public.profile_reviews DISABLE ROW LEVEL SECURITY;   -- ⚠️ open to the public key

-- =========================================================
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  full_name text,
  avatar_url text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  interests jsonb,
  "Interests" text[],
  username text,
  tagline text,
  review_rating numeric,
  review_count integer,
  bio text,
  stripe_account_id text,
  stripe_onboarding_complete boolean NOT NULL,
  charges_enabled boolean NOT NULL,
  payouts_enabled boolean NOT NULL,
  onboarding_complete boolean NOT NULL,
  total_earnings_cents bigint NOT NULL
);
ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
CREATE INDEX idx_profiles_stripe_account_id ON public.profiles USING btree (stripe_account_id) WHERE (stripe_account_id IS NOT NULL);
CREATE UNIQUE INDEX profiles_username_unique ON public.profiles USING btree (lower(username));
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
-- NOTE: there is NO role or is_admin column. Adding one is step 1 of the admin board port.
-- NOTE: SELECT is restricted to your own row. Public creator pages work only because
-- they are server components using the service-role key.
-- NOTE: both `interests jsonb` and `"Interests" text[]` exist. The quoted capitalised
-- one is a trap: it must always be double-quoted in SQL.

-- =========================================================
CREATE TABLE public.purchases (
  id uuid NOT NULL,
  buyer_id uuid,
  creator_id uuid,
  post_id uuid NOT NULL,
  amount_cents integer,
  currency text NOT NULL,
  stripe_payment_intent text,
  created_at timestamp with time zone,
  payment_intent_id text,
  product_type text,
  fulfillment_url text,
  product_id uuid,
  session_id text,
  status text NOT NULL,
  is_refund boolean NOT NULL,
  is_suspect boolean NOT NULL,
  fulfillment text,
  fulfillment_payload jsonb,
  first_access_at timestamp with time zone,
  subscription_id text,
  booking_id uuid,
  target_months integer,
  paid_count integer,
  kind text,
  paid_at timestamp with time zone,
  title text,
  plan_months integer,
  plan_amount_cents integer,
  error text,
  buyer_user_id uuid,
  access_granted boolean NOT NULL,
  order_id uuid
);
ALTER TABLE public.purchases ADD CONSTRAINT purchases_fulfillment_check CHECK ((fulfillment = ANY (ARRAY['discord'::text, 'whop'::text])));
ALTER TABLE public.purchases ADD CONSTRAINT purchases_buyer_user_id_fkey FOREIGN KEY (buyer_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.purchases ADD CONSTRAINT purchases_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE public.purchases ADD CONSTRAINT purchases_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.purchases ADD CONSTRAINT purchases_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);
ALTER TABLE public.purchases ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);
ALTER TABLE public.purchases ADD CONSTRAINT purchases_buyer_post_unique UNIQUE (buyer_id, post_id);
ALTER TABLE public.purchases ADD CONSTRAINT purchases_payment_intent_id_key UNIQUE (payment_intent_id);
ALTER TABLE public.purchases ADD CONSTRAINT purchases_session_id_key UNIQUE (session_id);
-- Roughly two dozen indexes on 60 rows. Kept verbatim; the duplication is the finding.
CREATE INDEX idx_purchases_buyer_user_id ON public.purchases USING btree (buyer_user_id) WHERE (buyer_user_id IS NOT NULL);
CREATE INDEX idx_purchases_order_id ON public.purchases USING btree (order_id) WHERE (order_id IS NOT NULL);
CREATE INDEX idx_purchases_payment_intent_id ON public.purchases USING btree (payment_intent_id);
CREATE INDEX idx_purchases_session_id ON public.purchases USING btree (session_id);
CREATE INDEX idx_purchases_subscription_id ON public.purchases USING btree (subscription_id);
CREATE INDEX purchases_buyer_id_idx ON public.purchases USING btree (buyer_id);
CREATE INDEX purchases_buyer_idx ON public.purchases USING btree (buyer_id);                   -- dup
CREATE INDEX purchases_created_at_idx ON public.purchases USING btree (created_at DESC);
CREATE INDEX purchases_creator_idx ON public.purchases USING btree (creator_id);
CREATE INDEX purchases_payment_intent_id_idx ON public.purchases USING btree (payment_intent_id);   -- dup
CREATE INDEX purchases_payment_intent_idx ON public.purchases USING btree (payment_intent_id);      -- dup
CREATE UNIQUE INDEX purchases_payment_intent_uidx ON public.purchases USING btree (payment_intent_id) WHERE (payment_intent_id IS NOT NULL);     -- dup
CREATE UNIQUE INDEX purchases_payment_intent_unique ON public.purchases USING btree (payment_intent_id) WHERE (payment_intent_id IS NOT NULL);   -- dup
CREATE INDEX purchases_post_id_idx ON public.purchases USING btree (post_id);
CREATE INDEX purchases_product_id_idx ON public.purchases USING btree (product_id);
CREATE INDEX purchases_product_idx ON public.purchases USING btree (product_id);              -- dup
CREATE INDEX purchases_session_id_idx ON public.purchases USING btree (session_id);
CREATE INDEX purchases_session_idx ON public.purchases USING btree (session_id);              -- dup
CREATE INDEX purchases_subscription_id_idx ON public.purchases USING btree (subscription_id);
CREATE INDEX purchases_subscription_idx ON public.purchases USING btree (subscription_id);    -- dup
CREATE UNIQUE INDEX purchases_unique_buyer_product ON public.purchases USING btree (buyer_id, product_id) WHERE (product_id IS NOT NULL);
CREATE INDEX purchases_user_id_post_id_idx ON public.purchases USING btree (buyer_id, post_id);
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
-- NOTE: 17 policies. The one named "no client writes" is PERMISSIVE and therefore blocks
-- nothing. Buyers can currently UPDATE and DELETE their own rows. See the remediation.

-- =========================================================
CREATE TABLE public.reviews (
  id uuid NOT NULL,
  reviewer_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  rating integer NOT NULL,
  comment text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL
);
ALTER TABLE public.reviews ADD CONSTRAINT reviews_comment_check CHECK (((char_length(comment) >= 10) AND (char_length(comment) <= 1000)));
ALTER TABLE public.reviews ADD CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)));
ALTER TABLE public.reviews ADD CONSTRAINT reviews_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.reviews ADD CONSTRAINT reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.reviews ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);
ALTER TABLE public.reviews ADD CONSTRAINT reviews_reviewer_id_creator_id_key UNIQUE (reviewer_id, creator_id);
CREATE INDEX idx_reviews_created_at ON public.reviews USING btree (created_at DESC);
CREATE INDEX idx_reviews_creator_id ON public.reviews USING btree (creator_id);
CREATE INDEX idx_reviews_reviewer_id ON public.reviews USING btree (reviewer_id);
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
-- NOTE: second review system, alongside profile_reviews. Both live.

-- =========================================================
CREATE TABLE public.stripe_events (
  id text NOT NULL,
  type text NOT NULL,
  created_at timestamp with time zone NOT NULL
);
ALTER TABLE public.stripe_events ADD CONSTRAINT stripe_events_pkey PRIMARY KEY (id);
ALTER TABLE public.stripe_events DISABLE ROW LEVEL SECURITY;   -- ⚠️ open to the public key
-- NOTE: the webhook idempotency table. Correct shape, zero rows, and NO code references it.

-- =========================================================
CREATE TABLE public.team_routing (
  creator_id uuid NOT NULL,
  mode text NOT NULL,
  default_closer_id uuid,
  updated_at timestamp with time zone
);
ALTER TABLE public.team_routing ADD CONSTRAINT team_routing_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.team_routing ADD CONSTRAINT team_routing_default_closer_id_fkey FOREIGN KEY (default_closer_id) REFERENCES closers(id);
ALTER TABLE public.team_routing ADD CONSTRAINT team_routing_pkey PRIMARY KEY (creator_id);
ALTER TABLE public.team_routing ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.user_interest_scores (
  user_id uuid NOT NULL,
  category text NOT NULL,
  score integer NOT NULL,
  updated_at timestamp with time zone
);
ALTER TABLE public.user_interest_scores ADD CONSTRAINT user_interest_scores_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.user_interest_scores ADD CONSTRAINT user_interest_scores_pkey PRIMARY KEY (user_id, category);
ALTER TABLE public.user_interest_scores ENABLE ROW LEVEL SECURITY;

-- =========================================================
CREATE TABLE public.watch_progress (
  user_id uuid NOT NULL,
  post_id uuid NOT NULL,
  seconds double precision NOT NULL,
  updated_at timestamp with time zone NOT NULL
);
ALTER TABLE public.watch_progress ADD CONSTRAINT watch_progress_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE;
ALTER TABLE public.watch_progress ADD CONSTRAINT watch_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.watch_progress ADD CONSTRAINT watch_progress_pkey PRIMARY KEY (user_id, post_id);
CREATE UNIQUE INDEX watch_progress_user_post_key ON public.watch_progress USING btree (user_id, post_id);   -- dup of the PK
CREATE INDEX watch_progress_updated_at_idx ON public.watch_progress USING btree (updated_at DESC);
CREATE INDEX watch_progress_user_updated_idx ON public.watch_progress USING btree (user_id, updated_at DESC);
ALTER TABLE public.watch_progress ENABLE ROW LEVEL SECURITY;   -- carries 8 overlapping policies
