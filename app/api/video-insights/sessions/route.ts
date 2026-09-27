import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INSIGHT_SOURCES, insightId } from "@/lib/videoInsights";
import { assertInsightPlayback, collectionEnabled, hashInsightSecret, InsightError, insightActor, insightBody, insightFailure, insightHeaders, insightMedia, insightPost, limitInsights } from "@/lib/videoInsightsServer";
export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  try {
    if (!collectionEnabled()) throw new InsightError("Insights collection is unavailable.", 404);
    const actor = await insightActor(req, true); limitInsights(req, actor.actor, true);
    const body = await insightBody(req);
    if (!insightId(body.postId) || !insightId(body.sessionId) || typeof body.secret !== "string" || !/^[a-f0-9]{64}$/.test(body.secret) ||
        !INSIGHT_SOURCES.includes(body.source as typeof INSIGHT_SOURCES[number]) || !["feed", "watch"].includes(String(body.surface)) ||
        typeof body.startedAt !== "number" || !Number.isFinite(body.startedAt)) throw new InsightError("Invalid playback session.", 400);
    const started = new Date(Math.max(Date.now()-30000,Math.min(Date.now(),body.startedAt))).toISOString();
    // Establish an anonymous cookie before writing a session. A lost cookie response cannot strand a counted session under another actor.
    if (actor.cookie && !/^[a-f0-9]{64}$/.test(req.cookies.get("cn_video_actor")?.value ?? "")) {
      const response = NextResponse.json({ identityReady: true }, { headers: insightHeaders });
      response.cookies.set("cn_video_actor", actor.cookie, { httpOnly: true, secure: new URL(req.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 86400 });
      return response;
    }
    const post = await insightPost(body.postId);
    await assertInsightPlayback(post, actor.userId, String(body.surface));
    const media = await insightMedia(post.video_url);
    if (!media) throw new InsightError("Video metadata unavailable.", 503);
    const result = await supabaseAdmin.rpc("start_video_insight_session_v1", {
      p_id: body.sessionId, p_post: post.id, p_actor: actor.actor, p_token: hashInsightSecret(body.secret),
      p_media: media.contentVersion, p_duration: media.durationSeconds, p_source: body.source, p_surface: body.surface,
      p_started: started,
    });
    if (result.error) throw result.error;
    const response = NextResponse.json({ sessionId: body.sessionId, duration: media.durationSeconds, mediaVersion: media.contentVersion }, { headers: insightHeaders });
    if (actor.cookie) response.cookies.set("cn_video_actor", actor.cookie, { httpOnly: true, secure: new URL(req.url).protocol === "https:", sameSite: "lax", path: "/", maxAge: 86400 });
    return response;
  } catch (error) { return insightFailure(error); }
}
