"use client";

import type { ReactNode } from "react";
import { AdminDataProvider } from "@/components/admin/AdminDataContext";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import { CommandPalette } from "@/components/admin/CommandPalette";
import { ToastProvider } from "@/components/admin/Toast";
import type { AdminInitialData } from "@/types/admin";

interface AdminShellProps {
  children: ReactNode;
  /** Server-fetched rows from the layout; omitted = self-contained mock demo. */
  initialData?: AdminInitialData;
}

/** Client chrome for /admin — the server layout owns auth and data fetching. */
export function AdminShell({ children, initialData }: AdminShellProps) {
  return (
    <ToastProvider>
      <AdminDataProvider initialData={initialData}>
        <div className="relative flex min-h-svh bg-[#faf8ff] text-gray-900 max-md:flex-col">
          {/* Ambient brand wash — the lavender identity from the auth page. */}
          <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 bg-[radial-gradient(1100px_520px_at_82%_-8%,rgba(147,112,219,0.11),transparent_60%),radial-gradient(900px_480px_at_-8%_108%,rgba(124,92,191,0.08),transparent_55%)]"
          />
          <AdminSidebar />
          <main className="relative min-w-0 flex-1 px-8 py-8 max-md:px-4 max-md:py-5">
            <div className="mx-auto w-full max-w-[1320px]">{children}</div>
          </main>
        </div>
        <CommandPalette />
      </AdminDataProvider>
    </ToastProvider>
  );
}
