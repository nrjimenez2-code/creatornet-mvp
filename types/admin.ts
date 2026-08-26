/**
 * Admin Launch Board types.
 *
 * Field names mirror the REAL CreatorNet Supabase schema (per the technical
 * handoff: tables `profiles`, `posts`, `orders`, `purchases`, `bookings`),
 * camelCased for TypeScript. Fields marked [NEW] don't exist in the live DB
 * yet and need a small migration — see docs/ADMIN_HANDOFF.md.
 */

export type UserStatus = "active" | "banned" | "flagged";

/** Mirrors `profiles` (+ join-derived counts). */
export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  email: string;
  isCreator: boolean;
  /** Stripe Connect fields from `profiles` */
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
  totalEarningsCents: number;
  rating: number | null;
  postCount: number;
  followerCount: number;
  /** [NEW] requires `profiles.banned_at` / `profiles.flag_reason` migration */
  status: UserStatus;
  flagReason: string | null;
  joinedAt: string;
  lastActiveAt: string;
}

export type VideoStatus = "live" | "hidden" | "removed" | "flagged";

/** Mirrors `posts` (+ creator join + `post_metrics` counts). */
export interface AdminVideo {
  id: string;
  creatorId: string;
  creatorUsername: string;
  creatorName: string;
  title: string;
  interests: string[];
  hashtags: string[];
  /** null = no Buy offer attached */
  priceCents: number | null;
  allowBooking: boolean;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  /** [NEW] requires `posts.hidden_at` / `posts.removed_at` / flag columns */
  status: VideoStatus;
  flagReason: string | null;
  createdAt: string;
}

export type OrderKind = "product" | "installments" | "booking";
export type OrderStatus = "paid" | "pending" | "refunded" | "failed";

/** Mirrors `orders` (gross/fee/creator amounts, status). */
export interface AdminOrder {
  id: string;
  buyerUserId: string;
  buyerUsername: string;
  creatorId: string;
  creatorUsername: string;
  postId: string | null;
  offerTitle: string;
  kind: OrderKind;
  grossCents: number;
  /** 12% platform fee — PLATFORM_FEE_RATE 0.12 in the real checkout/webhook */
  feeCents: number;
  creatorCents: number;
  status: OrderStatus;
  createdAt: string;
}

export type BookingStatus = "pending" | "confirmed" | "completed" | "canceled";

/** Mirrors `bookings` / `booking_payments`. */
export interface AdminBooking {
  id: string;
  creatorId: string;
  creatorUsername: string;
  buyerUserId: string;
  buyerUsername: string;
  offerTitle: string;
  amountCents: number | null;
  status: BookingStatus;
  createdAt: string;
}

export type ActivityKind =
  | "signup"
  | "upload"
  | "purchase"
  | "booking"
  | "flag"
  | "stripe_connect";

/** Feed for the Overview page — shaped like a `post_events`-style log. */
export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  message: string;
  actorUsername: string;
  occurredAt: string;
}

/**
 * Seed payload for AdminDataProvider. Server containers (layout/pages) build
 * this from Supabase and pass it down; when omitted the provider falls back to
 * the bundled mock data and skips /api/admin/* calls (pure demo mode).
 */
export interface AdminInitialData {
  users: AdminUser[];
  videos: AdminVideo[];
  orders: AdminOrder[];
  bookings: AdminBooking[];
}

export interface PlatformStats {
  totalUsers: number;
  totalCreators: number;
  totalVideos: number;
  gmvCents: number;
  platformFeeCents: number;
  purchaseCount: number;
  bookingCount: number;
  flaggedCount: number;
  newUsersToday: number;
  uploadsToday: number;
}
