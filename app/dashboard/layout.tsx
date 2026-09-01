import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Feed",
  description:
    "Scroll short videos from creators who teach — and buy their products, courses, and 1-on-1 calls.",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
