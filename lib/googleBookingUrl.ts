import { getSiteUrl } from "@/lib/siteUrl";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isBookingId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
/** Recognize only CreatorNet's native Google booking route, never arbitrary hosts. */
export function googleBookingConnectionFromUrl(raw: string, origin = getSiteUrl()): string | null {
  try {
    const base = new URL(origin);
    const url = new URL(raw,base);
    const match = /^\/scheduling\/book\/([^/]+)$/.exec(url.pathname);
    if (url.origin !== base.origin || url.username || url.password || !match || !isBookingId(match[1])) return null;
    return match[1];
  } catch { return null; }
}
