// lib/bookingUrl.ts — what /api/book is allowed to redirect to.
//
// Creators choose their own booking link (Calendly, Cal.com, and so on), and
// the router sends buyers there. That is the feature, so this cannot be a
// fixed allowlist of hosts. What it can refuse:
//   - non-https schemes (javascript:, data:, http:)
//   - credentials in the URL (https://user@evil.com reads as "user" in a
//     status bar; production already has one of these stored)
//   - anything that is not a parseable absolute URL
// Site-relative paths (the default "/api/book?creator_id=...") are fine.

export function isSafeBookingTarget(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (!s || s.length > 2048) return false;
  if (s.startsWith("/") && !s.startsWith("//")) return true;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (!u.hostname || !u.hostname.includes(".")) return false;
  return true;
}
