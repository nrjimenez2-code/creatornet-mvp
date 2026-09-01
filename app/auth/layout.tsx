import type { Metadata } from "next";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in or create a free CreatorNet account to follow creators, scroll the feed, and buy their products, courses, and 1-on-1 calls.",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-svh bg-white text-gray-900">
      <BackButton />
      {children}
    </div>
  );
}
