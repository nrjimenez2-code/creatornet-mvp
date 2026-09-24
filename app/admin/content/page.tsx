import { AdminDataProvider } from "@/components/admin/AdminDataContext";
import { ContentPageClient } from "./ContentPageClient";
import { fetchContentInitialData } from "./data";
import { fetchAdminReportsPage } from "@/lib/admin/reports";

// Live moderation data — never prerender or cache.
export const dynamic = "force-dynamic";

/**
 * Server container for /admin/content. The layout has already gated on
 * profiles.role === 'admin', so the service-role fetch here is safe.
 *
 * The nested AdminDataProvider seeds this page's subtree with real rows
 * (seeded mode: optimistic updates + POST /api/admin/*). Nearest provider
 * wins for useAdminData, so it shadows the layout-level provider; the shell's
 * ToastProvider above still serves the toasts.
 */
export default async function ContentPage() {
  const [initialData, initialReports] = await Promise.all([fetchContentInitialData(), fetchAdminReportsPage("open", 0)]);
  return (
    <AdminDataProvider key={initialData.asOf} initialData={initialData}>
      <ContentPageClient initialReports={initialReports} />
    </AdminDataProvider>
  );
}
