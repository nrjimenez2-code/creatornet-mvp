// app/profile/page.tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabaseServer";
import BackButton from "@/components/BackButton";
import ProfileShareButton from "@/components/ProfileShareButton";
import ProfileStarRating from "@/components/ProfileStarRating";
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

  const [{ data: profile }, postsRes, followersRes, followingRes, ratingRes] = await Promise.all([
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
      .select("id", { count: "exact", head: true })
      .eq("following_id", user.id),
    supabase
      .from("follows")
      .select("id", { count: "exact", head: true })
      .eq("follower_id", user.id),
    supabase.rpc("get_profile_rating", { p_profile_id: user.id }),
  ]);

  const posts = postsRes?.data ?? [];
  const postsCount = posts.length;
  const followersCount = followersRes?.count ?? 0;
  const followingCount = followingRes?.count ?? 0;
  const ratingData = ratingRes?.data?.[0] ?? null;

  const username = profile?.username || user.email?.split("@")[0] || "user";
  const displayName = profile?.full_name || user.user_metadata?.full_name || username;
  const tagline = profile?.tagline || null;
  const bio = profile?.bio || "Tell people about yourself.";
  const avatarUrl = profile?.avatar_url || null;
  const rating = ratingData ? Number(ratingData.avg_rating ?? 0) : 0;
  const reviewCount = ratingData ? Number(ratingData.review_count ?? 0) : 0;

  return (
    <section className="px-4 pb-16 pt-10 text-white relative">
      <div className="max-w-6xl mx-auto">
        <div className="-ml-[4.5in]">
          <BackButton />
        </div>

        <div className="absolute top-10 left-4 z-10 translate-x-[18.5in]">
          <ProfileShareButton />
        </div>
        <div className="absolute top-12 right-4 z-10 -translate-x-[0.79in]">
          <Link
            href="/profile/edit"
            className="rounded-md bg-[#7E5CE6] px-4 py-1 text-sm font-semibold text-white hover:brightness-95 transition border border-[#7E5CE6] flex items-center justify-center"
          >
            Edit profile
          </Link>
        </div>

        <div className="flex flex-col items-center text-center -mt-12">
          <div className="h-64 w-64 rounded-full bg-white/10 overflow-hidden border border-white/20">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={`${username} avatar`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-5xl">🙋‍♂️</div>
            )}
          </div>

          <h1 className="mt-6 text-3xl font-semibold">{displayName}</h1>
          <p className="text-white/70">@{username}</p>
          <p className="mt-2 text-sm text-white/60">{bio}</p>

          <div className="mt-6 w-full flex items-center justify-center gap-10 text-sm text-white/80">
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[425px]">
              <span className="text-lg font-semibold text-white">{postsCount}</span>
              posts
            </div>
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[415px]">
              <span className="text-lg font-semibold text-white">{followersCount}</span>
              followers
            </div>
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[415px]">
              <span className="text-lg font-semibold text-white">{followingCount}</span>
              following
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ProfileStarRating userId={user.id} rating={rating} reviewCount={reviewCount} />
            </div>
          </div>

        </div>

        {posts.length === 0 ? (
          <p className="col-span-full text-center text-white/60">
            You haven&apos;t posted yet. Share your first product or video!
          </p>
        ) : (
          <ProfilePostsGallery posts={posts} />
        )}

      </div>
    </section>
  );
}
