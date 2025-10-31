import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServer();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("username, interests")
      .eq("id", session.user.id)
      .maybeSingle();

    const username = profile?.username;
    const interests = Array.isArray(profile?.interests) ? profile!.interests : [];

    if (!username || interests.length === 0) {
      redirect("/onboarding");
    } else {
      redirect("/dashboard");
    }
  }

  return <>{children}</>;
}
