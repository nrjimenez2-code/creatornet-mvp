import { ReviewsPageClient } from "./ReviewsPageClient";
import { fetchRecentReviews } from "./data";
import { requireAdminPage } from "@/lib/admin/server";

// Live moderation data — never prerender or cache.
export const dynamic = "force-dynamic";

/**
 * Server container for /admin/reviews. The layout has already gated on
 * profiles.role === 'admin', so the service-role fetch here is safe.
 */
export default async function ReviewsPage() {
  await requireAdminPage();
  const reviews = await fetchRecentReviews();
  return <ReviewsPageClient initialReviews={reviews} />;
}
