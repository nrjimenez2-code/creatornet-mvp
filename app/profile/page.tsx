// app/profile/page.tsx
import { redirect } from "next/navigation";
import Link from "next/link";
import { createServerClient } from "@/lib/supabaseServer";
import BackButton from "@/components/BackButton";
import ProfileShareButton from "@/components/ProfileShareButton";
import ProfileStarRating from "@/components/ProfileStarRating";

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
    <section className="px-4 pb-16 pt-10 text-white">
      <div className="max-w-6xl mx-auto">
        <BackButton />

        <div className="flex justify-end gap-3">
          <ProfileShareButton />
          <Link
            href="/profile/edit"
            className="rounded-full bg-[#7F5CE6] px-4 py-2 text-sm font-semibold text-white hover:bg-[#6b4fd9] transition"
          >
            Edit profile
          </Link>
        </div>

        <div className="mt-4 flex flex-col items-center text-center">
          <div className="h-44 w-44 rounded-full bg-white/10 overflow-hidden border border-white/20 shadow-[0_0_60px_rgba(127,92,230,0.35)]">
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
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[390px]">
              <span className="text-lg font-semibold text-white">{postsCount}</span>
              posts
            </div>
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[395px]">
              <span className="text-lg font-semibold text-white">{followersCount}</span>
              followers
            </div>
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[400px]">
              <span className="text-lg font-semibold text-white">{followingCount}</span>
              following
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ProfileStarRating userId={user.id} rating={rating} reviewCount={reviewCount} />
            </div>
          </div>

        </div>

          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {posts.length === 0 ? (
            <p className="col-span-full text-center text-white/60">
              You haven&apos;t posted yet. Share your first product or video!
            </p>
          ) : (
            posts.map((post) => (
              <Link
                key={post.id}
                href={{
                  pathname: `/watch/${post.id}`,
                  query: { fromProfile: "1" },
                }}
                scroll={false}
                className="group relative flex aspect-square items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black/30 transition hover:border-white/40"
              >
                {post.poster_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={post.poster_url}
                    alt="Post thumbnail"
                    className="h-full w-full object-cover transition group-hover:scale-105"
                    loading="lazy"
                  />
                ) : post.video_url ? (
                  <video
                    src={post.video_url}
                    className="h-full w-full object-cover transition group-hover:scale-105"
                    muted
                    loop
                    playsInline
                  />
                ) : (
                  <div className="text-xs text-white/50">No media</div>
                )}
              </Link>
            ))
          )}
        </div>

      </div>
    </section>
  );
}
