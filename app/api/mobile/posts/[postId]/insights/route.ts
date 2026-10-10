import type { NextRequest } from "next/server";
import { mobileApi } from "@/lib/mobileApi";
import { InsightError, insightFailure, insightHeaders, limitInsights, readOwnedVideoInsights, uiEnabled } from "@/lib/videoInsightsServer";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ postId: string }> };

export async function GET(req: NextRequest, context: Context) {
  const { postId } = await context.params;
  return mobileApi(async (request, user) => {
    try {
      if (!uiEnabled()) throw new InsightError("Video insights unavailable.", 404);
      limitInsights(request, user!.id);
      return Response.json(await readOwnedVideoInsights(postId, user!.id), { headers: insightHeaders });
    } catch (error) { return insightFailure(error); }
  }, ["GET"])(req);
}
export const OPTIONS = mobileApi(async () => new Response(null, { status: 204 }), ["GET"]);
