import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/siteUrl";
import { loadReleaseSettings } from "@/lib/release/server";
import { blankPublicPage, featureOpen } from "@/lib/release/policy";
export const dynamic = "force-dynamic";

// Crawl policy: root/legal and explicitly released discovery surfaces only.
// Account-bound, transactional and admin paths stay under the blanket deny.
export default async function robots(): Promise<MetadataRoute.Robots> {
  const settings = await loadReleaseSettings();
  // Let crawlers see the noindex response for previously published URLs.
  // Server authorization, not robots.txt, keeps product data private.
  if (blankPublicPage(settings)) return { rules: [{ userAgent: "*", allow: "/" }] };
  return {
    rules: [{ userAgent: "*", disallow: "/", allow: ["/$", "/legal/", ...(featureOpen(settings, "feed") ? ["/dashboard$"] : []), ...(featureOpen(settings, "profiles") ? ["/creators/"] : []), ...(featureOpen(settings, "search") ? ["/search$", "/tag/"] : [])] }],
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
