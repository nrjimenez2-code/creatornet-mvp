import manifest from "./feedMediaManifest.json";

const originalOrigin = "https://pub-91a8d994910d498d90b109487939e1db.r2.dev";
export const FEED_MEDIA_ORIGIN = "https://media.creatornet.net";

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
