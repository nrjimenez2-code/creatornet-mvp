import "./globals.css";
import type { Metadata, Viewport } from "next";
import ViewportFix from "@/components/ViewportFix";

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
    <html lang="en">
      <body className="bg-black text-white">
        <ViewportFix>{children}</ViewportFix>
      </body>
    </html>
  );
}
