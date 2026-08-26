import { OverviewPage } from "@/components/admin/OverviewPage";
import { buildRecentActivity, fetchAdminInitialData } from "@/lib/admin/data";

// Live Supabase reads on every request — never prerender with stale (or
// build-time fake-env) data.
export const dynamic = "force-dynamic";

/**
 * Server container for the Overview page. The layout has already gated for
 * admin and seeded AdminShell with the same cached fetch, so this call is a
 * per-request dedupe hit, not a second round trip.
 */
export default async function AdminOverviewRoute() {
  const initialData = await fetchAdminInitialData();
  return <OverviewPage activity={buildRecentActivity(initialData)} />;
}
