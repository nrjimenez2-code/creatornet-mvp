import "server-only";

import { cache } from "react";
import { adminClient } from "@/lib/admin/server";
import { formatCents } from "@/lib/admin/format";
import type {
  ActivityEvent,
  AdminBooking,
  AdminInitialData,
  AdminOrder,
  AdminUser,
  AdminVideo,
  BookingStatus,
  OrderStatus,
  UserStatus,
  VideoStatus,
} from "@/types/admin";

/**
 * Server-side loader for the Admin Launch Board. Maps the REAL Supabase rows
 * (see supabase/schema/snapshot-2026-08-12.sql + 012-admin-foundation.sql)
 * onto the camelCase types in types/admin.ts, deriving each row's moderation
 * status. Wrapped in React cache() so the layout and page share one fetch per
 * request. Service-role only — the /admin layout has already gated for admin.
 */

/** Fallback for legacy rows whose created_at is NULL — sorts them last. */
const EPOCH_ISO = new Date(0).toISOString();

const RECENT_ACTIVITY_LIMIT = 20;

interface ProfileRow {
  id: string;
  username: string | null;
  full_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  review_rating: number | null;
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  onboarding_complete: boolean;
  total_earnings_cents: number;
  banned_at: string | null;
  flag_reason: string | null;
}

interface PostRow {
  id: string;
  creator_id: string | null;
  user_id: string | null;
  title: string | null;
  caption: string | null;
  content: string | null;
  interests: string[] | null;
  hashtags: string[] | null;
  tags: string[] | null;
  price_cents: number | null;
  allow_booking: boolean;
  views: number | null;
  likes_count: number;
  comments_count: number;
  shares_count: number;
  created_at: string | null;
  hidden_at: string | null;
  removed_at: string | null;
  flag_reason: string | null;
}

interface OrderRow {
  id: string;
  buyer_id: string | null;
  buyer_user_id: string | null;
  creator_id: string | null;
  post_id: string | null;
  offering_id: string | null;
  booking_id: string | null;
  status: string;
  gross_amount: number;
  platform_fee: number;
  creator_amount: number;
  created_at: string | null;
}

interface BookingRow {
  id: string;
  post_id: string;
  buyer_id: string;
  creator_id: string;
  status: string;
  linked_order_id: string | null;
  created_at: string;
}

interface PostMetricsRow {
  post_id: string;
  views: number;
}

interface FollowRow {
  following_id: string;
}

interface OfferingRow {
  id: string;
  title: string;
}

/** orders.status is created|paid|refunded|canceled (check constraint). */
const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  created: "pending",
  paid: "paid",
  refunded: "refunded",
  canceled: "failed",
};

/** Real bookings.status values seen in the app: "booked" (seed + booking flow),
 *  "completed" (Stripe webhook after payment). */
const BOOKING_STATUS_MAP: Record<string, BookingStatus> = {
  pending: "pending",
  booked: "confirmed",
  confirmed: "confirmed",
  completed: "completed",
  canceled: "canceled",
  cancelled: "canceled",
};

function deriveUserStatus(row: ProfileRow): UserStatus {
  if (row.banned_at !== null) return "banned";
  if (row.flag_reason !== null) return "flagged";
  return "active";
}

function deriveVideoStatus(row: PostRow): VideoStatus {
  if (row.removed_at !== null) return "removed";
  if (row.hidden_at !== null) return "hidden";
  if (row.flag_reason !== null) return "flagged";
  return "live";
}

