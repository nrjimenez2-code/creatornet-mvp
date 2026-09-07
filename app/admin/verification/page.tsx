import { VerificationPageClient } from "./VerificationPageClient";
import { fetchVerificationRequests } from "./data";

// Live queue — never prerender or cache.
export const dynamic = "force-dynamic";

/**
 * Server container for /admin/verification. The layout has already gated on
 * profiles.role === 'admin', so the service-role fetch here is safe.
 */
export default async function VerificationPage() {
  const requests = await fetchVerificationRequests();
  return <VerificationPageClient requests={requests} />;
}
