import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertMembershipId, type MembershipPaymentContext } from "./membershipAgreement";
import { membershipCheck as check } from "./membershipCheckout";
import { membershipExitReady, type MembershipExitQuote } from "./membershipExit";
export type MembershipView = "buyer" | "creator";
export type MembershipExitStatus = { membershipId: string; billingBlocked: boolean; providerStopped: boolean;
  requests: { id: string; kind: "stop_renewal" | "revoke_debits"; status: string; requestedAt: string;
    providerCompletedAt: string | null; lastAttemptAt: string | null; workerStatus: string | null; attempts: number; nextAttemptAt: string | null }[] };
export type MembershipManagementItem = { id: string; acceptedAt: string; title: string; postId: string; productId: string;
  counterpartyId: string; counterpartyName?: string | null; counterpartyUsername?: string | null;
  monthlyPriceCents: number; minimumMonths: number; autoRenew: boolean; firstPaymentRecorded: boolean; billingReview: boolean;
  initialAbandoned?: boolean;
  quote: MembershipExitQuote; access: { allowed: boolean; maxAgeSeconds: number; paidThrough: number | null };
  exitStatus: MembershipExitStatus; payoff: { id: string; status: string } | null };
export type MembershipManagementPage = { view: MembershipView; items: MembershipManagementItem[]; nextCursor: string | null };
type Cursor = { id: string; acceptedAt: string };
export function membershipManagementReady(env: Record<string, string | undefined> = process.env) {
  return membershipExitReady(env) && ["CREATOR_MONTHLY_MENTORSHIPS_MANAGEMENT_SCHEMA_READY", "CREATOR_MONTHLY_MENTORSHIPS_MANAGEMENT_READY",
    "CREATOR_MONTHLY_MENTORSHIPS_EXIT_RECOVERY_SCHEMA_READY"].every(key => env[key] === "true");
}
function cursorValue(value: unknown): Cursor {
  check(value && typeof value === "object" && !Array.isArray(value)); const c = value as Cursor;
  assertMembershipId(c.id);
  check(Object.keys(c).sort().join(",") === "acceptedAt,id" && typeof c.acceptedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(c.acceptedAt) && Number.isFinite(Date.parse(c.acceptedAt)),
  "Monthly management cursor differs");
  return c;
}
export function decodeMembershipCursor(value: string | null): Cursor | null {
  if (value == null) return null;
  check(value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value), "Monthly management cursor differs");
  return cursorValue(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
}
export async function listManagedMemberships(admin: SupabaseClient, context: MembershipPaymentContext, actorId: string,
  view: MembershipView, cursor: Cursor | null): Promise<MembershipManagementPage> {
  assertMembershipId(actorId); check(["buyer", "creator"].includes(view)); if (cursor) cursorValue(cursor);
  const result = await admin.rpc("read_monthly_mentorship_management_v1", { p_actor_id: actorId, p_view: view, p_context: context,
    p_after: cursor?.acceptedAt ?? null, p_after_id: cursor?.id ?? null, p_limit: 12 });
  const body = result.data;
  check(!result.error && body?.view === view && Array.isArray(body.items) && body.items.length <= 12, "Monthly management state needs retry");
  const ids = new Set<string>();
  for (const item of body.items as MembershipManagementItem[]) {
    [item.id, item.postId, item.productId, item.counterpartyId].forEach(assertMembershipId);
    check(!ids.has(item.id)); ids.add(item.id);
    check((item.initialAbandoned === undefined || typeof item.initialAbandoned === "boolean") &&
      (!item.initialAbandoned || !item.firstPaymentRecorded && !item.access?.allowed && !item.payoff) &&
      typeof item.title === "string" && typeof item.firstPaymentRecorded === "boolean" && typeof item.billingReview === "boolean" &&
      typeof item.autoRenew === "boolean" && Number.isSafeInteger(item.monthlyPriceCents) && item.monthlyPriceCents >= 50 &&
      Number.isSafeInteger(item.minimumMonths) && item.minimumMonths >= 1 && item.minimumMonths <= 24 &&
      item.quote?.version === "monthly-exit-quote-v1" && item.quote.membershipId === item.id &&
      item.quote.monthlyPriceCents === item.monthlyPriceCents && item.quote.minimumMonths === item.minimumMonths &&
      Array.isArray(item.quote.reviewReasons) && typeof item.access?.allowed === "boolean" &&
      item.exitStatus?.membershipId === item.id && typeof item.exitStatus.billingBlocked === "boolean" &&
      typeof item.exitStatus.providerStopped === "boolean" && Array.isArray(item.exitStatus.requests),
    "Monthly management projection differs");
    cursorValue({ id: item.id, acceptedAt: item.acceptedAt });
    if (item.payoff) assertMembershipId(item.payoff.id);
  }
  const items = body.items as MembershipManagementItem[], counterparties = [...new Set(items.map(item => item.counterpartyId))];
  if (counterparties.length) {
    // Display names are optional, never authority for ownership, billing or access.
    try {
    const profiles = await admin.from("profiles").select("id,username,full_name").in("id", counterparties);
    if (!profiles.error && Array.isArray(profiles.data)) {
      const byId = new Map(profiles.data.map(p => [p.id, p]));
      for (const item of items) {
        const p = byId.get(item.counterpartyId);
        item.counterpartyName = typeof p?.full_name === "string" ? p.full_name : null;
        item.counterpartyUsername = typeof p?.username === "string" ? p.username : null;
      }
    }
    } catch { /* Preserve owned payment state when optional display names fail. */ }
  }
  return { view, items, nextCursor: body.nextCursor == null ? null : Buffer.from(JSON.stringify(cursorValue(body.nextCursor))).toString("base64url") };
}
