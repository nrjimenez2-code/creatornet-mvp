import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "./supabaseConnectAuth";
import { supabaseAdmin } from "./supabaseAdmin";
import { allowRequest, clientKey } from "./rateLimit";
import { isLibraryPurchaseEligible } from "./libraryAccess";
import { parseResolvedPlayback, publicVideoKey } from "./feedPlaybackResolution";
import { aggregateInsights, insightId, type InsightAggregate } from "./videoInsights";

export const collectionEnabled = () => process.env.VIDEO_INSIGHTS_COLLECTION_ENABLED === "true";
export const uiEnabled = () => process.env.VIDEO_INSIGHTS_UI_ENABLED === "true" && process.env.NEXT_PUBLIC_VIDEO_INSIGHTS_UI_ENABLED === "true";
export const hashInsightSecret = (value: string) => createHash("sha256").update(value).digest("hex");
export const newInsightSecret = () => randomBytes(32).toString("hex");
export const insightHeaders = { "Cache-Control": "private, no-store" };
export class InsightError extends Error { constructor(message: string, public status: number) { super(message); } }
export function insightFailure(error: unknown) {
  return NextResponse.json({ error: error instanceof InsightError ? error.message : "Could not load video insights. Please try again." }, {
    status: error instanceof InsightError ? error.status : 503, headers: insightHeaders,
  });
}
export async function insightBody(req: NextRequest): Promise<Record<string, unknown>> {
  if (req.headers.get("origin") && req.headers.get("origin") !== new URL(req.url).origin) throw new InsightError("Invalid origin.", 403);
  if (Number(req.headers.get("content-length")) > 32768) throw new InsightError("Update too large.", 413);
  // Bound streamed input too; Content-Length alone is not trustworthy.
  const reader = req.body?.getReader();
  if (!reader) throw new InsightError("Invalid update.", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 32768) { await reader.cancel(); throw new InsightError("Update too large.", 413); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error();
    return body;
  } catch (error) { if (error instanceof InsightError) throw error; throw new InsightError("Invalid update.", 400); }
}
export async function insightActor(req: NextRequest, createAnonymous = false) {
  const user = await getAuthenticatedUser(req);
  if (user) return { userId: user.id, actor: hashInsightSecret(`user:${user.id}`), cookie: null };
  let value = req.cookies.get("cn_video_actor")?.value;
  if (!value || !/^[a-f0-9]{64}$/.test(value)) value = createAnonymous ? newInsightSecret() : undefined;
  if (!value) throw new InsightError("Playback identity expired.", 401);
  return { userId: null, actor: hashInsightSecret(`anonymous:${value}`), cookie: createAnonymous ? value : null };
}
export function limitInsights(req: NextRequest, actor: string, start = false) {
  if (!allowRequest(`insights:${start ? "start" : "events"}:${actor}`, { limit: start ? 120 : 240, windowMs: 60_000 }) ||
      !allowRequest(`insights-ip:${clientKey(req)}`, { limit: 1200, windowMs: 60_000 })) throw new InsightError("Please wait before trying again.", 429);
}
export type InsightPost = { id: string; creator_id: string | null; title: string | null; poster_url: string | null; video_url: string | null; hidden_at: string | null; removed_at: string | null };
export async function insightPost(postId: string): Promise<InsightPost> {
  const result = await supabaseAdmin.from("posts").select("id,creator_id,title,poster_url,video_url,hidden_at,removed_at").eq("id", postId).maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new InsightError("Video not found.", 404);
  return result.data;
}
export async function readOwnedVideoInsights(postId: string, ownerId: string) {
  if (!insightId(postId)) throw new InsightError("Invalid video.", 400);
  const post = await insightPost(postId);
  if (post.creator_id !== ownerId || post.removed_at) throw new InsightError("Video not found.", 404);
  const media = await insightMedia(post.video_url);
  let aggregate: InsightAggregate | null = null;
  if (media) {
    // The database RPC repeats ownership; never return raw sessions or actor identifiers.
    const result = await supabaseAdmin.rpc("read_video_insights_v1", { p_post: postId, p_owner: ownerId, p_media: media.contentVersion });
    if (result.error) throw result.error;
    aggregate = result.data;
  }
  const duration = media?.durationSeconds ?? null;
  return { postId, title: post.title || "Untitled video", poster: post.poster_url,
    previewUrl: media?.processedMp4Url ?? media?.originalUrl ?? null, duration, ...aggregateInsights(aggregate, duration) };
}
/** Feed video_url is the public sales preview. Watch-page playback additionally requires a live purchase. */
export async function assertInsightPlayback(post: InsightPost, userId: string | null, surface: string) {
  if (post.creator_id && post.creator_id === userId) throw new InsightError("Creator previews are excluded.", 403);
  if (surface === "watch" || post.hidden_at || post.removed_at) {
    if (!userId) throw new InsightError("Playback access required.", 403);
    const result = await supabaseAdmin.from("purchases").select("id,buyer_id,status,access_granted").eq("post_id", post.id).eq("buyer_id", userId);
    if (result.error) throw result.error;
    for (const row of result.data ?? []) if (await isLibraryPurchaseEligible(supabaseAdmin, row, userId)) return;
    throw new InsightError("Playback access required.", 403);
  }
  if (!post.video_url) throw new InsightError("Video unavailable.", 404);
}
export async function insightMedia(raw: string | null) {
  const key = publicVideoKey(raw ?? undefined);
  if (!key) return null;
  try {
    const response = await fetch(`https://media.creatornet.net/auto/playback/${key}`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(2500) });
    const media = response.ok ? parseResolvedPlayback(await response.json(), key) : null;
    // A later duration proof starts a separate aggregate rather than changing bucket geometry in place.
    return media ? { ...media, contentVersion: `${media.contentVersion}:${media.durationSeconds ?? "unknown"}` } : null;
  } catch { return null; }
}
