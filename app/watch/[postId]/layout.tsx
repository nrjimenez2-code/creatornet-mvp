import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Watch",
  robots: { index: false, follow: false },
};

export default function WatchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
