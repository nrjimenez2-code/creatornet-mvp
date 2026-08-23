import { NextRequest, NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { updateInterestScore } from "@/lib/updateInterestScore";
import { bumpPostLikes } from "@/lib/postCounters";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ postId: string }> }
) {
  try {
    const { postId } = await params;
    
    if (!postId) {
      return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
    }

    const supabase = createServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Check if user has already liked this post
    const { data: existingLike, error: checkError } = await admin
      .from("likes")
      .select("id")
      .eq("user_id", user.id)
      .eq("post_id", postId)
      .maybeSingle();

    if (checkError && !checkError.message.includes("No rows")) {
      console.error("[like-api] Check error:", checkError);
      return NextResponse.json({ error: publicMessage("like", checkError, "Could not update like.") }, { status: 500 });
    }

    let liked = false;
    let newCount = 0;

    if (existingLike) {
      // Unlike: delete the like record
      const { error: deleteError } = await admin
        .from("likes")
        .delete()
        .eq("id", existingLike.id);

      if (deleteError) {
        console.error("[like-api] Delete error:", deleteError);
        return NextResponse.json({ error: publicMessage("like", deleteError, "Could not update like.") }, { status: 500 });
      }

      // Decrement atomically. See lib/postCounters.ts — doing this as
      // SELECT-then-UPDATE loses concurrent changes.
      const { count } = await bumpPostLikes(admin, postId, -1);
      newCount = count ?? 0;

      liked = false;
    } else {
      // Like: insert the like record
      const { error: insertError } = await admin
        .from("likes")
        .insert({
          user_id: user.id,
          post_id: postId,
        });

      if (insertError) {
        // Check if it's a duplicate key error (race condition)
        if (insertError.message.includes("duplicate") || insertError.message.includes("unique constraint") || (insertError as any).code === "23505") {
          // Already liked, treat as success
          const { data: postData } = await admin
            .from("posts")
            .select("likes_count")
            .eq("id", postId)
            .single();
          
          newCount = (postData?.likes_count as number) ?? 0;
          liked = true;
        } else {
          console.error("[like-api] Insert error:", insertError);
          return NextResponse.json({ error: publicMessage("like", insertError, "Could not update like.") }, { status: 500 });
        }
      } else {
        // Increment atomically. See lib/postCounters.ts.
        const { count } = await bumpPostLikes(admin, postId, 1);
        newCount = count ?? 0;

        liked = true;
      }
    }

    // Update interest score: +5 on like, no change on unlike
    if (liked) {
      const { data: post } = await admin
        .from("posts")
        .select("interests")
        .eq("id", postId)
        .maybeSingle();
      const category = Array.isArray(post?.interests) ? (post.interests[0] as string ?? null) : null;
      await updateInterestScore(user.id, category, 5);
    }

    return NextResponse.json({
      success: true,
      liked,
      likes_count: newCount
    });
  } catch (err: any) {
    console.error("[like-api] Unexpected error:", err);
    return NextResponse.json({ error: publicMessage("like", err, "Failed to toggle like") }, { status: 500 });
  }
}

