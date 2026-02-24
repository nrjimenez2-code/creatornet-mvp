// app/profile/page.tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
import { createServerClient } from "@/lib/supabaseServer";
import BackButton from "@/components/BackButton";
import ProfileShareButton from "@/components/ProfileShareButton";
import ProfilePostsGallery from "@/components/ProfilePostsGallery";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const supabase = createServerClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();

  if (userErr || !user) redirect("/auth");

  const [{ data: profile }, postsRes, followersRes, followingRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, username, full_name, tagline, avatar_url, bio")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("posts")
      .select("id, poster_url, video_url")
      .eq("creator_id", user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("follows")
      .select("follower_id", { count: "exact", head: true })
      .eq("following_id", user.id),
    supabase
      .from("follows")
      .select("following_id", { count: "exact", head: true })
      .eq("follower_id", user.id),
  ]);

  const posts = postsRes?.data ?? [];
  const postsCount = posts.length;
  const followersCount = followersRes?.count ?? 0;
  const followingCount = followingRes?.count ?? 0;

  const username = profile?.username || user.email?.split("@")[0] || "user";
  const displayName = profile?.full_name || user.user_metadata?.full_name || username;
  const tagline = profile?.tagline || null;
  const bio = profile?.bio || "Tell people about yourself.";
  const avatarUrl = profile?.avatar_url || null;

  return (
    <section className="px-4 pb-16 pt-4 md:pt-10 text-white relative">
      <div className="max-w-6xl mx-auto">
        {/* Mobile: Back button + actions in header row */}
        <div className="flex md:hidden items-center justify-between mb-6">
          <BackButton hrefOverride="/dashboard" />
          <div className="flex items-center gap-2">
            <Link
              href={`/creators/${user.id}/reviews`}
              className="inline-flex items-center justify-center rounded-md border border-white/20 px-3 py-1 text-xs font-semibold leading-none text-white hover:bg-white/10 transition"
            >
              Review
            </Link>
            <ProfileShareButton />
            <Link
              href="/profile/edit"
              className="rounded-md bg-[#4A35C7] px-3 py-1 text-xs font-semibold text-white hover:brightness-95 transition border border-[#4A35C7] flex items-center justify-center"
            >
              Edit profile
            </Link>
          </div>
        </div>

        {/* Desktop: Absolute positioned (original) */}
        <div className="hidden md:block absolute top-4 left-4 z-10">
          <BackButton hrefOverride="/dashboard" />
        </div>
        <div className="hidden md:flex absolute top-4 right-16 sm:right-32 z-10 items-center gap-2">
          <Link
            href={`/creators/${user.id}/reviews`}
            className="inline-flex items-center justify-center rounded-md border border-white/20 px-3 py-1 text-xs sm:text-sm font-semibold leading-none text-white hover:bg-white/10 transition"
          >
            Review
          </Link>
          <ProfileShareButton />
        </div>
        <div className="hidden md:block absolute top-4 right-4 z-10">
          <Link
            href="/profile/edit"
            className="rounded-md bg-[#4A35C7] px-3 sm:px-4 py-1 text-xs sm:text-sm font-semibold text-white hover:brightness-95 transition border border-[#4A35C7] flex items-center justify-center"
          >
            Edit profile
          </Link>
        </div>

        <div className="flex flex-col items-center text-center mt-0 md:mt-8">
          <div className="h-32 w-32 sm:h-40 sm:w-40 md:h-48 md:w-48 rounded-full bg-white/10 overflow-hidden border border-white/20">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarUrl || DEFAULT_AVATAR_URL}
              alt={`${username} avatar`}
              className="h-full w-full object-cover"
            />
          </div>

          <h1 className="mt-4 sm:mt-6 text-2xl sm:text-3xl font-semibold">{displayName}</h1>
          <p className="text-white/70 text-sm sm:text-base">@{username}</p>
          <p className="mt-2 text-sm text-white/60 max-w-md">{bio}</p>

          {/* Stats row - responsive layout */}
          <div className="mt-6 w-full max-w-2xl px-4 md:ml-[11rem] md:-translate-x-20">
            <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 md:gap-10 text-sm text-white/80">
              <div className="flex flex-col items-center gap-1 text-center min-w-[70px]">
                <span className="text-lg font-semibold text-white">{postsCount}</span>
                <span className="text-xs sm:text-sm">posts</span>
              </div>
              <div className="flex flex-col items-center gap-1 text-center min-w-[70px]">
                <span className="text-lg font-semibold text-white">{followersCount}</span>
                <span className="text-xs sm:text-sm">followers</span>
              </div>
              <div className="flex flex-col items-center gap-1 text-center min-w-[70px]">
                <span className="text-lg font-semibold text-white">{followingCount}</span>
                <span className="text-xs sm:text-sm">following</span>
              </div>
            </div>
          </div>

        </div>

        {posts.length === 0 ? (
          <p className="col-span-full text-center text-white/60 mt-6">
            You haven&apos;t posted yet. Share your first product or video!
          </p>
        ) : (
          <div className="mt-5.5">
            <ProfilePostsGallery posts={posts} />
          </div>
        )}

      </div>
    </section>
  );
}
