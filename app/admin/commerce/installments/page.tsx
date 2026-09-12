import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin/server";
import { exactAdminEnabled, readExactAdminPage } from "@/lib/installments/adminActions";
import { InstallmentReview } from "./InstallmentReview";

export const dynamic = "force-dynamic";

export default async function InstallmentReviewPage() {
  // Verify here as well as in the layout: server components can render in parallel.
  const { admin, user } = await requireAdmin();
  if (!exactAdminEnabled(process.env)) notFound();
  const initial = await readExactAdminPage(admin, user.id, null, process.env);
  return <InstallmentReview initial={initial} />;
}
