import { notFound } from "next/navigation";
import Link from "next/link";
import BackButton from "@/components/BackButton";
import ProfileShareButton from "@/components/ProfileShareButton";
import ProfilePostsGallery from "@/components/ProfilePostsGallery";
import FollowButton from "@/components/FollowButton";
import { createServerClient } from "@/lib/supabaseServer";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
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

  let profileRes = await admin
    .from("profiles")
    .select("id, username, full_name, tagline, avatar_url, bio")
    .eq("id", creatorId)
    .maybeSingle();

  // Allow /creators/<username> in addition to /creators/<id>.
  if (!profileRes.data) {
    const usernameRes = await admin
      .from("profiles")
      .select("id, username, full_name, tagline, avatar_url, bio")
      .eq("username", creatorId)
      .maybeSingle();
    if (usernameRes.data) {
      profileRes = usernameRes as typeof profileRes;
    }
  }

  if (profileRes.error || !profileRes.data) {
    notFound();
  }

  const profile = profileRes.data;
  const resolvedCreatorId = profile.id;

  const followStatusPromise =
    viewer?.id && viewer.id !== resolvedCreatorId
      ? supabase
          .from("follows")
          .select("follower_id, following_id")
          .eq("follower_id", viewer.id)
          .eq("following_id", resolvedCreatorId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as const);

  const [postsRes, followersRes, followingRes, followStatusRes] = await Promise.all([
    admin
      .from("posts")
      .select("id, poster_url, video_url")
      .eq("creator_id", resolvedCreatorId)
      .order("created_at", { ascending: false }),
    admin
      .from("follows")
      .select("follower_id", { count: "exact", head: true })
      .eq("following_id", resolvedCreatorId),
    admin
      .from("follows")
      .select("following_id", { count: "exact", head: true })
      .eq("follower_id", resolvedCreatorId),
    followStatusPromise,
  ]);
  const posts = postsRes?.data ?? [];
  const followersCount = followersRes?.count ?? 0;
  const followingCount = followingRes?.count ?? 0;

  const displayName =
    profile.full_name || profile.username || profile.id.slice(0, 8);
  const username = profile.username || "creator";
  const tagline = profile.tagline || null;
  const bio = profile.bio || "No bio yet.";
  const avatarUrl = profile.avatar_url || null;

  const isFollowing = !!followStatusRes?.data;
  const canFollow = viewer?.id && viewer.id !== creatorId;

  return (
    <section className="px-4 pb-16 pt-4 md:pt-10 text-white relative">
      <div className="max-w-6xl mx-auto">
        {/* Mobile: Back button + share in header row */}
        <div className="flex md:hidden items-center justify-between mb-6">
          <BackButton hrefOverride="/dashboard" />
          <div className="flex items-center gap-2">
            <Link
              href={`/creators/${resolvedCreatorId}/reviews`}
              className="inline-flex items-center justify-center rounded-md border border-white/20 px-3 py-1 text-xs font-semibold leading-none text-white hover:bg-white/10 transition"
            >
              Review
            </Link>
            <ProfileShareButton />
          </div>
        </div>

        {/* Desktop: Absolute positioned (original) */}
        <div className="hidden md:block absolute top-4 left-4 z-10">
          <BackButton hrefOverride="/dashboard" />
        </div>
        <div className="hidden md:flex absolute top-4 right-4 z-10 items-center gap-2">
          <Link
            href={`/creators/${resolvedCreatorId}/reviews`}
            className="inline-flex items-center justify-center rounded-md border border-white/20 px-3 py-1 text-xs sm:text-sm font-semibold leading-none text-white hover:bg-white/10 transition"
          >
            Review
          </Link>
          <ProfileShareButton />
        </div>

        <div className="flex flex-col items-center text-center mt-0 md:-mt-12 md:translate-y-8">
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
          {tagline ? <p className="mt-2 text-sm text-white/60">{tagline}</p> : null}
          <p className="mt-2 text-sm text-white/60 max-w-md">{bio}</p>

          {/* Stats row - responsive layout; desktop: shift right a little */}
          <div className="mt-6 w-full max-w-2xl px-4">
            <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 md:gap-10 text-sm text-white/80">
              <div className="flex flex-col items-center gap-1 text-center min-w-[70px]">
                <span className="text-lg font-semibold text-white">
                  {posts.length}
                </span>
                <span className="text-xs sm:text-sm">posts</span>
              </div>
              <div className="flex flex-col items-center gap-1 text-center min-w-[70px]">
                <span className="text-lg font-semibold text-white">
                  {followersCount}
                </span>
                <span className="text-xs sm:text-sm">followers</span>
              </div>
              <div className="flex flex-col items-center gap-1 text-center min-w-[70px]">
                <span className="text-lg font-semibold text-white">
                  {followingCount}
                </span>
                <span className="text-xs sm:text-sm">following</span>
              </div>
            </div>
          </div>

          {/* Follow button centered on all screen sizes */}
          {canFollow && (
            <div className="mt-4 mb-3 flex justify-center">
              <FollowButton creatorId={resolvedCreatorId} initialFollowing={isFollowing} />
            </div>
          )}
        </div>

        {posts.length === 0 ? (
          <p className="col-span-full text-center text-white/60 mt-6">
            This creator hasn&apos;t posted yet.
          </p>
        ) : (
          <div className="mt-6 md:mt-8">
            <ProfilePostsGallery posts={posts} />
          </div>
        )}
      </div>
    </section>
  );
}

