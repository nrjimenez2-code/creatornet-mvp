import { redirect } from "next/navigation";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { hasPrivateAccess, loadReleaseSettings } from "@/lib/release/server";
import PrivateSignOut from "@/components/PrivateSignOut";
import Link from "next/link";
export const dynamic = "force-dynamic";
export const metadata = { title: "Private access", robots: { index: false, follow: false } };
export default async function PrivateAccess() {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/auth?next=%2Fprivate-access");
  if (await hasPrivateAccess(user, await loadReleaseSettings())) redirect("/dashboard");
  return <main className="min-h-svh bg-white p-8 text-gray-900"><h1 className="text-3xl font-bold">CreatorNet is coming soon</h1><p className="my-6">You are signed in. Private product access requires owner approval.</p><div className="flex gap-6"><Link className="underline" href="/library" prefetch={false}>Your purchases</Link><Link className="underline" href="/legal/support" prefetch={false}>Support</Link><PrivateSignOut /></div></main>;
}
