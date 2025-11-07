// app/profile/page.tsx
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabaseServer";

export const revalidate = 0;                 // never cache
export const dynamic = "force-dynamic";      // always render fresh

export default async function ProfilePage() {
  const supabase = createServerClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) redirect("/auth");

  const { data: profile } = await supabase
    .from("profiles")
    .select("username, tagline, avatar_url")
    .eq("id", user.id)
    .single();

  const username = profile?.username ?? user.email?.split("@")[0] ?? "user";
  const tagline = profile?.tagline ?? "Add a short tagline to introduce yourself.";
  const avatar = profile?.avatar_url ?? "";

  return (
    <section className="px-6 pb-16">
      <header className="flex items-center justify-between pt-6">
        <div className="flex items-center gap-4">
          <div className="h-14 w-14 rounded-full bg-gray-200 overflow-hidden" />
          <div>
            <h1 className="text-lg font-semibold">{username}</h1>
            <p className="text-sm text-gray-500">{tagline}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <a
            href="/dashboard/analytics"
            className="rounded-full bg-gray-100 px-3 py-1 text-sm"
          >
            Analytics
          </a>
          <a
            href="/profile/edit"
            className="rounded-full bg-[#7F5CE6] px-4 py-1.5 text-sm text-white"
          >
            Edit Profile
          </a>
        </div>
      </header>

      {/* Skeleton grid */}
      <div className="mt-8 grid grid-cols-4 gap-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-56 rounded-xl bg-gray-100" />
        ))}
      </div>
    </section>
  );
}
