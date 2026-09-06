import { notFound } from "next/navigation";
import type { Metadata } from "next";
import BackButton from "@/components/BackButton";
import ReviewForm from "@/components/ReviewForm";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { BadgeCheck } from "lucide-react";
import {
  getViewerReviewEligibility,
  isVerifiedPurchase,
  livePurchasesByReviewers,
  NO_PURCHASE_FROM_CREATOR_MESSAGE,
  UNTITLED_OFFER_LABEL,
} from "@/lib/reviewEligibility";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { creatorId } = await params;
  const id = creatorId?.trim();
  if (!id) return { title: "Reviews" };
  try {
    const byId = await supabaseAdmin
      .from("profiles")
      .select("username, full_name")
      .eq("id", id)
      .maybeSingle();
    const profile =
      byId.data ??
      (
        await supabaseAdmin
          .from("profiles")
          .select("username, full_name")
          .eq("username", id)
          .maybeSingle()
      ).data;
    const name = profile?.full_name || profile?.username;
    return {
      title: name ? `Reviews for ${name}` : "Reviews",
      description: name
        ? `What buyers say about ${name} on CreatorNet.`
        : "Creator reviews on CreatorNet.",
    };
  } catch {
    return { title: "Reviews" };
  }
}

type ReviewRecord = {
  id?: string;
  reviewer_id?: string;
  reviewer_name?: string | null;
  comment?: string | null;
  rating?: number | null;
  created_at?: string | null;
  /** The offer this review is about; null for rows written before 024. */
  post_id?: string | null;
  /** Title of that offer, when post_id is set. */
  offer_title?: string | null;
  /** Derived at read time from purchases; never stored on the review. */
  is_verified_purchase?: boolean;
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
      .select("id, reviewer_id, post_id, rating, comment, created_at")
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
  
  const reviewedPostIds = Array.from(
    new Set(
      ((reviewsRes?.data ?? []) as Array<{ post_id?: string | null }>)
        .map((r) => r.post_id)
        .filter((id): id is string => Boolean(id))
    )
  );

  const reviewerMap = new Map<string, { full_name: string | null; username: string | null }>();
  const offerTitleMap = new Map<string, string | null>();
  // "Verified Purchase" is derived from purchases at read time (a refund drops
  // it automatically): per offer for reviews that name one, per creator for
  // legacy rows (post_id null). The label and the offer title are cosmetic,
  // so a lookup error must not take the page down.
  const [reviewerProfilesRes, offerPostsRes, livePurchases, viewer] = await Promise.all([
    reviewerIds.length > 0
      ? admin.from("profiles").select("id, username, full_name").in("id", reviewerIds)
      : Promise.resolve({ data: null }),
    reviewedPostIds.length > 0
      ? admin.from("posts").select("id, title").in("id", reviewedPostIds)
      : Promise.resolve({ data: null }),
    livePurchasesByReviewers(admin, resolvedCreatorId, reviewerIds as string[]).catch((err) => {
      console.error("[creator-reviews] verified-purchase lookup error:", err);
      return [];
    }),
    getViewerReviewEligibility(admin, resolvedCreatorId),
  ]);

  if (offerPostsRes.data) {
    (offerPostsRes.data as Array<{ id: string; title: string | null }>).forEach((p) => {
      offerTitleMap.set(p.id, p.title ?? null);
    });
  }

  if (reviewerProfilesRes.data) {
    reviewerProfilesRes.data.forEach((p: any) => {
      reviewerMap.set(p.id, {
        full_name: p.full_name,
        username: p.username,
      });
    });
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
      post_id: r.post_id ?? null,
      offer_title: r.post_id ? offerTitleMap.get(r.post_id) ?? UNTITLED_OFFER_LABEL : null,
      is_verified_purchase: isVerifiedPurchase(livePurchases, r.reviewer_id, r.post_id ?? null),
    };
  });

  // Signed-out viewers keep the form (it renders its own sign-in note); the
  // creator sees nothing; a signed-in non-buyer gets the same one-line note
  // the route answers with. The route is the real gate — this only drives UI.
  const isViewerTheCreator = viewer.viewerId === resolvedCreatorId;
  const showReviewForm = viewer.viewerId === null || viewer.canReview;

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
          {/* resolvedCreatorId, not the raw route param: this page is reachable
              as /creators/<username>/reviews too, and posting a username into
              reviews.creator_id (a uuid column) failed the cast, so the review
              could never be submitted from a username URL. */}
          {showReviewForm ? (
            <ReviewForm creatorId={resolvedCreatorId} offers={viewer.purchasedPosts} />
          ) : isViewerTheCreator ? null : (
            <p className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-sm text-white/70">
              {NO_PURCHASE_FROM_CREATOR_MESSAGE}
            </p>
          )}
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
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-base font-semibold">{reviewerName}</p>
                        {review.is_verified_purchase ? (
                          <span
                            title={
                              review.post_id
                                ? "This reviewer bought this offer"
                                : "This reviewer bought from this creator"
                            }
                            className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
                          >
                            <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                            Verified Purchase
                          </span>
                        ) : null}
                      </div>
                      {review.offer_title ? (
                        <p className="text-xs text-white/60" data-testid="review-offer">
                          Reviewed: {review.offer_title}
                        </p>
                      ) : null}
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

