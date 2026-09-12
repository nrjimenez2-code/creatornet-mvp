import manifest from "./feedMediaManifest.json";
import adaptiveManifest from "./feedAdaptiveManifest.json";

const originalOrigin = "https://pub-91a8d994910d498d90b109487939e1db.r2.dev";
export const FEED_MEDIA_ORIGIN = "https://media.creatornet.net";

/** Only explicitly provisioned public renditions opt into adaptive playback. */
export function feedAdaptiveUrl(source: string | undefined): string | undefined {
  const normalized = feedMediaUrl(source);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (url.origin !== FEED_MEDIA_ORIGIN || url.search || url.hash) return undefined;
    return (adaptiveManifest as Record<string, string>)[url.pathname];
  } catch { return undefined; }
}

/** Only public feed paths are rewritten. Signed/private and third-party URLs stay intact. */
export function feedMediaUrl(source: string | undefined): string | undefined {
  if (!source) return source;
  try {
    const url = new URL(source);
    if (![originalOrigin, FEED_MEDIA_ORIGIN].includes(url.origin) ||
        !url.pathname.startsWith("/videos/") || url.search || url.hash) return source;
    const optimized = (manifest as Record<string, string>)[url.pathname];
    const processable = /^\/videos\/[a-zA-Z0-9_/-]+\.(mp4|mov|webm|m4v|mpeg|mpg|3gp|mkv)$/i.test(url.pathname);
    return FEED_MEDIA_ORIGIN + (optimized || (processable ? "/auto" + url.pathname : url.pathname));
  } catch {
    return source;
  }
}

/** Public posters share the production CDN; private/signed URLs stay untouched. */
export function feedPosterUrl(source: string | null | undefined): string | undefined {
  if (!source) return undefined;
  try {
    const url = new URL(source);
    if ([originalOrigin, FEED_MEDIA_ORIGIN].includes(url.origin) &&
        url.pathname.startsWith('/thumbnails/') && !url.search && !url.hash) {
      return FEED_MEDIA_ORIGIN + url.pathname;
    }
  } catch { /* Relative and third-party images retain their original source. */ }
  return source;
}
