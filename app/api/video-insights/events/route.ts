import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { insightId, validInsightUpdate } from "@/lib/videoInsights";
import { assertInsightPlayback, collectionEnabled, hashInsightSecret, InsightError, insightActor, insightBody, insightFailure, insightHeaders, insightMedia, insightPost, limitInsights } from "@/lib/videoInsightsServer";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    if (!collectionEnabled()) throw new InsightError("Insights collection is unavailable.", 404);
    const actor = await insightActor(req); limitInsights(req, actor.actor);
    const body = await insightBody(req);
    if (!insightId(body.sessionId) || typeof body.secret !== "string" || !/^[a-f0-9]{64}$/.test(body.secret) || !validInsightUpdate(body)) throw new InsightError("Invalid playback update.", 400);
    const session = await supabaseAdmin.from("video_insight_sessions_v1").select("post_id,media_version,surface,started_at")
      .eq("id", body.sessionId).eq("actor_hash", actor.actor).eq("token_hash", hashInsightSecret(body.secret)).maybeSingle();
    if (session.error) throw session.error;
    if (!session.data || Date.now() - Date.parse(session.data.started_at) > 43200000) throw new InsightError("Playback session expired.", 403);
    const post = await insightPost(session.data.post_id);
    await assertInsightPlayback(post, actor.userId, session.data.surface);
    const media = await insightMedia(post.video_url);
    if (!media || media.contentVersion !== session.data.media_version) throw new InsightError("Video changed.", 409);
    const result = await supabaseAdmin.rpc("merge_video_insight_event_v1", {
      p_id: body.sessionId, p_actor: actor.actor, p_token: hashInsightSecret(body.secret),
      p_sequence: body.sequence, p_seconds: body.seconds, p_intervals: body.intervals,
    });
    if (result.error) { if (result.error.code === "22023") throw new InsightError("Invalid playback update.", 400); throw result.error; }
    return NextResponse.json({ ok: true }, { headers: insightHeaders });
  } catch (error) { return insightFailure(error); }
}
