import "server-only";
import { adminClient } from "@/lib/admin/server";
import {
  isVerificationPlatform,
  profileUrlFor,
  type VerificationPlatform,
  type VerificationStatus,
} from "@/lib/verification";

/** Newest-first cap so the queue never issues an unbounded scan. */
const MAX_REQUESTS = 200;

interface RequestRow {
  id: string;
  creator_id: string;
  platform: string;
  handle: string;
  code: string;
  status: VerificationStatus;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
}

interface ProfileRow {
  id: string;
  username: string | null;
  full_name: string | null;
}

export interface AdminVerificationCreator {
  id: string;
  username: string | null;
  fullName: string | null;
}

export interface AdminVerificationRequest {
  id: string;
  creator: AdminVerificationCreator;
  platform: VerificationPlatform;
  handle: string;
  /** The public profile the admin opens to look for the code. */
  profileUrl: string;
  /** Only while pending — that is the only time an admin needs to see it. */
  code: string | null;
  status: VerificationStatus;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

/** Pending codes first (oldest waiting at the top), then everything else newest-first. */
function queueOrder(a: AdminVerificationRequest, b: AdminVerificationRequest): number {
  const aPending = a.status === "code_issued" ? 0 : 1;
  const bPending = b.status === "code_issued" ? 0 : 1;
  if (aPending !== bPending) return aPending - bPending;
  return aPending === 0
    ? a.createdAt.localeCompare(b.createdAt)
    : b.createdAt.localeCompare(a.createdAt);
}

/** Recent verification requests joined with creator display names (service role). */
export async function fetchVerificationRequests(): Promise<AdminVerificationRequest[]> {
  const admin = adminClient();

  const { data: rows, error } = await admin
    .from("verification_requests")
    .select("id, creator_id, platform, handle, code, status, reason, created_at, decided_at")
    .order("created_at", { ascending: false })
    .limit(MAX_REQUESTS)
    .returns<RequestRow[]>();

  if (error) {
    throw new Error(`verification_requests fetch failed: ${error.message}`);
  }

  const requests = rows ?? [];
  const creatorIds = Array.from(new Set(requests.map((r) => r.creator_id)));

  const profileMap = new Map<string, ProfileRow>();
  if (creatorIds.length > 0) {
    const { data: profiles, error: profileError } = await admin
      .from("profiles")
      .select("id, username, full_name")
      .in("id", creatorIds)
      .returns<ProfileRow[]>();

    if (profileError) {
      throw new Error(`profiles fetch failed: ${profileError.message}`);
    }
    for (const p of profiles ?? []) {
      profileMap.set(p.id, p);
    }
  }

  return requests
    .map((r): AdminVerificationRequest => {
      const platform: VerificationPlatform = isVerificationPlatform(r.platform) ? r.platform : "instagram";
      const p = profileMap.get(r.creator_id);
      return {
        id: r.id,
        creator: { id: r.creator_id, username: p?.username ?? null, fullName: p?.full_name ?? null },
        platform,
        handle: r.handle,
        profileUrl: profileUrlFor(platform, r.handle),
        code: r.status === "code_issued" ? r.code : null,
        status: r.status,
        reason: r.reason,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
      };
    })
    .sort(queueOrder);
}
