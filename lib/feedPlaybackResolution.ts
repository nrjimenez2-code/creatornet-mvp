import { apiFetch as fetch } from '@/lib/apiFetch';
import { FEED_MEDIA_ORIGIN, ORIGINAL_FEED_MEDIA_ORIGIN } from "./feedMedia";

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
const pending = new Map<string, { controller: AbortController; users: number; promise: Promise<ResolvedFeedPlayback | null> }>();
export function requestFeedPlayback(source: string): { promise: Promise<ResolvedFeedPlayback | null>; cancel: () => void } {
  const key = publicVideoKey(source);
  if (!key) return { promise: Promise.resolve(null), cancel: () => {} };
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created = { controller, users: 0, promise: Promise.resolve<ResolvedFeedPlayback | null>(null) };
    created.promise = fetch(`${FEED_MEDIA_ORIGIN}/auto/playback/${key}`, { credentials: "omit", cache: "no-store", signal: controller.signal })
      .then(async response => response.ok ? parseResolvedPlayback(await response.json(), key) : null)
      .catch(() => null).finally(() => { if (pending.get(key) === created) pending.delete(key); });
    entry = created; pending.set(key, entry);
  }
  entry.users++;
  const subscribed = entry;
  let cancelled = false;
  return { promise: subscribed.promise, cancel: () => {
    if (cancelled) return; cancelled = true;
    if (--subscribed.users === 0) { subscribed.controller.abort(); if (pending.get(key) === subscribed) pending.delete(key); }
  } };
}
export function selectResolvedPlayback(descriptor: ResolvedFeedPlayback, delivery: PlaybackDelivery, nativeHls: boolean) {
  if (delivery === "hls-trial" && nativeHls && descriptor.hlsUrl) return descriptor.hlsUrl;
  return delivery === "original" ? descriptor.originalUrl : descriptor.processedMp4Url ?? descriptor.originalUrl;
}
