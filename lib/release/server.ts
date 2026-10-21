import "server-only";
import type { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import { adminClient, AdminAuthError } from "@/lib/admin/server";
import { getAuthenticatedUser } from "@/lib/supabaseConnectAuth";
import { dependenciesMet, SETTINGS_ID, validDiscordInvite, validFlags, type ReleaseSettings } from "./policy";

export async function loadReleaseSettings(): Promise<ReleaseSettings | null> {
  try {
    const { data, error } = await adminClient().from("website_release_settings_v1").select("*").eq("id", SETTINGS_ID).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (error || !data || typeof data.hidden !== "boolean" || !validFlags(data.features) || !dependenciesMet(data.features) || !Number.isSafeInteger(data.revision)) return null;
    if (data.discord_invite !== null && !validDiscordInvite(data.discord_invite)) return null;
    return data as ReleaseSettings;
  } catch { return null; }
}
export const verifiedIdentity = (user: User | null): user is User => Boolean(user && !user.is_anonymous && (user.email_confirmed_at || user.phone_confirmed_at));
export async function hasPrivateAccess(user: User | null, settings: ReleaseSettings | null): Promise<boolean> {
  if (!verifiedIdentity(user) || !settings?.owner_id) return false;
  try {
    const db = adminClient();
    const profile = await db.from("profiles").select("banned_at").eq("id", user.id).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    if (profile.error || !profile.data || profile.data.banned_at !== null) return false;
    if (user.id === settings.owner_id) return true;
    const tester = await db.from("website_release_testers_v1").select("user_id").eq("user_id", user.id).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
    return !tester.error && Boolean(tester.data);
  } catch { return false; }
}
export async function requireReleaseOwner(req?: NextRequest) {
  const user = await getAuthenticatedUser(req);
  if (!verifiedIdentity(user)) throw new AdminAuthError(401, "Sign in required");
  const settings = await loadReleaseSettings();
  if (settings?.owner_id !== user.id || !(await hasPrivateAccess(user, settings))) throw new AdminAuthError(403, "Release owner required");
  return { user, settings, db: adminClient() };
}
/** A saved buyer-owned operation admits only its existing fulfillment route. Handlers recheck entitlement/readiness. */
export async function hasOwnedContinuation(req: NextRequest, user: User | null): Promise<boolean> {
  if (!verifiedIdentity(user)) return false;
  try {
    const db = adminClient();
    if (req.nextUrl.pathname.startsWith("/api/checkout-link/")) {
      const row = await db.from("discover_checkout_links_v1").select("id").eq("id", req.nextUrl.pathname.split("/").pop()).eq("buyer_id", user.id).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
      return !row.error && Boolean(row.data);
    }
    let selectors: Record<string, unknown> = Object.fromEntries(req.nextUrl.searchParams);
    if (req.method === "POST") {
      const text = await req.clone().text();
      if (text.length > 4096) return false;
      selectors = JSON.parse(text);
    }
    if (req.nextUrl.pathname === "/api/posts/view-counts") {
      const { postIds, purchaseIds } = selectors;
      if (!Array.isArray(postIds) || !Array.isArray(purchaseIds) || !postIds.length || postIds.length > 100 || purchaseIds.length > 100 || [...postIds, ...purchaseIds].some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))) return false;
      const owned = await db.from("purchases").select("post_id").eq("buyer_id", user.id).in("id", purchaseIds).in("post_id", postIds).abortSignal(AbortSignal.timeout(5000));
      return !owned.error && postIds.every(id => owned.data?.some(row => row.post_id === id));
    }
    const candidates: Array<[unknown, string, string]> = [
      [selectors.purchase_id ?? selectors.purchaseId, "purchases", "buyer_id"],
      [selectors.reservation_id ?? selectors.reservationId, "google_booking_reservations_v1", "buyer_id"],
      [selectors.cn_attribution ?? selectors.attributionId, "discover_booking_attribution_v1", "user_id"],
    ];
    for (const [id, table, column] of candidates) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) continue;
      const row = await db.from(table).select("id").eq("id", id).eq(column, user.id).abortSignal(AbortSignal.timeout(5000)).maybeSingle();
      if (!row.error && row.data) return true;
    }
  } catch { /* deny */ }
  return false;
}
export async function verifyDiscordInvite(invite: string): Promise<boolean> {
  if (!validDiscordInvite(invite)) return false;
  try {
    const code = invite.split("/").pop();
    const result = await fetch(`https://discord.com/api/v10/invites/${code}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!result.ok) return false;
    const data = await result.json();
    return data.code === code && typeof data.guild?.id === "string" && (!data.expires_at || Date.parse(data.expires_at) > Date.now());
  } catch { return false; }
}
/** Reusable update boundary for a future scheduler; does not schedule anything. */
export async function updateReleaseSettings(actorId: string, revision: number, hidden: boolean, features: ReleaseSettings["features"], invite: string) {
  if (!validFlags(features) || !dependenciesMet(features) || !validDiscordInvite(invite)) throw new Error("Invalid release settings");
  const current = await loadReleaseSettings();
  const emergencyClose = hidden && current?.owner_id === actorId && current.discord_invite === invite;
  if (!emergencyClose && !(await verifyDiscordInvite(invite))) throw new Error("Discord invite could not be verified");
  const { error } = await adminClient().rpc("update_website_release_v1", { p_actor: actorId, p_revision: revision, p_hidden: hidden, p_features: features, p_invite: invite });
  if (error) throw new Error("Release update failed");
}
