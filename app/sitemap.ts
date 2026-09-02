import type { MetadataRoute } from "next";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSiteUrl } from "@/lib/siteUrl";

export const revalidate = 3600;

const MAX_POST_ROWS = 5000;

// Public, crawlable routes only. Never list account, checkout or admin URLs.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = getSiteUrl();

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${site}/`, changeFrequency: "daily", priority: 1 },
    { url: `${site}/dashboard`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${site}/search`, changeFrequency: "daily", priority: 0.6 },
    { url: `${site}/auth`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${site}/legal/terms`, changeFrequency: "monthly", priority: 0.2 },
    { url: `${site}/legal/privacy`, changeFrequency: "monthly", priority: 0.2 },
    { url: `${site}/legal/cookies`, changeFrequency: "monthly", priority: 0.2 },
    { url: `${site}/legal/refunds`, changeFrequency: "monthly", priority: 0.2 },
    { url: `${site}/legal/delivery`, changeFrequency: "monthly", priority: 0.2 },
    { url: `${site}/legal/creators`, changeFrequency: "monthly", priority: 0.2 },
    { url: `${site}/legal/support`, changeFrequency: "monthly", priority: 0.3 },
  ];

  // Creator pages are the indexable long tail — but only creators who have
  // actually posted. Listing every profile would leak usernames of accounts
  // that never published anything.
  try {
    const { data: posts, error: postsError } = await supabaseAdmin
      .from("posts")
      .select("creator_id")
      .is("hidden_at", null)
      .is("removed_at", null)
      .limit(MAX_POST_ROWS);
    if (postsError || !posts) {
      console.error("[sitemap] posts query failed, serving static entries:", postsError);
      return staticEntries;
    }

    const creatorIds = [...new Set(posts.map((p) => p.creator_id).filter(Boolean))];
    if (creatorIds.length === 0) return staticEntries;

    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from("profiles")
      .select("username")
      .in("id", creatorIds);
    if (profilesError || !profiles) {
      console.error("[sitemap] profiles query failed, serving static entries:", profilesError);
      return staticEntries;
    }

    const creatorEntries: MetadataRoute.Sitemap = profiles
      .filter((p): p is { username: string } => typeof p.username === "string" && p.username.length > 0)
      .map((p) => ({
        url: `${site}/creators/${encodeURIComponent(p.username)}`,
        changeFrequency: "daily",
        priority: 0.7,
      }));

    return [...staticEntries, ...creatorEntries];
  } catch (err) {
    console.error("[sitemap] creator lookup threw, serving static entries:", err);
    return staticEntries;
  }
}
