import 'server-only';
import { supabaseAdmin as admin } from './supabaseAdmin';
import { createServerClient } from './supabaseServer';
import { profileWebsiteColumn, type ProfileHeader } from './profileWebsiteReady';
import { SELL_READY_COLUMNS, isSellReadyProfile } from './sellReady';
import { onlyVisiblePosts } from './visiblePosts';
import { enrichPostViewCounts } from './postViewCountsServer';
import { buildOffers, mapProfileGalleryPosts } from './offers';
import { resolveBioMentions } from './profileMentionsServer';
import { readLikedPostIds } from './mobileProfileLikes';
import type { User } from '@supabase/supabase-js';

/** Read interface for existing server-rendered profile screens. Display rules stay shared. */
export async function readMobileProfile(req: Request, identifier: string, viewer: User | null) {
  const own = identifier === 'me';
  if (own && !viewer) return Response.json({ error: 'Sign in required.' }, { status: 401 });
  if (!own && (!/^[a-zA-Z0-9._-]{1,128}$/.test(identifier) || ['.', '..'].includes(identifier))) return Response.json({ error: 'Invalid profile.' }, { status: 400 });
  const id = own ? viewer!.id : identifier;
  const query = admin.from('profiles').select(`id,username,full_name,tagline,avatar_url,bio,banned_at${profileWebsiteColumn()},${SELL_READY_COLUMNS}`);
  let found = await query.eq('id', id).returns<(ProfileHeader & { banned_at?: string | null })[]>().maybeSingle();
  if (!found.data && !own) found = await admin.from('profiles').select(`id,username,full_name,tagline,avatar_url,bio,banned_at${profileWebsiteColumn()},${SELL_READY_COLUMNS}`).eq('username', id).returns<(ProfileHeader & { banned_at?: string | null })[]>().maybeSingle();
  if (found.error) return Response.json({ error: 'Could not load this profile.' }, { status: 503 });
  const profile = found.data;
  if (!profile || profile.banned_at) return Response.json({ error: 'Profile unavailable.' }, { status: 404 });
  const client = own ? createServerClient({ request: req, readOnlyAuthCookies: true }) : admin;
  const postQuery = client.from('posts').select('id,creator_id,title,content,poster_url,video_url,interests,hashtags,likes_count,comments_count,shares_count,product_id,price_cents,allow_booking,booking_url,hidden_at,removed_at,tips_enabled').eq('creator_id', profile.id).order('created_at', { ascending: false });
  let columns = 'id,product_id,creator_id,title,description,currency,thumbnail_url,type,active,amount_cents,price_cents';
  if (process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY === 'true') columns += ',membership_terms';
  if (process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY === 'true') columns += ',fixed_service_months';
  const [postsResult, productsResult, followers, following] = await Promise.all([
    own ? postQuery.is('removed_at', null) : onlyVisiblePosts(postQuery),
    client.from('products').select(columns).eq('creator_id', profile.id),
    admin.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', profile.id),
    admin.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', profile.id),
  ]);
  if (postsResult.error || productsResult.error || followers.error || following.error) return Response.json({ error: 'Could not load this profile.' }, { status: 503 });
  const posts = await enrichPostViewCounts(admin, postsResult.data ?? []);
  // Schema-aware projections are dynamic; the existing mapper validates display terms.
  const products = productsResult.data as unknown as Parameters<typeof buildOffers>[0];
  const mapped = mapProfileGalleryPosts(posts, products, profile.id);
  const offers = buildOffers(products, posts.filter(post => post.hidden_at === null && post.removed_at === null));
  let likedPostIds: string[] = [];
  if (viewer && posts.length) {
    const client = createServerClient({ request: req, readOnlyAuthCookies: true });
    try {
      likedPostIds = await readLikedPostIds(posts.map(post => post.id), ids =>
        client.from('likes').select('post_id').eq('user_id', viewer.id).in('post_id', ids));
    } catch {
      return Response.json({ error: 'Could not load this profile.' }, { status: 503 });
    }
  }
  const mentions = await resolveBioMentions(profile.bio ?? '');
  return Response.json({
    profile: { id: profile.id, username: profile.username, fullName: profile.full_name, tagline: profile.tagline,
      avatarUrl: profile.avatar_url, bio: profile.bio, websiteUrl: profile.website_url ?? null, verified: isSellReadyProfile(profile) },
    posts: mapped, offers, likedPostIds, mentions, followersCount: followers.count ?? 0, followingCount: following.count ?? 0,
    viewerIsOwner: viewer?.id === profile.id, tippingAvailable: process.env.CREATOR_TIPPING_ENABLED === 'true',
  });
}
