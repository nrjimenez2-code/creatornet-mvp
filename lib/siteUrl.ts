// Canonical site origin for metadata, robots, sitemap and OG URLs.
//
// Unlike app/api/checkout/route.ts (which can fall back to the request's own
// host), metadata routes run with no request context, so the fallback must be
// a constant. In production that constant is the primary domain — two of the
// three Vercel projects do not set NEXT_PUBLIC_SITE_URL, and falling back to
// localhost there would poison every OG/sitemap URL they serve.
const PRODUCTION_FALLBACK = "https://www.creatornet.net";
const DEV_FALLBACK = "http://localhost:3000";

export function getSiteUrl(): string {
  const configured = (
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? PRODUCTION_FALLBACK : DEV_FALLBACK;
}
