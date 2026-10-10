import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { deleteOwnedPost } from "@/lib/deletePostServer";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    return await deleteOwnedPost((await params).postId, user.id);
  } catch {
    return NextResponse.json({ error: "Could not delete this video. Please try again." }, { status: 500 });
  }
}
