import { redirect } from "next/navigation";
import { resolveOnboardingRedirect } from "@/lib/onboardingGate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  // The check itself now lives in lib/onboardingGate.ts, shared with
  // app/dashboard/layout.tsx so the two cannot drift apart.
  const target = await resolveOnboardingRedirect();
  if (target) redirect(target);

  redirect("/dashboard");
}
