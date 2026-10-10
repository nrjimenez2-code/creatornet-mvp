// Development-only fixture transport. Never enabled in a production app build.
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const video = 'https://pub-91a8d994910d498d90b109487939e1db.r2.dev/videos/073e7bcb-5986-49cc-8be9-8567c6494562/1788481864376.mov';
const items = ids.map((id, i) => ({ post_id: id, creator_id: '44444444-4444-4444-8444-444444444444', product_id: null, price_cents: 0,
  title: 'Renderer fixture ' + (i + 1), video_url: video, poster_url: '/creatornet-icon-512.png', interests: ['tech'], hashtags: ['fixture'],
  created_at: '2026-10-06T00:00:00.000Z', likes_count: 0, comments_count: 0, shares_count: 0, allow_booking: false, booking_url: null,
  creator_name: 'Renderer fixture', creator_username: 'fixture', creator_avatar_url: '/Default_DP.png', product_type: null,
  product_price_cents: null, is_liked: false, is_following: false, creator_verified: false }));
export const iosFixtureFetch: typeof fetch = async (input, init) => {
  const value = input instanceof Request ? input.url : String(input); const url = new URL(value);
  if (!['GET', 'HEAD'].includes(init?.method ?? 'GET')) return Response.json({ error: 'Fixture actions are disabled.' }, { status: 503 });
  if (url.pathname === '/api/mobile/feed') return Response.json({ items, nextOffset: items.length, hasMore: false, session: null });
  if (url.pathname === '/api/mobile/posts/feed-offers') return Response.json({ offers: {} });
  if (url.pathname === '/api/mobile/profile/fixture') return Response.json({ profile: { id: '44444444-4444-4444-8444-444444444444', username: 'fixture', fullName: 'Renderer fixture', tagline: 'Local interface check', avatarUrl: '/Default_DP.png', bio: 'This account is a development fixture.', websiteUrl: null, verified: false }, posts: [], offers: [], likedPostIds: [], mentions: { accounts: [], ambiguousNames: [] }, followersCount: 0, followingCount: 0, viewerIsOwner: false, tippingAvailable: false });
  return Response.json({ error: 'Fixture unavailable.' }, { status: 404 });
};
