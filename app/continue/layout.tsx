import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Continue watching",
  robots: { index: false, follow: false },
};

export default function ContinueLayout({ children }: { children: React.ReactNode }) {
  return children;
}
