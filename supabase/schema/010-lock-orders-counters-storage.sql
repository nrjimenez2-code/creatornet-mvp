-- 010 — four more write paths the browser should not have
--
-- Run in the Supabase SQL editor (or `supabase db query -f`). Grants,
-- policies and one function ACL; no structure or data changes.
--
-- A. orders: an INSERT policy let any signed-in user create an order row
--    with any creator_id, status and gross_amount. Orders are only ever
--    written by /api/checkout and the Stripe webhook through the service
--    role, so the browser needs no write at all. Revoke, and drop the
--    policy. The SELECT policies (buyer or creator sees their own) stay.
--
-- B. posts: the UPDATE policies let a creator edit every column of their
--    own posts, including likes_count, comments_count, shares_count,
--    purchase_count, views, premium_path, product_id, price_cents,
--    creator_id and user_id. No page writes posts from the browser
--    (checked: every from("posts") in app/ and components/ is a SELECT);
--    /api/posts and the counters go through the service role. Table-level
--    writes are revoked and the harmless content columns are granted back
--    so a future in-place edit keeps working without touching the money
--    and counter columns.
--
-- C. increment_post_likes / increment_post_comments / increment_post_shares
--    are SECURITY DEFINER, executable by anyone, and add one to a counter
--    on any post. Only /api/posts/[id]/share calls one of them, via the
--    service role. Revoke from anon/authenticated.
--
-- D. storage: the policy "objects.insert: owner can upload to allowed
--    buckets" allowed INSERT when owner IS NULL, which is exactly the
--    signed-out case. Anyone could push files into videos/, thumbnails/
--    and the private premium/ bucket. Each bucket already has an
--    owner-folder INSERT policy, so this one is simply dropped.

BEGIN;

-- A. orders
REVOKE INSERT, UPDATE, DELETE ON public.orders FROM anon, authenticated;
DROP POLICY IF EXISTS "buyer inserts own order" ON public.orders;

-- B. posts
REVOKE INSERT, UPDATE, DELETE ON public.posts FROM anon, authenticated;
GRANT UPDATE (
  title, content, caption, hashtags, tags, topics, interests,
  booking_url, booking_url_override, allow_booking, active,
  poster_url, cta_type, display_price
) ON public.posts TO authenticated;
GRANT DELETE ON public.posts TO authenticated;   -- "delete own posts" policy still scopes it

-- C. counter functions
REVOKE EXECUTE ON FUNCTION public.increment_post_likes(uuid)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_post_comments(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_post_shares(uuid)   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.increment_post_likes(uuid)    TO service_role;
GRANT  EXECUTE ON FUNCTION public.increment_post_comments(uuid) TO service_role;
GRANT  EXECUTE ON FUNCTION public.increment_post_shares(uuid)   TO service_role;

-- D. storage
DROP POLICY IF EXISTS "objects.insert: owner can upload to allowed buckets" ON storage.objects;

COMMIT;

-- VERIFY (read-only)
-- select policyname from pg_policies where tablename='orders' and cmd='INSERT';           -- expect: none
-- select has_table_privilege('authenticated','public.orders','INSERT');                    -- expect: false
-- select column_name from information_schema.column_privileges
--   where table_name='posts' and grantee='authenticated' and privilege_type='UPDATE';      -- expect: the 14 content columns only
-- select has_function_privilege('anon','public.increment_post_likes(uuid)','EXECUTE');     -- expect: false
-- select policyname from pg_policies where schemaname='storage' and cmd='INSERT';         -- expect: per-bucket owner policies only

-- ROLLBACK
-- GRANT INSERT, UPDATE, DELETE ON public.orders TO anon, authenticated;
-- CREATE POLICY "buyer inserts own order" ON public.orders FOR INSERT WITH CHECK (buyer_id = auth.uid());
-- GRANT INSERT, UPDATE, DELETE ON public.posts TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.increment_post_likes(uuid) TO anon, authenticated;  (x3)
-- CREATE POLICY "objects.insert: owner can upload to allowed buckets" ON storage.objects FOR INSERT
--   WITH CHECK (bucket_id = ANY (ARRAY['videos','thumbnails','premium']) AND (owner = auth.uid() OR owner IS NULL));
