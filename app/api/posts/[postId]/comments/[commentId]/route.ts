import { NextRequest, NextResponse } from "next/server";
import { allowRequest, clientKey, tooManyRequests } from "@/lib/rateLimit";
import { publicMessage } from "@/lib/apiError";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";
import { bumpPostComments } from "@/lib/postCounters";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// PATCH: Update a comment
// Editing and deleting comments were the two mutating comment paths left
// unlimited; creating one is already limited in ../route.ts.
const COMMENT_EDIT_RATE = { limit: 30, windowMs: 60_000 };

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ postId: string; commentId: string }> }
) {
  if (!allowRequest(clientKey(req), COMMENT_EDIT_RATE)) {
    return tooManyRequests();
  }

  try {
    const { commentId } = await params;
    
    if (!commentId) {
      return NextResponse.json({ error: "Missing comment_id" }, { status: 400 });
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

    // Verify the comment belongs to the user
    const { data: existingComment, error: fetchError } = await admin
      .from("comments")
      .select("id, user_id")
      .eq("id", commentId)
      .single();

    if (fetchError || !existingComment) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    if (existingComment.user_id !== user.id) {
      return NextResponse.json({ error: "Unauthorized: You can only edit your own comments" }, { status: 403 });
    }

    // Update the comment
    const { data: updatedComment, error: updateError } = await admin
      .from("comments")
      .update({ content: content.trim() })
      .eq("id", commentId)
      .select("id, user_id, content, created_at")
      .single();

    if (updateError) {
      console.error("[comments-api] Update error:", updateError);
      return NextResponse.json({ error: publicMessage("comments", updateError, "Could not update the comment.") }, { status: 500 });
    }

    // Fetch user profile
    const { data: profile } = await admin
      .from("profiles")
      .select("id, username, full_name, avatar_url")
      .eq("id", user.id)
      .single();

    const formattedComment = {
      id: updatedComment.id,
      user_id: updatedComment.user_id,
      content: updatedComment.content,
      created_at: updatedComment.created_at,
      user: {
        id: user.id,
        username: profile?.username || "user",
        full_name: profile?.full_name || null,
        avatar_url: profile?.avatar_url || null,
      },
    };

    return NextResponse.json({ 
      success: true, 
      comment: formattedComment 
    });
  } catch (err: any) {
    console.error("[comments-api] Unexpected error:", err);
    return NextResponse.json({ error: publicMessage("comments", err, "Failed to update comment") }, { status: 500 });
  }
}

// DELETE: Delete a comment
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ postId: string; commentId: string }> }
) {
  if (!allowRequest(clientKey(req), COMMENT_EDIT_RATE)) {
    return tooManyRequests();
  }

  try {
    const { postId, commentId } = await params;
    
    if (!commentId || !postId) {
      return NextResponse.json({ error: "Missing comment_id or post_id" }, { status: 400 });
    }

    const supabase = createServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Verify the comment belongs to the user AND to the post in the URL.
    //
    // post_id used to be neither selected nor checked, and the decrement below
    // used the URL's postId. So deleting your own comment on post A via
    // DELETE /api/posts/<B>/comments/<id> decremented post B's comments_count
    // — any user could drive an unrelated post's counter to zero by repeatedly
    // creating and deleting their own comments, while post A's counter was
    // never decremented and inflated permanently.
    const { data: existingComment, error: fetchError } = await admin
      .from("comments")
      .select("id, user_id, post_id")
      .eq("id", commentId)
      .single();

    if (fetchError || !existingComment) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }


    if (String(existingComment.post_id) !== String(postId)) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }

    if (existingComment.user_id !== user.id) {
      return NextResponse.json({ error: "Unauthorized: You can only delete your own comments" }, { status: 403 });
    }

    // Delete the comment
    const { error: deleteError } = await admin
      .from("comments")
      .delete()
      .eq("id", commentId);

    if (deleteError) {
      console.error("[comments-api] Delete error:", deleteError);
      return NextResponse.json({ error: publicMessage("comments", deleteError, "Could not delete the comment.") }, { status: 500 });
    }

    // Decrement comments_count atomically; never below zero. Keyed on the
    // comment's own post_id, which the check above has proven equals postId.
    const { count } = await bumpPostComments(admin, String(existingComment.post_id), -1);
    const newCount = count ?? 0;

    return NextResponse.json({ 
      success: true,
      comments_count: newCount
    });
  } catch (err: any) {
    console.error("[comments-api] Unexpected error:", err);
    return NextResponse.json({ error: publicMessage("comments", err, "Failed to delete comment") }, { status: 500 });
  }
}

