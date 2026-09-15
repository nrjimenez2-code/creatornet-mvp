"use client";
import { DISCOVER_SESSION_UNAVAILABLE, DiscoverSessionUnavailableError } from "@/lib/discoverFeedError";
import { DiscoverEventQueue } from "@/lib/discoverEventQueue";
const sessions = new Map<string, string>();
const actorTokens = new Map<string, string>();
const watchTotals = new Map<string, number>();
const eventQueue = new DiscoverEventQueue((event, signal) => fetch("/api/feed-events", {
  method: "POST",
  keepalive: true,
  signal,
  headers: {
    "Content-Type": "application/json",
    ...(event.actorToken ? { "x-cn-discover-actor": event.actorToken } : {}),
  },
  body: JSON.stringify({ session: event.session, postId: event.postId, kind: event.kind, watchSeconds: event.watchSeconds }),
}));
function trimMap<T>(map: Map<string, T>, limit: number) {
  while (map.size > limit) map.delete(map.keys().next().value!);
}
export const hasDiscoverSession = (postId: string) => sessions.has(postId);
export function rememberDiscoverSession(
  postIds: string[],
  session: string | null,
) {
  for (const id of postIds) {
    if (session) sessions.set(id, session);
    else sessions.delete(id);
  }
  trimMap(sessions, 10000);
}
export async function fetchDiscoverPage(
  tab: string,
  offset: number,
  limit: number,
  session: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    tab,
    offset: String(offset),
    limit: String(limit),
  });
  if (session) params.set("session", session);
  const response = await fetch("/api/feed?" + params, {
    cache: "no-store",
    signal,
    headers:
      session && actorTokens.has(session)
        ? { "x-cn-discover-actor": actorTokens.get(session)! }
        : {},
  });
  const result = await response.json();
  // A superseded feed must not retain a token even if its body arrived while
  // cancellation was propagating through the browser's transport.
  signal?.throwIfAborted();
  if (response.status === 410 && result.code === DISCOVER_SESSION_UNAVAILABLE)
    throw new DiscoverSessionUnavailableError();
  if (!response.ok) throw new Error(result.error ?? "Could not load feed");
  if (result.session && result.actorToken)
    actorTokens.set(result.session, result.actorToken);
  trimMap(actorTokens, 100);
  return result as {
    items: unknown[];
    session: string | null;
    nextOffset: number;
    hasMore: boolean;
  };
}
export function sendDiscoverEvent(
  postId: string,
  kind: string,
  watchDeltaSeconds?: number,
): boolean {
  const session = sessions.get(postId);
  if (!session) return false;
  const key = session + ":" + postId;
  // Components flush deltas; keep the server's cumulative claim stable on remount.
  let watchSeconds: number | undefined;
  if (kind === "watch") {
    if (
      typeof watchDeltaSeconds !== "number" ||
      !Number.isFinite(watchDeltaSeconds) ||
      watchDeltaSeconds < 0
    )
      return false;
    watchSeconds = (watchTotals.get(key) ?? 0) + watchDeltaSeconds;
    watchTotals.set(key, watchSeconds);
    trimMap(watchTotals, 10000);
  }
  return eventQueue.enqueue({ session, postId, kind, watchSeconds, actorToken: actorTokens.get(session) });
}
