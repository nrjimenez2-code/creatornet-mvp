import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/admin/server";
import type { AdminUser, UserStatus } from "@/types/admin";

/** SERVER ONLY — uses the service-role client. Never import from a client component. */

export const USERS_PAGE_SIZE = 50;

/**
 * Ceiling for the grouped count queries. Supabase's PostgREST max-rows setting
 * clamps responses (default 1000), so a creator's posts beyond that cap would
 * undercount — fine at launch scale, revisit with a SQL aggregate when needed.
 */
const GROUP_ROW_LIMIT = 10_000;

/** When created_at/updated_at are both NULL (both nullable in the live schema). */
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/**
 * Raw `profiles` columns this page reads — verified against
 * supabase/schema/snapshot-2026-08-12.sql plus 012-admin-foundation.sql.
 * `profiles` has no email column (emails live in auth.users), and both
 * `stripe_onboarding_complete` and a legacy `onboarding_complete` exist; the
 * Stripe Connect panel wants the stripe_ one.
 */
interface ProfileRow {
  id: string;
  username: string | null;
  full_name: string | null;
  created_at: string | null;
  updated_at: string | null;
  role: string;
  banned_at: string | null;
  flag_reason: string | null;
  review_rating: number | null;
  total_earnings_cents: number;
  stripe_account_id: string | null;
  stripe_onboarding_complete: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
}

const PROFILE_COLUMNS =
  "id, username, full_name, created_at, updated_at, role, banned_at, " +
  "flag_reason, review_rating, total_earnings_cents, stripe_account_id, " +
  "stripe_onboarding_complete, charges_enabled, payouts_enabled";

function deriveStatus(row: ProfileRow): UserStatus {
  if (row.banned_at !== null) return "banned";
  if (row.flag_reason !== null) return "flagged";
  return "active";
}

/**
 * One query per relation (grouped in code) instead of a count query per user.
 * Returns owner id -> row count for the given ids.
 */
async function countByColumn(
  admin: SupabaseClient,
  table: "posts" | "follows",
  column: "creator_id" | "following_id",
  ids: string[],
): Promise<Map<string, number>> {
  const { data, error } = await admin
    .from(table)
    .select(column)
    .in(column, ids)
    .limit(GROUP_ROW_LIMIT)
    .returns<Record<string, string | null>[]>();
  if (error) {
    throw new Error(`Admin users: ${table}.${column} count failed: ${error.message}`);
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const key = row[column];
    if (typeof key === "string") {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function toAdminUser(
  row: ProfileRow,
  postCount: number,
  followerCount: number,
): AdminUser {
  const joinedAt = row.created_at ?? row.updated_at ?? EPOCH_ISO;
  return {
    id: row.id,
    username: row.username ?? row.id.slice(0, 8),
    displayName: row.full_name ?? row.username ?? "Unnamed user",
    // profiles carries no email; the UI omits it when empty.
    email: "",
    // No is_creator column in the live schema — published posts or a Stripe
    // Connect account is what makes an account a creator in practice.
    isCreator: postCount > 0 || row.stripe_account_id !== null,
    stripeAccountId: row.stripe_account_id,
    chargesEnabled: row.charges_enabled,
    payoutsEnabled: row.payouts_enabled,
    onboardingComplete: row.stripe_onboarding_complete,
    totalEarningsCents: row.total_earnings_cents,
    rating: row.review_rating,
    postCount,
    followerCount,
    status: deriveStatus(row),
    flagReason: row.flag_reason,
    joinedAt,
    lastActiveAt: row.updated_at ?? joinedAt,
  };
}

/** Newest 50 profiles with per-user post/follower counts, mapped for the Users page. */
export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const admin = adminClient();

  const { data, error } = await admin
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .order("created_at", { ascending: false, nullsFirst: false })
    .range(0, USERS_PAGE_SIZE - 1)
    .returns<ProfileRow[]>();
  if (error) {
    throw new Error(`Admin users: profiles fetch failed: ${error.message}`);
  }

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [postCounts, followerCounts] = await Promise.all([
    countByColumn(admin, "posts", "creator_id", ids),
    countByColumn(admin, "follows", "following_id", ids),
  ]);

  return rows.map((row) =>
    toAdminUser(row, postCounts.get(row.id) ?? 0, followerCounts.get(row.id) ?? 0),
  );
}
