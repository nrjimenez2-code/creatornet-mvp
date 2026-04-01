import { notFound } from "next/navigation";
import BackButton from "@/components/BackButton";
import ReviewForm from "@/components/ReviewForm";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";

export const revalidate = 0;
export const dynamic = "force-dynamic";

type ReviewRecord = {
  id?: string;
  reviewer_id?: string;
  reviewer_name?: string | null;
  comment?: string | null;
  rating?: number | null;
  created_at?: string | null;
};

type RatingPayload = {
  avg_rating?: number | null;
  review_count?: number | null;
  reviews?: ReviewRecord[];
};

type ProfileRecord = {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  bio: string | null;
};

type PageProps = {
  params: Promise<{ creatorId: string }>;
};

export default async function CreatorReviewsPage({ params }: PageProps) {
  const { creatorId: rawCreatorId } = await params;
  const creatorId = rawCreatorId?.trim();
  if (!creatorId) {
    notFound();
  }

  const SUPABASE_URL =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) environment variable."
    );
  }
  if (!SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Try profile by id first. If missing, fallback by username so links like /creators/<username>/reviews also work.
  const fetchProfileById = async () =>
    admin
      .from("profiles")
      .select("id, username, full_name, avatar_url, bio")
      .eq("id", creatorId)
      .maybeSingle();

  let profileRes = await fetchProfileById();
  let profile = profileRes.data as ProfileRecord | null;
  let profileError = profileRes.error;

  // Local dev can intermittently return transient errors; retry once.
  if (profileError && profileError.code !== "PGRST116") {
    profileRes = await fetchProfileById();
    profile = (profileRes.data as ProfileRecord | null) ?? profile;
    profileError = profileRes.error ?? null;
  }

  if (!profile) {
    const byUsernameRes = await admin
      .from("profiles")
      .select("id, username, full_name, avatar_url, bio")
      .eq("username", creatorId)
      .maybeSingle();
    if (byUsernameRes.data) {
      profile = byUsernameRes.data as ProfileRecord;
    }
  }

  const creatorProfileHref = `/creators/${profile?.id ?? creatorId}`;

  if (profileError && profileError.code !== "PGRST116") {
    console.error("[creator-reviews] profile lookup error:", profileError);
    return (
      <section className="px-4 pb-16 pt-10 text-white relative">
        <div className="max-w-3xl mx-auto">
          <div className="absolute top-4 left-4 z-10 translate-x-[0.0001in]">
            <BackButton hrefOverride={creatorProfileHref} preferHistory />
          </div>
          <div className="mt-16 rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
            <h1 className="text-xl font-semibold">Unable to load reviews right now</h1>
            <p className="mt-2 text-sm text-white/70">
              This usually happens due to a temporary local data/session issue. Please refresh and try again.
            </p>
          </div>
        </div>
      </section>
    );
  }

  // Do not 404 when profile row is temporarily unavailable; render a safe fallback shell instead.
  const resolvedCreatorId = profile?.id ?? creatorId;

  const [ratingRes, reviewsRes] = await Promise.all([
    admin.rpc("get_profile_rating", { p_profile_id: resolvedCreatorId }),
    admin
      .from("reviews")
      .select("id, reviewer_id, rating, comment, created_at")
      .eq("creator_id", resolvedCreatorId)
      .order("created_at", { ascending: false }),
  ]);

  const ratingData = (ratingRes?.data?.[0] ?? null) as RatingPayload | null;
  const avgRating = ratingData ? Number(ratingData.avg_rating ?? 0) : 0;
  const reviewCount = ratingData ? Number(ratingData.review_count ?? 0) : 0;
  
  // Fetch reviewer profiles separately to avoid foreign key issues
  const reviewerIds = Array.from(
    new Set((reviewsRes?.data ?? []).map((r: any) => r.reviewer_id).filter(Boolean))
  );
  
  const reviewerMap = new Map<string, { full_name: string | null; username: string | null }>();
  if (reviewerIds.length > 0) {
    const { data: reviewerProfiles } = await admin
      .from("profiles")
      .select("id, username, full_name")
      .in("id", reviewerIds);
    
    if (reviewerProfiles) {
      reviewerProfiles.forEach((p: any) => {
        reviewerMap.set(p.id, {
          full_name: p.full_name,
          username: p.username,
        });
      });
    }
  }
  
  // Map reviews from database with reviewer info
  const reviews: ReviewRecord[] = (reviewsRes?.data ?? []).map((r: any) => {
    const reviewer = reviewerMap.get(r.reviewer_id);
    return {
      id: r.id,
      reviewer_id: r.reviewer_id,
      reviewer_name: reviewer?.full_name || reviewer?.username || null,
      comment: r.comment,
      rating: r.rating,
      created_at: r.created_at,
    };
  });

  return (
    <section className="px-4 pb-16 pt-10 text-white relative">
      <div className="max-w-6xl mx-auto">
        <div className="absolute top-4 left-4 z-10 translate-x-[0.0001in]">
          <BackButton hrefOverride={creatorProfileHref} preferHistory />
        </div>

        <div className="flex flex-col items-center text-center">
          <div className="h-28 w-28 overflow-hidden rounded-full border border-white/15 bg-white/5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={profile?.avatar_url || DEFAULT_AVATAR_URL}
              alt={`${profile?.username || "creator"} avatar`}
              className="h-full w-full object-cover"
            />
          </div>

          <h1 className="mt-4 text-2xl font-semibold">
            Reviews for {profile?.full_name || profile?.username || "creator"}
          </h1>
          <p className="text-sm text-white/60">
            {profile?.bio || "No bio information yet."}
          </p>
        </div>

        <div className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
          <p className="text-sm uppercase tracking-widest text-white/60">
            Overall rating
          </p>
          <p className="mt-3 text-5xl font-semibold">{avgRating.toFixed(1)}</p>
          <p className="text-white/60">
            Based on {reviewCount} review{reviewCount === 1 ? "" : "s"}
          </p>
        </div>

        {/* Review Form */}
        <div className="mt-10">
          <ReviewForm creatorId={creatorId} />
        </div>

        <div className="mt-10 space-y-4">
          {reviews.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/20 bg-white/5 p-6 text-center text-sm text-white/70">
              No written reviews yet.
            </div>
          ) : (
            reviews.map((review, idx) => {
              const reviewerName =
                review.reviewer_name ||
                (review.reviewer_id
                  ? `User ${review.reviewer_id.slice(0, 6)}`
                  : "Anonymous");
              const createdAt = review.created_at
                ? new Date(review.created_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                : null;
              const score =
                review.rating !== null && review.rating !== undefined
                  ? Number(review.rating).toFixed(1)
                  : "—";

              return (
                <article
                  key={review.id ?? `${idx}-${review.reviewer_id ?? "anon"}`}
                  className="rounded-2xl border border-white/10 bg-white/5 p-5"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-base font-semibold">{reviewerName}</p>
                      {createdAt ? (
                        <p className="text-xs uppercase tracking-wide text-white/50">
                          {createdAt}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-0.5">
                        {[1, 2, 3, 4, 5].map((star) => {
                          const isActive = (review.rating ?? 0) >= star;
                          return (
                            <svg
                              key={star}
                              viewBox="0 0 24 24"
                              className={`h-4 w-4 ${
                                isActive
                                  ? "fill-[#4A35C7] text-[#4A35C7]"
                                  : "fill-none text-gray-500"
                              }`}
                              aria-hidden="true"
                            >
                              <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.86L12 17.77l-6.18 3.23L7 14.14l-5-4.87 6.91-1.01L12 2z" />
                            </svg>
                          );
                        })}
                      </div>
                      <span className="text-sm font-semibold text-[#4A35C7]">{score}</span>
                    </div>
                  </div>
                  {review.comment ? (
                    <p className="mt-3 text-sm leading-relaxed text-white/80">
                      {review.comment}
                    </p>
                  ) : null}
                </article>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

