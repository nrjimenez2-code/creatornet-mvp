import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/siteUrl";
import { loadReleaseSettings } from "@/lib/release/server";
import { featureOpen } from "@/lib/release/policy";
export const dynamic = "force-dynamic";

// Crawl policy: public surfaces only. Everything account-bound, transactional
// or admin-facing is disallowed. /dashboard (the public discover feed) and
// /auth (the effective landing page — / redirects there) stay crawlable.
export default async function robots(): Promise<MetadataRoute.Robots> {
  const settings = await loadReleaseSettings();
  return {
    rules: [{ userAgent: "*", disallow: "/", allow: ["/$", "/legal/", ...(featureOpen(settings, "feed") ? ["/dashboard$"] : []), ...(featureOpen(settings, "profiles") ? ["/creators/"] : []), ...(featureOpen(settings, "search") ? ["/search$", "/tag/"] : [])] }],
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
