import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import {
  discoverEnabled,
  discoverIdentity,
  recordDiscoverEvent,
} from "@/lib/discoverServer";
import { allowRequest } from "@/lib/rateLimit";
import { verifiedVideoDuration } from "@/lib/discoverMedia";
const KINDS = new Set([
  "exposure",
  "watch",
  "product_tap",
  "booking_tap",
  "not_interested",
  "quick_skip",
]);
export async function POST(req: NextRequest) {
  if (!discoverEnabled())
    return NextResponse.json({ ok: true, enabled: false });
  try {
    const body = await req.json();
    if (
      !KINDS.has(body.kind) ||
      typeof body.postId !== "string" ||
      typeof body.session !== "string"
    )
      return NextResponse.json({ error: "Invalid event" }, { status: 400 });
    const identity = await discoverIdentity(req);
    if (
      !allowRequest("discover:" + identity.actor, {
        limit: 240,
        windowMs: 60000,
      })
    )
      return NextResponse.json({ error: "Too many events" }, { status: 429 });
    const { data: session, error } = await admin
      .from("discover_sessions_v1")
      .select("post_ids,expires_at,audiences")
      .eq("id", body.session)
      .eq("actor", identity.actor)
      .single();
    if (
      error ||
      !session ||
      Date.parse(session.expires_at) <= Date.now() ||
      !session.post_ids.includes(body.postId)
    )
      return NextResponse.json({ error: "Invalid exposure" }, { status: 403 });
    const { data: post, error: postError } = await admin
      .from("posts")
      .select("creator_id,active,hidden_at,removed_at,video_url")
      .eq("id", body.postId)
      .single();
    if (
      postError ||
      !post ||
      post.active === false ||
      post.hidden_at ||
      post.removed_at
    )
      return NextResponse.json({ error: "Post unavailable" }, { status: 403 });
    const { data: creator, error: creatorError } = await admin
      .from("profiles")
      .select("banned_at")
      .eq("id", post.creator_id)
      .single();
    if (creatorError || !creator || creator.banned_at)
      return NextResponse.json({ error: "Post unavailable" }, { status: 403 });
    const base = {
      actor: identity.actor,
      userId: identity.userId,
      postId: body.postId,
      audience: session.audiences?.[body.postId] ?? "general",
    };
    const sessionKey = body.session + ":" + body.postId;
    if (body.kind === "watch" || body.kind === "exposure") {
      const seconds = body.kind === "exposure" ? 0 : body.watchSeconds;
      if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < 0
      )
        return NextResponse.json(
          { error: "Invalid watch time" },
          { status: 400 },
        );
      const { data: watched, error: watchError } = await admin.rpc(
        "discover_watch_sample_v1",
        { p_session: body.session, p_post: body.postId, p_claimed: seconds },
      );
      if (watchError) throw watchError;
      await recordDiscoverEvent({
        ...base,
        kind: "exposure",
        entityKey: sessionKey,
      });
      const duration =
        body.kind === "watch"
          ? await verifiedVideoDuration(post.video_url)
          : null;
      const threshold =
        typeof duration === "number" && duration > 0
          ? Math.min(5, duration * 0.9)
          : 5;
      if (Number(watched) >= threshold)
        await recordDiscoverEvent({
          ...base,
          kind: "qualified_view",
          entityKey: sessionKey,
        });
      if (
        typeof duration === "number" &&
        duration > 0 &&
        Number(watched) >= duration * 0.9
      )
        await recordDiscoverEvent({
          ...base,
          kind: "completion",
          entityKey: sessionKey,
        });
    } else {
      // Dedupe taps and negative feedback across remounts, refreshes and retries.
      const day = new Date().toISOString().slice(0, 10);
      await recordDiscoverEvent({
        ...base,
        kind: body.kind,
        entityKey: identity.actor + ":" + body.postId + ":" + day,
      });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Could not record feed event" },
      { status: 503 },
    );
  }
}
