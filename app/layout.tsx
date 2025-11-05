// app/layout.tsx
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import SupabaseAuthSync from "@/components/SupabaseAuthSync";

export const metadata: Metadata = {
  title: "CreatorNet",
  description: "Scroll. Learn. Earn.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-white">
      <body className="min-h-svh bg-white text-gray-900 antialiased" suppressHydrationWarning>
        {/* Keep Supabase client + server sessions in sync */}
        <Suspense fallback={null}>
          <SupabaseAuthSync />
        </Suspense>

        {children}
      </body>
    </html>
  );
}
