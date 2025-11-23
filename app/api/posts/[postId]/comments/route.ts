import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// GET: Fetch comments for a post
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ postId: string }> }
) {
  try {
    const { postId } = await params;
    
    if (!postId) {
      return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Fetch comments
    const { data: comments, error: commentsError } = await admin
      .from("comments")
      .select("id, user_id, content, created_at")
      .eq("post_id", postId)
      .order("created_at", { ascending: false })
      .limit(100);

    if (commentsError) {
      console.error("[comments-api] Fetch error:", commentsError);
      return NextResponse.json({ error: commentsError.message }, { status: 500 });
    }

    // Fetch user profiles for all commenters
    const userIds = Array.from(new Set((comments || []).map((c: any) => c.user_id).filter(Boolean)));
    let profilesMap = new Map<string, { username: string; full_name: string | null; avatar_url: string | null }>();
    
    if (userIds.length > 0) {
      const { data: profiles } = await admin
        .from("profiles")
        .select("id, username, full_name, avatar_url")
        .in("id", userIds);
      
      if (profiles) {
        for (const profile of profiles) {
          profilesMap.set(profile.id, {
            username: profile.username || "user",
            full_name: profile.full_name || null,
            avatar_url: profile.avatar_url || null,
          });
        }
      }
    }

    // Transform comments to include user info
    const formattedComments = (comments || []).map((comment: any) => {
      const profile = profilesMap.get(comment.user_id) || {
        username: "user",
        full_name: null,
        avatar_url: null,
      };
      
      return {
        id: comment.id,
        user_id: comment.user_id,
        content: comment.content,
        created_at: comment.created_at,
        user: {
          id: comment.user_id,
          username: profile.username,
          full_name: profile.full_name,
          avatar_url: profile.avatar_url,
        },
      };
    });

    return NextResponse.json({ 
      success: true, 
      comments: formattedComments 
    });
  } catch (err: any) {
    console.error("[comments-api] Unexpected error:", err);
    return NextResponse.json({ error: err?.message || "Failed to fetch comments" }, { status: 500 });
  }
}

// POST: Create a new comment
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

    const body = await req.json();
    const { content } = body;

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json({ error: "Comment content is required" }, { status: 400 });
    }

    if (content.length > 500) {
      return NextResponse.json({ error: "Comment must be 500 characters or less" }, { status: 400 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Insert comment
    const { data: newComment, error: insertError } = await admin
      .from("comments")
      .insert({
        post_id: postId,
        user_id: user.id,
        content: content.trim(),
      })
      .select("id, user_id, content, created_at")
      .single();

    if (insertError) {
      console.error("[comments-api] Insert error:", insertError);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // Fetch user profile
    const { data: profile } = await admin
      .from("profiles")
      .select("id, username, full_name, avatar_url")
      .eq("id", user.id)
      .single();

    // Increment comments_count in posts table
    const { data: postData } = await admin
      .from("posts")
      .select("comments_count")
      .eq("id", postId)
      .single();

    let newCount = 0;
    if (postData) {
      const currentCount = (postData.comments_count as number) ?? 0;
      newCount = currentCount + 1;
      await admin
        .from("posts")
        .update({ comments_count: newCount })
        .eq("id", postId);
    }

    // Format response
    const formattedComment = {
      id: newComment.id,
      user_id: newComment.user_id,
      content: newComment.content,
      created_at: newComment.created_at,
      user: {
        id: user.id,
        username: profile?.username || "user",
        full_name: profile?.full_name || null,
        avatar_url: profile?.avatar_url || null,
      },
    };

    return NextResponse.json({ 
      success: true, 
      comment: formattedComment,
      comments_count: newCount
    });
  } catch (err: any) {
    console.error("[comments-api] Unexpected error:", err);
    return NextResponse.json({ error: err?.message || "Failed to create comment" }, { status: 500 });
  }
}

