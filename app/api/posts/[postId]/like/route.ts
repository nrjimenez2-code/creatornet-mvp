import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

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
      return NextResponse.json({ error: checkError.message }, { status: 500 });
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
        return NextResponse.json({ error: deleteError.message }, { status: 500 });
      }

      // Decrement likes_count in posts table
      const { data: postData, error: postError } = await admin
        .from("posts")
        .select("likes_count")
        .eq("id", postId)
        .single();

      if (!postError && postData) {
        const currentCount = (postData.likes_count as number) ?? 0;
        newCount = Math.max(0, currentCount - 1);
        
        await admin
          .from("posts")
          .update({ likes_count: newCount })
          .eq("id", postId);
      }

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
          return NextResponse.json({ error: insertError.message }, { status: 500 });
        }
      } else {
        // Increment likes_count in posts table
        const { data: postData, error: postError } = await admin
          .from("posts")
          .select("likes_count")
          .eq("id", postId)
          .single();

        if (!postError && postData) {
          const currentCount = (postData.likes_count as number) ?? 0;
          newCount = currentCount + 1;
          
          await admin
            .from("posts")
            .update({ likes_count: newCount })
            .eq("id", postId);
        }

        liked = true;
      }
    }

    return NextResponse.json({ 
      success: true, 
      liked,
      likes_count: newCount 
    });
  } catch (err: any) {
    console.error("[like-api] Unexpected error:", err);
    return NextResponse.json({ error: err?.message || "Failed to toggle like" }, { status: 500 });
  }
}

