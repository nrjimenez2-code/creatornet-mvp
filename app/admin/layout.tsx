import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { fetchAdminInitialData } from "@/lib/admin/data";
import { adminClient } from "@/lib/admin/server";
import { createServerClient } from "@/lib/supabaseServer";

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
    .select("role")
    .eq("id", user.id)
    .maybeSingle<{ role: string }>();
  if (profile?.role !== "admin") {
    redirect("/");
  }

  // Seed the client store with live rows (React-cached, shared with pages on
  // the same request). Passing initialData switches the provider out of demo
  // mode: actions now hit the real /api/admin/* routes.
  const initialData = await fetchAdminInitialData();

  return <AdminShell initialData={initialData}>{children}</AdminShell>;
}
