import type { Metadata } from "next";
import BackButton from "@/components/BackButton";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Private sign-in for existing CreatorNet accounts.",
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-svh bg-white text-gray-900">
      <BackButton />
      {children}
    </div>
  );
}
