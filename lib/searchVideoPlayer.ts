import { createClient } from "@/lib/supabaseClient";
import { onlyVisiblePosts } from "@/lib/visiblePosts";
import { loadFeedOffers } from "@/lib/feedOffers";
import type { PostRow } from "@/lib/feedV3";
import type { SearchPost } from "@/lib/searchTypes";

/** Load only the selected search results, using the viewer's RLS session. */
export async function loadSearchVideos(results: SearchPost[]): Promise<PostRow[]> {
  if (!results.length) return [];
  const client = createClient();
  const ids = results.map(post => post.id);
  const [posts, profiles, session] = await Promise.all([
    onlyVisiblePosts(client.from("posts")
      .select("id,creator_id,product_id,price_cents,title,content,video_url,poster_url,interests,hashtags,created_at,likes_count,comments_count,shares_count,allow_booking,booking_url")
      .in("id", ids)),
    client.from("profiles").select("id,username,full_name,avatar_url")
      .in("id", [...new Set(results.map(post => post.creator_id))]),
    client.auth.getSession(),
  ]);
  if (posts.error || profiles.error || session.error) throw new Error("Could not load videos.");
  const userId = session.data.session?.user.id;
  const likes = userId ? await client.from("likes").select("post_id").eq("user_id", userId).in("post_id", ids) : { data: [], error: null };
  // An unknown like state must not render an actionable empty heart.
  if (likes.error) throw new Error("Could not load videos.");
  const liked = new Set((likes.data ?? []).map(row => row.post_id));
  const creators = new Map((profiles.data ?? []).map(row => [row.id, row]));
  const rows = new Map((posts.data ?? []).map(row => [row.id, row]));
  const ordered: PostRow[] = results.flatMap(result => {
    const post = rows.get(result.id);
    if (!post || post.creator_id !== result.creator_id) return [];
    const creator = creators.get(post.creator_id);
    return [{ ...post, is_liked: liked.has(post.id),
      creator_username: creator?.username || result.creator.username,
      creator_name: creator?.full_name || creator?.username || result.creator.username,
      creator_avatar_url: creator?.avatar_url ?? null }];
  });
  return loadFeedOffers(ordered);
}
