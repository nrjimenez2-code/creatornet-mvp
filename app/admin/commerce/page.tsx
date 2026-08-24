import { AdminDataProvider } from "@/components/admin/AdminDataContext";
import { fetchCommerceInitialData } from "@/lib/admin/commerce-data";
import { CommercePageClient } from "./CommercePageClient";

// Money data must never come from a stale cache.
export const dynamic = "force-dynamic";

/**
 * Server container for /admin/commerce. Auth is enforced by the admin layout
 * gate above; this fetches real orders/bookings with the service-role client
 * and seeds a page-scoped AdminDataProvider (nearest-provider wins, so the
 * page's client tree reads these rows instead of the layout's demo seed).
 */
export default async function CommercePage() {
  const initialData = await fetchCommerceInitialData();
  return (
    <AdminDataProvider initialData={initialData}>
      <CommercePageClient />
    </AdminDataProvider>
  );
}