function countBy(ids: Array<string | null | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

interface AuthInfo {
  email: string;
  lastSignInAt: string | null;
  createdAt: string | null;
}

export const fetchAdminInitialData = cache(
  async (): Promise<AdminInitialData> => {
    const admin = adminClient();

    const [
      profilesRes,
      postsRes,
      ordersRes,
      bookingsRes,
      metricsRes,
      followsRes,
      offeringsRes,
      authRes,
    ] = await Promise.all([
      admin
        .from("profiles")
        .select(
          "id, username, full_name, created_at, updated_at, review_rating, stripe_account_id, charges_enabled, payouts_enabled, onboarding_complete, total_earnings_cents, banned_at, flag_reason",
        )
        .returns<ProfileRow[]>(),
      admin
        .from("posts")
        .select(
          "id, creator_id, user_id, title, caption, content, interests, hashtags, tags, price_cents, allow_booking, views, likes_count, comments_count, shares_count, created_at, hidden_at, removed_at, flag_reason",
        )
        .returns<PostRow[]>(),
      admin
        .from("orders")
        .select(
          "id, buyer_id, buyer_user_id, creator_id, post_id, offering_id, booking_id, status, gross_amount, platform_fee, creator_amount, created_at",
        )
        .returns<OrderRow[]>(),
      admin
        .from("bookings")
        .select("id, post_id, buyer_id, creator_id, status, linked_order_id, created_at")
        .returns<BookingRow[]>(),
      admin.from("post_metrics").select("post_id, views").returns<PostMetricsRow[]>(),
      admin.from("follows").select("following_id").returns<FollowRow[]>(),
      admin.from("offerings").select("id, title").returns<OfferingRow[]>(),
      // Emails and last-sign-in live in auth.users, not profiles.
      admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    ]);

    const failures = [
      ["profiles", profilesRes.error?.message],
      ["posts", postsRes.error?.message],
      ["orders", ordersRes.error?.message],
      ["bookings", bookingsRes.error?.message],
      ["post_metrics", metricsRes.error?.message],
      ["follows", followsRes.error?.message],
      ["offerings", offeringsRes.error?.message],
      ["auth.users", authRes.error?.message],
    ].filter((entry): entry is [string, string] => typeof entry[1] === "string");
    if (failures.length > 0) {
      throw new Error(
        `Admin data fetch failed: ${failures
          .map(([table, message]) => `${table}: ${message}`)
          .join("; ")}`,
      );
    }

    const profiles = profilesRes.data ?? [];
    const posts = postsRes.data ?? [];
    const orders = ordersRes.data ?? [];
    const bookings = bookingsRes.data ?? [];

    const authById = new Map<string, AuthInfo>(
      authRes.data.users.map((authUser) => [
        authUser.id,
        {
          email: authUser.email ?? "",
          lastSignInAt: authUser.last_sign_in_at ?? null,
          createdAt: authUser.created_at ?? null,
        },
      ]),
    );
    const viewsByPost = new Map<string, number>(
      (metricsRes.data ?? []).map((row) => [row.post_id, row.views]),
    );
    const offeringTitleById = new Map<string, string>(
      (offeringsRes.data ?? []).map((row) => [row.id, row.title]),
    );
    const followerCounts = countBy(
      (followsRes.data ?? []).map((row) => row.following_id),
    );
    const postCounts = countBy(posts.map((post) => post.creator_id ?? post.user_id));

    const users: AdminUser[] = profiles.map((row) => {
      const auth = authById.get(row.id);
      const username = row.username ?? `user-${row.id.slice(0, 8)}`;
      const postCount = postCounts.get(row.id) ?? 0;
      const joinedAt = row.created_at ?? auth?.createdAt ?? EPOCH_ISO;
      return {
        id: row.id,
        username,
        displayName: row.full_name ?? username,
        email: auth?.email ?? "",
        isCreator: postCount > 0 || row.stripe_account_id !== null,
        stripeAccountId: row.stripe_account_id,
        chargesEnabled: row.charges_enabled,
        payoutsEnabled: row.payouts_enabled,
        onboardingComplete: row.onboarding_complete,
        totalEarningsCents: row.total_earnings_cents,
        rating: row.review_rating,
        postCount,
        followerCount: followerCounts.get(row.id) ?? 0,
        status: deriveUserStatus(row),
        flagReason: row.flag_reason,
        joinedAt,
        lastActiveAt: auth?.lastSignInAt ?? row.updated_at ?? joinedAt,
      };
    });

    const usersById = new Map(users.map((user) => [user.id, user]));
    const usernameOf = (id: string | null): string =>
      (id ? usersById.get(id)?.username : undefined) ?? "unknown";
    const displayNameOf = (id: string | null): string =>
      (id ? usersById.get(id)?.displayName : undefined) ?? "Unknown";

    const videos: AdminVideo[] = posts.map((row) => {
      const creatorId = row.creator_id ?? row.user_id ?? "";
      return {
        id: row.id,
        creatorId,
        creatorUsername: usernameOf(creatorId),
        creatorName: displayNameOf(creatorId),
        title: row.title ?? row.caption ?? row.content ?? "Untitled",
        interests: row.interests ?? [],
        hashtags: row.hashtags ?? row.tags ?? [],
        priceCents: row.price_cents,
        allowBooking: row.allow_booking,
        viewCount: viewsByPost.get(row.id) ?? row.views ?? 0,
        likeCount: row.likes_count,
        commentCount: row.comments_count,
        shareCount: row.shares_count,
        status: deriveVideoStatus(row),
        flagReason: row.flag_reason,
        createdAt: row.created_at ?? EPOCH_ISO,
      };
    });

    const videosById = new Map(videos.map((video) => [video.id, video]));

    const adminOrders: AdminOrder[] = orders.map((row) => {
      const buyerId = row.buyer_user_id ?? row.buyer_id ?? "";
      const post = row.post_id ? videosById.get(row.post_id) : undefined;
      const offeringTitle = row.offering_id
        ? offeringTitleById.get(row.offering_id)
        : undefined;
      return {
        id: row.id,
        buyerUserId: buyerId,
        buyerUsername: usernameOf(buyerId || null),
        creatorId: row.creator_id ?? "",
        creatorUsername: usernameOf(row.creator_id),
        postId: row.post_id,
        offerTitle: post?.title ?? offeringTitle ?? "Direct checkout",
        // The orders row does not record installment plans (checkout writes the
        // same shape for both); only bookings are distinguishable here.
        kind: row.booking_id !== null ? "booking" : "product",
        grossCents: row.gross_amount,
        feeCents: row.platform_fee,
        creatorCents: row.creator_amount,
        status: ORDER_STATUS_MAP[row.status] ?? "pending",
        createdAt: row.created_at ?? EPOCH_ISO,
      };
    });

    const ordersById = new Map(adminOrders.map((order) => [order.id, order]));

    const adminBookings: AdminBooking[] = bookings.map((row) => {
      const linkedOrder = row.linked_order_id
        ? ordersById.get(row.linked_order_id)
        : undefined;
      return {
        id: row.id,
        creatorId: row.creator_id,
        creatorUsername: usernameOf(row.creator_id),
        buyerUserId: row.buyer_id,
        buyerUsername: usernameOf(row.buyer_id),
        offerTitle: videosById.get(row.post_id)?.title ?? "Booking",
        amountCents: linkedOrder?.grossCents ?? null,
        status: BOOKING_STATUS_MAP[row.status] ?? "pending",
        createdAt: row.created_at,
      };
    });

    return { users, videos, orders: adminOrders, bookings: adminBookings };
  },
);

const PURCHASE_VERBS: Record<OrderStatus, string> = {
  paid: "bought",
  pending: "started checkout for",
  refunded: "was refunded for",
  failed: "abandoned checkout for",
};

/**
 * Newest events across signups, uploads, and orders — the Overview page's
 * "Recent activity" feed, derived from the already-fetched rows.
 */
export function buildRecentActivity(data: AdminInitialData): ActivityEvent[] {
  const signups: ActivityEvent[] = data.users.map((user) => ({
    id: `act_signup_${user.id}`,
    kind: "signup",
    message: "created an account",
    actorUsername: user.username,
    occurredAt: user.joinedAt,
  }));

  const uploads: ActivityEvent[] = data.videos.map((video) => ({
    id: `act_upload_${video.id}`,
    kind: "upload",
    message: `uploaded "${video.title}"`,
    actorUsername: video.creatorUsername,
    occurredAt: video.createdAt,
  }));

  const purchases: ActivityEvent[] = data.orders.map((order) => ({
    id: `act_purchase_${order.id}`,
    kind: order.kind === "booking" ? "booking" : "purchase",
    message: `${PURCHASE_VERBS[order.status]} "${order.offerTitle}" from @${order.creatorUsername} (${formatCents(order.grossCents)})`,
    actorUsername: order.buyerUsername,
    occurredAt: order.createdAt,
  }));

  return [...signups, ...uploads, ...purchases]
    .sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    )
    .slice(0, RECENT_ACTIVITY_LIMIT);
}
