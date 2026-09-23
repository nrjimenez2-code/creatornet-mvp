import { NextResponse } from "next/server";
import { isSafeId } from "@/lib/ids";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { isSellReadyProfile, SELL_READY_COLUMNS } from "@/lib/sellReady";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { onlyVisiblePosts } from "@/lib/visiblePosts";

const headers = { "Cache-Control": "no-store" };
const VIDEO_RATE = { limit: 60, windowMs: 60_000 };
const MAX_IDS = 8;

/** Public details for opened search results; the browser cannot read posts directly. */
export async function POST(req: Request) {
  if (!allowRequest(`search-videos:${clientKey(req)}`, VIDEO_RATE)) return tooManyRequests();
  const body = await req.json().catch(() => null);
  const requested = body?.ids;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_IDS ||
      requested.some(id => !isSafeId(id))) {
    return NextResponse.json({ error: "Invalid videos." }, { status: 400, headers });
  }
  const ids = [...new Set(requested as string[])];

  try {
    const { data: posts, error: postsError } = await onlyVisiblePosts(supabaseAdmin.from("posts")
      .select("id,creator_id,product_id,price_cents,title,content,video_url,poster_url,interests,hashtags,created_at,likes_count,comments_count,shares_count,allow_booking,booking_url")
      .in("id", ids)
      .eq("active", true));
    if (postsError) throw postsError;

    const creatorIds = [...new Set((posts ?? []).map(post => post.creator_id).filter((id): id is string => !!id))];
    const profiles = creatorIds.length
      ? await supabaseAdmin.from("profiles")
        .select(`id,username,full_name,avatar_url,banned_at,${SELL_READY_COLUMNS}`)
        .in("id", creatorIds)
      : { data: [], error: null };
    if (profiles.error) throw profiles.error;
    const creators = new Map((profiles.data ?? []).map(profile => [profile.id, profile]));

    return NextResponse.json({ items: (posts ?? []).filter(post => {
      const creator = creators.get(post.creator_id);
      return creator?.banned_at === null && !!creator.username?.trim();
    }).map(post => {
      const creator = creators.get(post.creator_id);
      return {
        ...post,
        creator_username: creator?.username ?? null,
        creator_name: creator?.full_name || creator?.username || null,
        creator_avatar_url: creator?.avatar_url ?? null,
        creator_verified: isSellReadyProfile(creator),
      };
    }) }, { headers });
  } catch (error) {
    console.error("[search/videos] public video details failed", error);
    return NextResponse.json({ error: "Could not load videos." }, { status: 503, headers });
  }
}
