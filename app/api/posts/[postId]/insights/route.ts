import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { InsightError, insightFailure, insightHeaders, limitInsights, readOwnedVideoInsights, uiEnabled } from "@/lib/videoInsightsServer";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  try {
    if (!uiEnabled()) throw new InsightError("Video insights unavailable.", 404);
    const user = await getAuthenticatedUser(req);
    if (!user) throw new InsightError("Please sign in again.", 401);
    limitInsights(req, user.id);
    const { postId } = await params;
    return NextResponse.json(await readOwnedVideoInsights(postId, user.id), { headers: insightHeaders });
  } catch (error) { return insightFailure(error); }
}
