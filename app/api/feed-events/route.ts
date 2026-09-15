import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as admin } from "@/lib/supabaseAdmin";
import {
  discoverEnabled,
  discoverIdentity,
  recordDiscoverEvent,
  recordDiscoverEvents,
} from "@/lib/discoverServer";
import { allowRequest } from "@/lib/rateLimit";
import { verifiedVideoDuration } from "@/lib/discoverMedia";
import { loadDiscoverEventContext } from "@/lib/discoverEventContext";
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
    const isWatch = body.kind === 'watch' || body.kind === 'exposure';
    const seconds = body.kind === 'exposure' ? 0 : body.watchSeconds;
    if (isWatch && (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0))
      return NextResponse.json({error:'Invalid watch time'}, {status:400});
    const context = await loadDiscoverEventContext(body.session, identity.actor, body.postId, isWatch ? seconds : undefined);
    if (!context) return NextResponse.json({error:'Invalid exposure'}, {status:403});
    const {post, audience, offers} = context;
    const base = {
      actor: identity.actor,
      userId: identity.userId,
      postId: body.postId,
      audience,
    };
    const sessionKey = body.session + ":" + body.postId;
    if (isWatch) {
      // Both reads depend on the completed eligibility checks, not each other.
      const [{ data: watched, error: watchError }, duration] = await Promise.all([
        context.watched !== undefined ? Promise.resolve({data:context.watched,error:null}) : admin.rpc("discover_watch_sample_v1", {
          p_session: body.session, p_post: body.postId, p_claimed: seconds,
        }),
        body.kind === "watch" ? verifiedVideoDuration(post.video_url) : Promise.resolve(null),
      ]);
      if (watchError) throw watchError;
      const events = [{kind:'exposure',entityKey:sessionKey}];
      const threshold =
        typeof duration === "number" && duration > 0
          ? Math.min(5, duration * 0.9)
          : 5;
      if (Number(watched) >= threshold)
        events.push({
          kind: "qualified_view",
          entityKey: sessionKey,
        });
      if (
        typeof duration === "number" &&
        duration > 0 &&
        Number(watched) >= duration * 0.9
      )
        events.push({
          kind: "completion",
          entityKey: sessionKey,
        });
      await recordDiscoverEvents(base,events,post,offers);
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
