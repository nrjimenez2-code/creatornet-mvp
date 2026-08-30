import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Search",
  description: "Search creators, videos, and topics on CreatorNet.",
};

export default function SearchLayout({ children }: { children: React.ReactNode }) {
  return children;
}
