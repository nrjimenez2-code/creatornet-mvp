import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Your library",
  robots: { index: false, follow: false },
};

export default function LibraryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
