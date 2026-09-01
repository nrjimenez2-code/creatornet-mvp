import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/siteUrl";

// Crawl policy: public surfaces only. Everything account-bound, transactional
// or admin-facing is disallowed. /dashboard (the public discover feed) and
// /auth (the effective landing page — / redirects there) stay crawlable.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/admin",
          "/access/",
          "/library",
          "/onboarding",
          "/profile",
          "/watch/",
          "/success",
          "/cancel",
          "/continue",
          "/dashboard/analytics",
          "/dashboard/closers",
        ],
      },
    ],
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
