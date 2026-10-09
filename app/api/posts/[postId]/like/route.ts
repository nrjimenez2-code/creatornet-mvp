import { NextRequest, NextResponse } from "next/server";
import { publicMessage } from "@/lib/apiError";
import { createServerClient } from "@/lib/supabaseServer";
import { updatePostLike } from "@/lib/postLikeServer";

type Context = { params: Promise<{ postId: string }> };
export async function POST(req: NextRequest, context: Context) {
  return updateLike(req, context, false);
}
// A double tap only adds the like; it never toggles an existing one off.
export async function PUT(req: NextRequest, context: Context) {
  return updateLike(req, context, true);
}
async function updateLike(req: NextRequest, { params }: Context, likeOnly: boolean) {
  try {
    const { postId } = await params;
    if (!postId) return NextResponse.json({ error: "Missing post_id" }, { status: 400 });
    const { data: { user }, error } = await createServerClient().auth.getUser();
    if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return await updatePostLike(req, postId, user.id, likeOnly);
  } catch (error) {
    console.error("[like-api] Unexpected error:", error);
    return NextResponse.json({ error: publicMessage("like", error, "Failed to toggle like") }, { status: 500 });
  }
}
