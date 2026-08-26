import "server-only";
import { adminClient } from "@/lib/admin/server";
import type { AdminInitialData, AdminVideo, VideoStatus } from "@/types/admin";

/** Newest-first cap so the moderation board never issues an unbounded scan. */
const MAX_POSTS = 500;

/** Shown when a legacy row predates the epoch that timestamps were backfilled. */
const EPOCH_ISO = new Date(0).toISOString();

/** Columns straight off `posts` (see supabase/schema/snapshot-2026-08-12.sql + 012). */
interface PostRow {
  id: string;
  creator_id: string | null;
  /** Legacy author column — old rows may carry user_id with creator_id null. */
  user_id: string | null;
  title: string | null;
  video_url: string | null;
  poster_url: string | null;
  interests: string[] | null;
  hashtags: string[] | null;
  price_cents: number | null;
  allow_booking: boolean;
  likes_count: number;
  comments_count: number;
  shares_count: number;
  created_at: string | null;
  active: boolean;
  hidden_at: string | null;
  removed_at: string | null;
  flag_reason: string | null;
}

interface CreatorRow {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
}

interface MetricsRow {
  post_id: string;
  views: number;
  completions: number;
}

/** Contract order: removed beats hidden beats flagged beats live. */
function deriveVideoStatus(post: PostRow): VideoStatus {
  if (post.removed_at !== null) return "removed";
  if (post.hidden_at !== null) return "hidden";
  if (post.flag_reason !== null) return "flagged";
  return "live";
}

function authorId(post: PostRow): string {
  return post.creator_id ?? post.user_id ?? "";
}

function uniqueNonEmpty(values: ReadonlyArray<string>): string[] {
  return Array.from(new Set(values.filter((value) => value !== "")));
}

/**
 * Service-role fetch for the Content page: posts joined in JS to creator
 * profiles and post_metrics (posts.creator_id has no FK, so PostgREST cannot
 * embed the profile — two grouped .in() queries instead). Returns a full
 * AdminInitialData so AdminDataProvider runs in seeded mode; the other three
 * arrays are intentionally empty — this page only reads `videos`.
 */
export async function fetchContentInitialData(): Promise<AdminInitialData> {
  const admin = adminClient();

  const { data: posts, error: postsError } = await admin
    .from("posts")
    .select(
      "id, creator_id, user_id, title, video_url, poster_url, interests, hashtags, price_cents, allow_booking, likes_count, comments_count, shares_count, created_at, active, hidden_at, removed_at, flag_reason",
    )
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(MAX_POSTS)
    .returns<PostRow[]>();

  if (postsError) {
    throw new Error(`Admin content: posts query failed — ${postsError.message}`);
  }

  const postRows = posts ?? [];
  const creatorIds = uniqueNonEmpty(postRows.map(authorId));
  const postIds = postRows.map((post) => post.id);

  const [creatorsResult, metricsResult] = await Promise.all([
    creatorIds.length > 0
      ? admin
          .from("profiles")
          .select("id, username, full_name, avatar_url")
          .in("id", creatorIds)
          .returns<CreatorRow[]>()
      : Promise.resolve({ data: [] as CreatorRow[], error: null }),
    postIds.length > 0
      ? admin
          .from("post_metrics")
          .select("post_id, views, completions")
          .in("post_id", postIds)
          .returns<MetricsRow[]>()
      : Promise.resolve({ data: [] as MetricsRow[], error: null }),
  ]);

  if (creatorsResult.error) {
    throw new Error(
      `Admin content: profiles query failed — ${creatorsResult.error.message}`,
    );
  }
  if (metricsResult.error) {
    throw new Error(
      `Admin content: post_metrics query failed — ${metricsResult.error.message}`,
    );
  }

  const creatorById = new Map(
    (creatorsResult.data ?? []).map((creator) => [creator.id, creator]),
  );
  const metricsByPostId = new Map(
    (metricsResult.data ?? []).map((metrics) => [metrics.post_id, metrics]),
  );

  const videos: AdminVideo[] = postRows.map((post) => {
    const creator = creatorById.get(authorId(post));
    const metrics = metricsByPostId.get(post.id);
    return {
      id: post.id,
      creatorId: authorId(post),
      creatorUsername: creator?.username ?? "unknown",
      creatorName: creator?.full_name ?? creator?.username ?? "Unknown creator",
      title: post.title ?? "Untitled post",
      interests: post.interests ?? [],
      hashtags: post.hashtags ?? [],
      priceCents: post.price_cents,
      allowBooking: post.allow_booking,
      viewCount: metrics?.views ?? 0,
      likeCount: post.likes_count,
      commentCount: post.comments_count,
      shareCount: post.shares_count,
      status: deriveVideoStatus(post),
      flagReason: post.flag_reason,
      createdAt: post.created_at ?? EPOCH_ISO,
    };
  });

  return { users: [], videos, orders: [], bookings: [] };
}
