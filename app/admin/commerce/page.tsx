import { AdminDataProvider } from "@/components/admin/AdminDataContext";
import { fetchCommerceInitialData } from "@/lib/admin/commerce-data";
import { CommercePageClient } from "./CommercePageClient";
import { exactAdminEnabled } from "@/lib/installments/adminActions";
import Link from "next/link";
import { membershipAdminReady } from "@/lib/membershipAdmin";
import { buyerMentorshipAdminReady } from "@/lib/mentorshipInstallmentAdmin";
import { fullRefundReviewAdminReady } from "@/lib/fullRefundReviewAdmin";

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
      {fullRefundReviewAdminReady() && <Link href="/admin/commerce/full-refunds"
        className="mb-4 mr-5 inline-block text-sm font-semibold text-[#7c5cbf]">Review full-payment refunds →</Link>}
      {buyerMentorshipAdminReady() && <Link href="/admin/commerce/buyer-installments"
        className="mb-4 mr-5 inline-block text-sm font-semibold text-[#7c5cbf]">Review buyer installment billing →</Link>}
      {membershipAdminReady() && <Link href="/admin/commerce/memberships"
        className="mb-4 mr-5 inline-block text-sm font-semibold text-[#7c5cbf]">Review monthly billing →</Link>}
      {exactAdminEnabled(process.env) && <Link href="/admin/commerce/installments"
        className="mb-4 inline-block text-sm font-semibold text-[#7c5cbf]">Review staging installments →</Link>}
      <CommercePageClient />
    </AdminDataProvider>
  );
}
