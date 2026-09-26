import { createClient } from "@/lib/supabaseClient";
import { loadFeedOffers } from "@/lib/feedOffers";
import type { PostRow } from "@/lib/feedV3";
import type { SearchPost } from "@/lib/searchTypes";

/** Load public video details from the server, then read the viewer's likes. */
export async function loadSearchVideos(results: SearchPost[]): Promise<PostRow[]> {
  if (!results.length) return [];
  const client = createClient();
  const ids = results.map(post => post.id);
  const [response, session] = await Promise.all([
    fetch("/api/search/videos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include", cache: "no-store", body: JSON.stringify({ ids }),
    }),
    client.auth.getSession(),
  ]);
  if (!response.ok || session.error) throw new Error("Could not load videos.");
  const payload = await response.json();
  if (!Array.isArray(payload?.items)) throw new Error("Could not load videos.");
  const userId = session.data.session?.user.id;
  const likes = userId ? await client.from("likes").select("post_id").eq("user_id", userId).in("post_id", ids) : { data: [], error: null };
  // An unknown like state must not render an actionable empty heart.
  if (likes.error) throw new Error("Could not load videos.");
  const liked = new Set((likes.data ?? []).map(row => row.post_id));
  const rows = new Map((payload.items as Array<PostRow & { tips_available?: boolean }>).map(row => [
    row.id,
    { ...row, tips_enabled: row.tips_available === true },
  ]));
  const ordered: PostRow[] = results.flatMap(result => {
    const post = rows.get(result.id);
    if (!post || post.creator_id !== result.creator_id) return [];
    return [{ ...post, is_liked: liked.has(post.id),
      creator_username: post.creator_username || result.creator.username,
      creator_name: post.creator_name || post.creator_username || result.creator.username }];
  });
  return loadFeedOffers(ordered);
}
