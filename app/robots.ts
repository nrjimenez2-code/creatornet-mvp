import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/siteUrl";
import { loadReleaseSettings } from "@/lib/release/server";
import { featureOpen } from "@/lib/release/policy";
export const dynamic = "force-dynamic";

// Crawl policy: root/legal and explicitly released discovery surfaces only.
// Account-bound, transactional and admin paths stay under the blanket deny.
export default async function robots(): Promise<MetadataRoute.Robots> {
  const settings = await loadReleaseSettings();
  return {
    rules: [{ userAgent: "*", disallow: "/", allow: ["/$", "/legal/", ...(featureOpen(settings, "feed") ? ["/dashboard$"] : []), ...(featureOpen(settings, "profiles") ? ["/creators/"] : []), ...(featureOpen(settings, "search") ? ["/search$", "/tag/"] : [])] }],
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
