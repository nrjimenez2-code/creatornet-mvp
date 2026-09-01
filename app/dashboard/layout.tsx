import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { resolveOnboardingRedirect } from "@/lib/onboardingGate";

export const metadata: Metadata = {
  title: "Feed",
  description:
    "Scroll short videos from creators who teach — and buy their products, courses, and 1-on-1 calls.",
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // The onboarding gate used to exist ONLY on "/", so anything that landed
  // somewhere else walked straight past it. The app's own Share button is
  // exactly that: components/VideoCard.tsx copies
  // `${origin}/dashboard?postId=…`, so someone following a shared post signs up
  // and arrives here having never been asked for a username or an interest.
  // 35 of 47 accounts in production have no profile row at all.
  const target = await resolveOnboardingRedirect();

  // Only the incomplete-profile case is enforced here, NOT the signed-out case.
  //
  // /dashboard already handles a signed-out visitor on the client, and this
  // layout now runs a server-side session read on every feed load. If that read
  // ever comes back empty for a transient reason, redirecting would throw a
  // real, signed-in user off the feed. Sending an incomplete profile to
  // /onboarding is safe in a way that bouncing to /auth is not, so this gate
  // is strictly additive: it can only ever add the redirect that "/" already
  // performs.
  if (target === "/onboarding") redirect(target);

  return children;
}
