import type { NextRequest } from "next/server";
import { mobileApi } from "@/lib/mobileApi";
import { deleteOwnedPost } from "@/lib/deletePostServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ postId: string }> };

export async function DELETE(req: NextRequest, context: Context) {
  const { postId } = await context.params;
  return mobileApi(async (_request, user) => {
    try {
      return await deleteOwnedPost(postId, user!.id);
    } catch {
      return Response.json({ error: "Could not delete this video. Please try again." }, { status: 500 });
    }
  }, ["DELETE"])(req);
}
export const OPTIONS = mobileApi(async () => new Response(null, { status: 204 }), ["DELETE"]);
