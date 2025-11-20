import { notFound } from "next/navigation";
import Link from "next/link";
import BackButton from "@/components/BackButton";
import ProfileStarRating from "@/components/ProfileStarRating";
import ProfileShareButton from "@/components/ProfileShareButton";
import ProfilePostsGallery from "@/components/ProfilePostsGallery";
import { createServerClient } from "@/lib/supabaseServer";
import { createClient } from "@supabase/supabase-js";

export const revalidate = 0;
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ creatorId: string }>;
};

export default async function CreatorPublicProfilePage({ params }: Props) {
  const { creatorId } = await params;
  if (!creatorId) {
    notFound();
  }

  const supabase = createServerClient();
  const {
    data: { user: viewer },
  } = await supabase.auth.getUser();

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );

  const followStatusPromise =
    viewer?.id && viewer.id !== creatorId
      ? supabase
          .from("follows")
          .select("id")
          .eq("follower_id", viewer.id)
          .eq("following_id", creatorId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as const);

  const [profileRes, postsRes, followersRes, followingRes, ratingRes, followStatusRes] =
    await Promise.all([
      admin
        .from("profiles")
        .select("id, username, full_name, tagline, avatar_url, bio")
        .eq("id", creatorId)
        .maybeSingle(),
      admin
        .from("posts")
        .select("id, poster_url, video_url")
        .eq("creator_id", creatorId)
        .order("created_at", { ascending: false }),
      admin
        .from("follows")
        .select("id", { count: "exact", head: true })
        .eq("following_id", creatorId),
      admin
        .from("follows")
        .select("id", { count: "exact", head: true })
        .eq("follower_id", creatorId),
      admin.rpc("get_profile_rating", { p_profile_id: creatorId }),
      followStatusPromise,
    ]);

  if (profileRes.error || !profileRes.data) {
    notFound();
  }

  const profile = profileRes.data;
  const posts = postsRes?.data ?? [];
  const followersCount = followersRes?.count ?? 0;
  const followingCount = followingRes?.count ?? 0;
  const ratingData = ratingRes?.data?.[0] ?? null;

  const displayName =
    profile.full_name || profile.username || profile.id.slice(0, 8);
  const username = profile.username || "creator";
  const tagline = profile.tagline || null;
  const bio = profile.bio || "No bio yet.";
  const avatarUrl = profile.avatar_url || null;

  const rating = ratingData ? Number(ratingData.avg_rating ?? 0) : 0;
  const reviewCount = ratingData ? Number(ratingData.review_count ?? 0) : 0;
  const canFollow = false;

  return (
    <section className="px-4 pb-16 pt-10 text-white relative">
      <div className="max-w-6xl mx-auto">
        <div className="-ml-[4.5in]">
          <BackButton />
        </div>

        <div className="absolute top-10 left-4 z-10 translate-x-[18.5in]">
          <ProfileShareButton />
        </div>

        <div className="-mt-12 flex flex-col items-center text-center">
          <div className="h-64 w-64 rounded-full bg-white/10 overflow-hidden border border-white/20">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={`${username} avatar`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-5xl">
                🙋‍♂️
              </div>
            )}
          </div>

          <h1 className="mt-6 text-3xl font-semibold">{displayName}</h1>
          <p className="text-white/70">@{username}</p>
          {tagline ? <p className="mt-2 text-sm text-white/60">{tagline}</p> : null}
          <p className="mt-4 max-w-2xl text-sm text-white/80">{bio}</p>

          <div className="mt-6 w-full flex items-center justify-center gap-10 text-sm text-white/80">
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[425px]">
              <span className="text-lg font-semibold text-white">
                {posts.length}
              </span>
              posts
            </div>
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[415px]">
              <span className="text-lg font-semibold text-white">
                {followersCount}
              </span>
              followers
            </div>
            <div className="flex flex-col items-center gap-1 text-center min-w-[80px] translate-x-[415px]">
              <span className="text-lg font-semibold text-white">
                {followingCount}
              </span>
              following
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ProfileStarRating
                userId={creatorId}
                rating={rating}
                reviewCount={reviewCount}
              />
            </div>
          </div>

          {/* Follow button intentionally removed per latest spec */}
        </div>

        {posts.length === 0 ? (
          <p className="col-span-full text-center text-white/60">
            This creator hasn&apos;t posted yet.
          </p>
        ) : (
          <ProfilePostsGallery posts={posts} />
        )}
      </div>
    </section>
  );
}

