import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { fetchAdminInitialData } from "@/lib/admin/data";
import { adminClient } from "@/lib/admin/server";
import { createServerClient } from "@/lib/supabaseServer";
import { paymentModeFromKey } from "@/lib/admin/display-context";
import { AdminFrameSkeleton } from "@/components/loading/Skeletons";

export const metadata: Metadata = {
  title: "CreatorNet Admin",
  description: "CreatorNet Launch Board",
  robots: { index: false, follow: false },
};

/**
 * Server auth gate for every /admin page: signed-in Supabase session, then
 * profiles.role === 'admin' checked with the service-role client (RLS-proof).
 * Non-admins never render the shell. API routes re-check via requireAdmin() —
 * this gate protects pages, not endpoints.
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = createServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    redirect("/auth");
  }

  const { data: profile } = await adminClient()
    .from("profiles")
    .select("role, username, full_name")
    .eq("id", user.id)
    .maybeSingle<{ role: string; username: string | null; full_name: string | null }>();
  if (profile?.role !== "admin") {
    redirect("/");
  }

  return <Suspense fallback={<AdminFrameSkeleton />}><AdminDataShell
    operatorName={profile.full_name?.trim() || profile.username?.trim() || "Administrator"}
    paymentMode={paymentModeFromKey(process.env.STRIPE_SECRET_KEY)}
  >{children}</AdminDataShell></Suspense>;
}

async function AdminDataShell({ children, operatorName, paymentMode }: {
  children: ReactNode;
  operatorName: string;
  paymentMode: ReturnType<typeof paymentModeFromKey>;
}) {
  // Only authorized admins reach this fetch or its skeleton. The cached result
  // is shared with page data and never replaced by sample/demo rows.
  const initialData = await fetchAdminInitialData();
  return <AdminShell initialData={initialData} operatorName={operatorName} paymentMode={paymentMode}>{children}</AdminShell>;
}
