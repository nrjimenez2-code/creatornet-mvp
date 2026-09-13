"use client";
const sessions = new Map<string, string>();
const actorTokens = new Map<string, string>();
const pendingEvents = new Map<string, Promise<unknown>>();
const watchTotals = new Map<string, number>();
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
) {
  const params = new URLSearchParams({
    tab,
    offset: String(offset),
    limit: String(limit),
  });
  if (session) params.set("session", session);
  const response = await fetch("/api/feed?" + params, {
    cache: "no-store",
    headers:
      session && actorTokens.has(session)
        ? { "x-cn-discover-actor": actorTokens.get(session)! }
        : {},
  });
  const result = await response.json();
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
  const send = () =>
    fetch("/api/feed-events", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...(actorTokens.has(session)
          ? { "x-cn-discover-actor": actorTokens.get(session)! }
          : {}),
      },
      body: JSON.stringify({ session, postId, kind, watchSeconds }),
    });
  // Preserve exposure-before-watch ordering even on a slow connection.
  const pending = (pendingEvents.get(key) ?? Promise.resolve())
    .then(send, send)
    .catch(() => {});
  pendingEvents.set(key, pending);
  void pending.finally(() => {
    if (pendingEvents.get(key) === pending) pendingEvents.delete(key);
  });
  return true;
}
