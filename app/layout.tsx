// app/layout.tsx
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import SupabaseAuthSync from "@/components/SupabaseAuthSync";
import { UserProvider } from "@/lib/useUser";
import PostHogProvider from "@/components/PostHogProvider";
import CookieNotice from "@/components/CookieNotice";
import { getSiteUrl } from "@/lib/siteUrl";

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: "CreatorNet — Scroll. Learn. Earn.",
    template: "%s · CreatorNet",
  },
  description:
    "Short-form video from creators who teach. Watch, follow, and buy their products, courses, and 1-on-1 calls.",
  applicationName: "CreatorNet",
  openGraph: {
    siteName: "CreatorNet",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-black" data-scroll-behavior="smooth">
      <body className="min-h-svh bg-black text-gray-900 antialiased" suppressHydrationWarning>
        <PostHogProvider>
          <UserProvider>
            {/* Keep Supabase client + server sessions in sync */}
            <Suspense fallback={null}>
              <SupabaseAuthSync />
            </Suspense>

            {children}
            <CookieNotice />
          </UserProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
