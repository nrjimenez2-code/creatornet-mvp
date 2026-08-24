import { fetchAdminUsers } from "@/lib/admin/users-data";
import type { AdminInitialData } from "@/types/admin";
import { UsersPageClient } from "./UsersPageClient";

// Moderation data must never be served stale from a build-time render.
export const dynamic = "force-dynamic";

/**
 * Server container for /admin/users. The layout has already verified the
 * caller is an admin, so this fetches with the service-role client and seeds
 * the page's provider. Only the users slice is real here — the other slices
 * seed empty until their own pages/layout wire them up.
 */
export default async function AdminUsersPage() {
  const users = await fetchAdminUsers();
  const initialData: AdminInitialData = {
    users,
    videos: [],
    orders: [],
    bookings: [],
  };
  return <UsersPageClient initialData={initialData} />;
}
