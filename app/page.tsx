import { redirect } from "next/navigation";
import { resolveOnboardingRedirect } from "@/lib/onboardingGate";
import LandingPage from "@/components/landing/LandingPage";
import "./landing.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  // One shared definition of "where does this user belong" — see
  // lib/onboardingGate.ts. It is unchanged; only what we do with its answer
  // for a visitor with no session is different.
  const target = await resolveOnboardingRedirect();

  // No session: this used to bounce straight to /auth, which meant the very
  // first thing anyone — a Stripe reviewer included — saw at creatornet.net
  // was a login wall with no description of the business, its prices or its
  // policies. That is a standard reason a Connect application is held. The
  // landing page is what a logged-out visitor sees instead; every button on
  // it leads to a real route.
  if (target === "/auth") return <LandingPage />;

  if (target) redirect(target);
  redirect("/dashboard");
}
