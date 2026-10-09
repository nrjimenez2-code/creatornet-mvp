import "server-only";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { createClient } from "@supabase/supabase-js";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { bumpPostLikes } from "@/lib/postCounters";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";

const LIKE_RATE = { limit: 120, windowMs: 60_000 };

/** Shared website/native like mutation. The verified viewer ID comes from the route boundary. */
export async function updatePostLike(req: NextRequest, postId: string, viewerId: string, likeOnly: boolean): Promise<Response> {
  if (!allowRequest(`like:${clientKey(req)}`, LIKE_RATE)) return tooManyRequests();
  try {
    if (!postId) return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: existingLike, error: checkError } = await admin.from("likes")
      .select("id").eq("user_id", viewerId).eq("post_id", postId).maybeSingle();
    if (checkError && !checkError.message.includes("No rows")) {
      console.error("[like-api] Check error:", checkError);
      return NextResponse.json({ error: publicMessage("like", checkError, "Could not update like.") }, { status: 500 });
    }

    if (existingLike && likeOnly) {
      const { data: post, error } = await admin.from("posts").select("likes_count").eq("id", postId).single();
      if (error) return NextResponse.json({ error: "Could not read like count." }, { status: 500 });
      return NextResponse.json({ success: true, liked: true, likes_count: post?.likes_count ?? 0 });
    }

    let liked = false;
    let newCount = 0;
    let inserted = false;
    if (existingLike) {
      const { error } = await admin.from("likes").delete().eq("id", existingLike.id);
      if (error) {
        console.error("[like-api] Delete error:", error);
        return NextResponse.json({ error: publicMessage("like", error, "Could not update like.") }, { status: 500 });
      }
      const { count } = await bumpPostLikes(admin, postId, -1);
      newCount = count ?? 0;
    } else {
      const { error } = await admin.from("likes").insert({ user_id: viewerId, post_id: postId });
      if (error) {
        if (error.message.includes("duplicate") || error.message.includes("unique constraint") || error.code === "23505") {
          const { data: post } = await admin.from("posts").select("likes_count").eq("id", postId).single();
          newCount = (post?.likes_count as number) ?? 0;
          liked = true;
        } else {
          console.error("[like-api] Insert error:", error);
          return NextResponse.json({ error: publicMessage("like", error, "Could not update like.") }, { status: 500 });
        }
      } else {
        inserted = true;
        const { count } = await bumpPostLikes(admin, postId, 1);
        newCount = count ?? 0;
        liked = true;
      }
    }

    if (inserted) {
      const { data: post } = await admin.from("posts").select("interests").eq("id", postId).maybeSingle();
      const category = Array.isArray(post?.interests) ? (post.interests[0] as string ?? null) : null;
      await updateInterestScore(viewerId, category, 5);
    }
    return NextResponse.json({ success: true, liked, likes_count: newCount });
  } catch (error) {
    console.error("[like-api] Unexpected error:", error);
    return NextResponse.json({ error: publicMessage("like", error, "Failed to toggle like") }, { status: 500 });
  }
}
