import type { User } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { closedFeatures, SETTINGS_ID, type ReleaseSettings } from "@/lib/release/policy";
const identity = jest.fn(), rpc = jest.fn();
let replies: Record<string, { data: unknown; error: unknown }>;
const from = jest.fn((table: string) => {
  const query = { select: () => query, eq: () => query, in: () => query, abortSignal: () => query, maybeSingle: async () => replies[table], then: (resolve: (value: unknown) => void) => Promise.resolve(replies[table]).then(resolve) };
  return query;
});
jest.mock("@/lib/admin/server", () => ({ adminClient: () => ({ from, rpc }), AdminAuthError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: (...args: unknown[]) => identity(...args) }));
import { hasOwnedContinuation, hasPrivateAccess, loadReleaseSettings, requireReleaseOwner, updateReleaseSettings, verifyDiscordInvite } from "@/lib/release/server";
const state = (): ReleaseSettings => ({ id: SETTINGS_ID, owner_id: "owner", hidden: true, features: closedFeatures(), discord_invite: "https://discord.gg/bKC8q4z6B", revision: 0, updated_at: "now" });
const user = (id = "owner") => ({ id, email_confirmed_at: "yes", user_metadata: { role: "admin" } }) as unknown as User;
beforeEach(() => {
  jest.clearAllMocks(); identity.mockResolvedValue(user()); rpc.mockResolvedValue({ error: null });
  replies = { website_release_settings_v1: { data: state(), error: null }, profiles: { data: { banned_at: null }, error: null }, website_release_testers_v1: { data: null, error: null } };
});
test("malformed or unavailable settings fail closed", async () => {
  replies.website_release_settings_v1.error = {}; expect(await loadReleaseSettings()).toBeNull();
  replies.website_release_settings_v1 = { data: { ...state(), features: { feed: true } }, error: null }; expect(await loadReleaseSettings()).toBeNull();
});
test("only a verified owner or current tester grants private access; metadata grants nothing", async () => {
  expect(await hasPrivateAccess(user(), state())).toBe(true);
  expect(await hasPrivateAccess(user("ordinary"), state())).toBe(false);
  replies.website_release_testers_v1.data = { user_id: "tester" }; expect(await hasPrivateAccess(user("tester"), state())).toBe(true);
  replies.website_release_testers_v1.data = null; expect(await hasPrivateAccess(user("tester"), state())).toBe(false);
  expect(await hasPrivateAccess({ ...user(), email_confirmed_at: undefined }, state())).toBe(false);
  expect(await hasPrivateAccess({ ...user(), is_anonymous: true }, state())).toBe(false);
  replies.profiles.data = { banned_at: "now" }; expect(await hasPrivateAccess(user(), state())).toBe(false);
});
test("release management requires the exact owner even for approved testers", async () => {
  identity.mockResolvedValue(user("tester")); replies.website_release_testers_v1.data = { user_id: "tester" };
  await expect(requireReleaseOwner()).rejects.toMatchObject({ status: 403 });
  identity.mockResolvedValue(null); await expect(requireReleaseOwner()).rejects.toMatchObject({ status: 401 });
});
test("continuations require saved ownership; parsing leaves the request body available to its handler", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  replies.purchases = { data: null, error: null };
  const req = new NextRequest("https://site.test/api/scheduling/google/book/connection", { method: "POST", body: JSON.stringify({ purchaseId: id }) });
  expect(await hasOwnedContinuation(req, user("buyer"))).toBe(false);
  replies.purchases.data = { id }; expect(await hasOwnedContinuation(req, user("buyer"))).toBe(true);
  expect(await req.json()).toEqual({ purchaseId: id }); expect(await hasOwnedContinuation(req, null)).toBe(false);
});
test("Discord validation rejects expired, missing and foreign invite destinations", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ code: "bKC8q4z6B", guild: { id: "guild" }, expires_at: "2000-01-01" }) });
  expect(await verifyDiscordInvite("https://discord.gg/bKC8q4z6B")).toBe(false);
  expect(await verifyDiscordInvite("https://evil.test/invite")).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("emergency hide still works during Discord failure and preserves exact feature settings", async () => {
  global.fetch = jest.fn().mockRejectedValue(Error("offline"));
  const flags = { ...closedFeatures(), feed: true };
  await updateReleaseSettings("owner", 0, true, flags, "https://discord.gg/bKC8q4z6B");
  expect(fetch).not.toHaveBeenCalled(); expect(rpc).toHaveBeenCalledWith("update_website_release_v1", expect.objectContaining({ p_actor: "owner", p_hidden: true, p_features: flags, p_revision: 0 }));
  await expect(updateReleaseSettings("owner", 0, false, flags, "https://discord.gg/bKC8q4z6B")).rejects.toThrow(/Discord/);
});
