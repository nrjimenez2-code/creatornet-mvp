import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { aggregateInsights, insightId, type InsightAggregate } from "@/lib/videoInsights";
import { InsightError, insightFailure, insightHeaders, insightMedia, insightPost, limitInsights, uiEnabled } from "@/lib/videoInsightsServer";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  try {
    if (!uiEnabled()) throw new InsightError("Video insights unavailable.", 404);
    const user = await getAuthenticatedUser(req);
    if (!user) throw new InsightError("Please sign in again.", 401);
    limitInsights(req, user.id);
    const { postId } = await params;
    if (!insightId(postId)) throw new InsightError("Invalid video.", 400);
    const post = await insightPost(postId);
    if (post.creator_id !== user.id || post.removed_at) throw new InsightError("Video not found.", 404);
    const media = await insightMedia(post.video_url);
    let aggregate: InsightAggregate | null = null;
    if (media) {
      // Ownership is checked again in the RPC; no raw sessions or actor identifiers are returned.
      const result = await supabaseAdmin.rpc("read_video_insights_v1", { p_post: postId, p_owner: user.id, p_media: media.contentVersion });
      if (result.error) throw result.error;
      aggregate = result.data;
    }
    const duration = media?.durationSeconds ?? null;
    return NextResponse.json({ postId, title: post.title || "Untitled video", poster: post.poster_url,
      previewUrl: media?.processedMp4Url ?? media?.originalUrl ?? null, duration, ...aggregateInsights(aggregate, duration) }, { headers: insightHeaders });
  } catch (error) { return insightFailure(error); }
}
