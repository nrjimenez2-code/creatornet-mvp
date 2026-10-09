import type { NextRequest } from "next/server";
import { mobileApi } from "@/lib/mobileApi";
import { updatePostLike } from "@/lib/postLikeServer";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ postId: string }> };
async function handler(req: NextRequest, context: Context) {
  const { postId } = await context.params;
  return mobileApi((inner, user) => updatePostLike(inner, postId, user!.id, inner.method === "PUT"), ["POST", "PUT"])(req);
}
export const POST = handler;
export const PUT = handler;
export const OPTIONS = mobileApi(async () => new Response(null, { status: 204 }), ["POST", "PUT"]);
