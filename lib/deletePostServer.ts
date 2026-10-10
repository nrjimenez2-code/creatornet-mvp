import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { allowRequest } from "@/lib/rateLimit";

/** Soft-delete is scoped in the write; existing purchases and media remain intact. */
export async function deleteOwnedPost(postId: string, ownerId: string): Promise<Response> {
  if (!allowRequest(`delete-post:${ownerId}`, { limit: 20, windowMs: 60_000 })) {
    return NextResponse.json({ error: "Please wait a moment and try again." }, { status: 429 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId)) {
    return NextResponse.json({ error: "Invalid video." }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin.from("posts")
    .update({ removed_at: new Date().toISOString() })
    .eq("id", postId).eq("creator_id", ownerId).is("removed_at", null)
    .select("id").maybeSingle();
  if (error) throw error;
  if (!data) {
    // A retry after a lost response succeeds only for this owner's removed post.
    const existing = await supabaseAdmin.from("posts").select("id, removed_at")
      .eq("id", postId).eq("creator_id", ownerId).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data?.removed_at) {
      return NextResponse.json({ error: "Video not found." }, { status: 404 });
    }
  }
  return NextResponse.json({ deleted: true, postId });
}
