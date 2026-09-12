import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { feedPosterUrl } from "@/lib/feedMedia";
import { onlyVisiblePosts } from "@/lib/visiblePosts";

// The watch page requires sign-in, but a shared post link is unfurled by chat
// apps and social cards before anyone signs in. Give that card the post's own
// title, caption and thumbnail. Moderated (hidden/removed) and unknown posts
// keep the generic card, so a link never reveals more than the public creator
// page already shows for that post.
const GENERIC: Metadata = { title: "Watch", robots: { index: false, follow: false } };
const POST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<{ postId: string }> }): Promise<Metadata> {
  const { postId } = await params;
  if (!postId || !POST_ID.test(postId)) return GENERIC;
  try {
    // Filtered in the query like every other discovery surface, and checked
    // again on the row so a stub or a future select change cannot widen it.
    const { data: post, error } = await onlyVisiblePosts(
      supabaseAdmin
        .from("posts")
        .select("id, title, content, poster_url, creator_id, hidden_at, removed_at")
        .eq("id", postId),
    ).maybeSingle();
    if (error || !post || post.hidden_at || post.removed_at) return GENERIC;

    let creatorName: string | null = null;
    if (post.creator_id) {
      const { data: creator } = await supabaseAdmin
        .from("profiles")
        .select("full_name, username")
        .eq("id", post.creator_id)
        .maybeSingle();
      creatorName = creator?.full_name || (creator?.username ? `@${creator.username}` : null);
    }

    const title = (post.title || "").trim() || (creatorName ? `A video by ${creatorName}` : "Watch");
    const description =
      (post.content || "").trim().slice(0, 160) ||
      (creatorName ? `Watch ${creatorName} on CreatorNet.` : "Watch this video on CreatorNet.");
    const cdnPoster = feedPosterUrl(post.poster_url);
    const poster = cdnPoster && cdnPoster.startsWith("https://") ? cdnPoster : undefined;

    return {
      ...GENERIC,
      title,
      description,
      openGraph: { title, description, url: `/watch/${post.id}`, ...(poster ? { images: [{ url: poster }] } : {}) },
      twitter: { card: poster ? "summary_large_image" : "summary", title, description, ...(poster ? { images: [poster] } : {}) },
    };
  } catch {
    return GENERIC;
  }
}

export default function WatchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
