import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const revalidate = 0 as const;

export default async function Home() {
  const supabase = await createSupabaseServer();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) redirect("/auth");

  const { data: profile } = await supabase
    .from("profiles")
    .select("username, interests")
    .eq("id", session.user.id)
    .maybeSingle();

  const username = profile?.username;
  const interests = Array.isArray(profile?.interests) ? profile!.interests : [];

  if (!username || interests.length === 0) {
    redirect("/onboarding");
  }

  redirect("/dashboard");
}
