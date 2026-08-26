import { AdminDataProvider } from "@/components/admin/AdminDataContext";
import { ContentPageClient } from "./ContentPageClient";
import { fetchContentInitialData } from "./data";

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
  const initialData = await fetchContentInitialData();
  return (
    <AdminDataProvider initialData={initialData}>
      <ContentPageClient />
    </AdminDataProvider>
  );
}
