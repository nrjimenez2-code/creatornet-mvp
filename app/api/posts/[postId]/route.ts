import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { allowRequest } from "@/lib/rateLimit";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    if (!allowRequest(`delete-post:${user.id}`, { limit: 20, windowMs: 60_000 })) {
      return NextResponse.json({ error: "Please wait a moment and try again." }, { status: 429 });
    }
    const { postId } = await params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId)) {
      return NextResponse.json({ error: "Invalid video." }, { status: 400 });
    }
    // Match ownership in the write itself. Never delete the row, media, product,
    // or purchase: existing buyers must retain playback and file delivery.
    const { data, error } = await supabaseAdmin.from("posts")
      .update({ removed_at: new Date().toISOString() })
      .eq("id", postId).eq("creator_id", user.id).is("removed_at", null)
      .select("id").maybeSingle();
    if (error) throw error;
    if (!data) {
      // Idempotent retry after a lost response; never disclose another owner's post.
      const existing = await supabaseAdmin.from("posts").select("id, removed_at")
        .eq("id", postId).eq("creator_id", user.id).maybeSingle();
      if (existing.error) throw existing.error;
      if (!existing.data?.removed_at) {
        return NextResponse.json({ error: "Video not found." }, { status: 404 });
      }
    }
    return NextResponse.json({ deleted: true, postId });
  } catch {
    return NextResponse.json({ error: "Could not delete this video. Please try again." }, { status: 500 });
  }
}
