import { FEED_MEDIA_ORIGIN, ORIGINAL_FEED_MEDIA_ORIGIN } from "./feedMedia";
import { recordFeedEvent } from "./mobileFeedDiagnostics";

export type ResolvedFeedPlayback = {
  key: string;
  contentVersion: string;
  originalUrl: string;
  processedMp4Url: string | null;
  hlsUrl?: string;
  durationSeconds: number | null;
  timelineProofId?: string;
};
export type PlaybackDelivery = "off" | "mp4" | "original" | "hls-trial";

export function mobilePlaybackDelivery(controllerEnabled: boolean): PlaybackDelivery {
  if (typeof window === "undefined") return "off";
  const requested = new URLSearchParams(window.location.search).get("feedDelivery");
  if (requested === "0") return "off";
  if (requested === "hls") return "hls-trial";
  if (requested === "original") return "original";
  return requested === "mp4" || controllerEnabled ? "mp4" : "off";
}
export function publicVideoKey(source: string | undefined): string | null {
  try {
    const url = new URL(source!);
    if (![FEED_MEDIA_ORIGIN, ORIGINAL_FEED_MEDIA_ORIGIN].includes(url.origin) || url.search || url.hash || url.username || url.password) return null;
    const key = url.pathname.replace(/^\/auto\//, "/").slice(1);
    return key.length <= 2048 && /^videos\/[a-zA-Z0-9_/-]+\.(mp4|mov|webm|m4v|mpeg|mpg|3gp|mkv)$/i.test(key) && !key.includes("..") && !key.includes("//") ? key : null;
  } catch { return null; }
}
export function parseResolvedPlayback(value: unknown, key: string): ResolvedFeedPlayback | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ResolvedFeedPlayback>;
  if (row.key !== key || !/^sha256:[a-f0-9]{64}$/.test(row.contentVersion ?? "") || row.originalUrl !== `${FEED_MEDIA_ORIGIN}/${key}` ||
      !(row.durationSeconds === null || (typeof row.durationSeconds === "number" && Number.isFinite(row.durationSeconds) && row.durationSeconds > 0 && row.durationSeconds <= 43200))) return null;
  const digest = row.contentVersion!.slice(7);
  if (row.processedMp4Url !== null && row.processedMp4Url !== `${FEED_MEDIA_ORIGIN}/feed-auto/${digest}.mp4`) return null;
  if (row.hlsUrl !== undefined) {
    try {
      const hls = new URL(row.hlsUrl);
      if (hls.protocol !== "https:" || !(hls.hostname === "videodelivery.net" || /^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(hls.hostname)) || hls.username || hls.password || hls.search || hls.hash || !/^\/[a-f0-9]{32}\/manifest\/video\.m3u8$/.test(hls.pathname)) return null;
    } catch { return null; }
  }
  return { key, contentVersion: row.contentVersion!, originalUrl: row.originalUrl!, processedMp4Url: row.processedMp4Url!,
    durationSeconds: row.durationSeconds!, ...(row.hlsUrl ? { hlsUrl: row.hlsUrl } : {}) };
}

// Only subscribers for the active card and the predicted neighbor enter this
// map. No settled descriptor cache can hide a new source ETag on a later lookup.
const pending = new Map<string, { controller: AbortController; users: number; settled: boolean; promise: Promise<ResolvedFeedPlayback | null> }>();
function resolutionErrorName(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? error.name : null;
  // Never export error messages or arbitrary provider-supplied names.
  return typeof name === "string" && ["AbortError", "TypeError", "SyntaxError", "NetworkError", "SecurityError", "TimeoutError", "Error"].includes(name) ? name : "unknown";
}
export function requestFeedPlayback(source: string): { promise: Promise<ResolvedFeedPlayback | null>; cancel: () => void } {
  const key = publicVideoKey(source);
  if (!key) return { promise: Promise.resolve(null), cancel: () => {} };
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created = { controller, users: 0, settled: false, promise: Promise.resolve<ResolvedFeedPlayback | null>(null) };
    created.promise = fetch(`${FEED_MEDIA_ORIGIN}/auto/playback/${key}`, { credentials: "omit", cache: "no-store", signal: controller.signal })
      .then(async response => {
        const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
        if (!response.ok) { recordFeedEvent("resolution-result", { key, outcome: "http-error", status }); return null; }
        let value: unknown;
        try { value = await response.json(); }
        catch (error) { recordFeedEvent("resolution-result", { key, outcome: controller.signal.aborted ? "aborted" : "invalid-json", status, errorName: resolutionErrorName(error) }); return null; }
        const descriptor = parseResolvedPlayback(value, key);
        recordFeedEvent("resolution-result", { key, outcome: descriptor ? "resolved" : "invalid-descriptor", status });
        return descriptor;
      })
      .catch((error: unknown) => { recordFeedEvent("resolution-result", { key, outcome: controller.signal.aborted ? "aborted" : "fetch-error", status: null, errorName: resolutionErrorName(error) }); return null; })
      .finally(() => { created.settled = true; if (pending.get(key) === created) pending.delete(key); });
    entry = created; pending.set(key, entry);
  }
  entry.users++;
  const subscribed = entry;
  let cancelled = false;
  return { promise: subscribed.promise, cancel: () => {
    if (cancelled) return; cancelled = true;
    if (--subscribed.users === 0 && !subscribed.settled) {
      recordFeedEvent("resolution-abort-requested", { key, reason: "no-subscribers" });
      subscribed.controller.abort(); if (pending.get(key) === subscribed) pending.delete(key);
    }
  } };
}
export function selectResolvedPlayback(descriptor: ResolvedFeedPlayback, delivery: PlaybackDelivery, nativeHls: boolean) {
  if (delivery === "hls-trial" && nativeHls && descriptor.hlsUrl) return descriptor.hlsUrl;
  return delivery === "original" ? descriptor.originalUrl : descriptor.processedMp4Url ?? descriptor.originalUrl;
}
