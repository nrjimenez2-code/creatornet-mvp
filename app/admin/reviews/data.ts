import "server-only";
import { adminClient } from "@/lib/admin/server";

/** Newest-first cap so the board never issues an unbounded scan. */
const MAX_REVIEWS = 200;

interface ReviewRow {
  id: string;
  reviewer_id: string | null;
  creator_id: string | null;
  rating: number | null;
  comment: string | null;
  created_at: string | null;
}

interface ProfileRow {
  id: string;
  username: string | null;
  full_name: string | null;
}

export interface AdminReviewPerson {
  id: string;
  username: string | null;
  fullName: string | null;
}

export interface AdminReview {
  id: string;
  rating: number;
  comment: string;
  createdAt: string | null;
  reviewer: AdminReviewPerson | null;
  creator: AdminReviewPerson | null;
}

/** Recent reviews joined with reviewer/creator display names (service role). */
export async function fetchRecentReviews(): Promise<AdminReview[]> {
  const admin = adminClient();

  const { data: rows, error } = await admin
    .from("reviews")
    .select("id, reviewer_id, creator_id, rating, comment, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_REVIEWS)
    .returns<ReviewRow[]>();

  if (error) {
    throw new Error(`reviews fetch failed: ${error.message}`);
  }

  const reviews = rows ?? [];
  const profileIds = Array.from(
    new Set(
      reviews
        .flatMap((r) => [r.reviewer_id, r.creator_id])
        .filter((id): id is string => Boolean(id))
    )
  );

  const profileMap = new Map<string, ProfileRow>();
  if (profileIds.length > 0) {
    const { data: profiles, error: profileError } = await admin
      .from("profiles")
      .select("id, username, full_name")
      .in("id", profileIds)
      .returns<ProfileRow[]>();

    if (profileError) {
      throw new Error(`profiles fetch failed: ${profileError.message}`);
    }
    for (const p of profiles ?? []) {
      profileMap.set(p.id, p);
    }
  }

  const person = (id: string | null): AdminReviewPerson | null => {
    if (!id) return null;
    const p = profileMap.get(id);
    return { id, username: p?.username ?? null, fullName: p?.full_name ?? null };
  };

  return reviews.map((r) => ({
    id: r.id,
    rating: typeof r.rating === "number" ? r.rating : 0,
    comment: r.comment ?? "",
    createdAt: r.created_at,
    reviewer: person(r.reviewer_id),
    creator: person(r.creator_id),
  }));
}
