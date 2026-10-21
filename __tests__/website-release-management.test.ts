import { NextRequest } from "next/server";
import { closedFeatures, SETTINGS_ID } from "@/lib/release/policy";
const owner = jest.fn(), update = jest.fn(), rpc = jest.fn();
jest.mock("@/lib/release/server", () => ({ requireReleaseOwner: (...args: unknown[]) => owner(...args), updateReleaseSettings: (...args: unknown[]) => update(...args) }));
jest.mock("@/lib/admin/server", () => ({ AdminAuthError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { AdminAuthError } from "@/lib/admin/server";
import { releaseManagement } from "@/lib/release/management";
const body = () => ({ revision: 7, hidden: true, features: closedFeatures(), discordInvite: "https://discord.gg/bKC8q4z6B" });
const req = (input: unknown, origin = "https://site.test") => new NextRequest("https://site.test/api/admin/releases", { method: "PATCH", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(input) });
beforeEach(() => { jest.clearAllMocks(); owner.mockResolvedValue({ user: { id: "owner" }, settings: { id: SETTINGS_ID, revision: 7 }, db: { rpc } }); update.mockResolvedValue(undefined); rpc.mockResolvedValue({ error: null }); });
test("unauthorized users cannot read or mutate owner settings", async () => {
  owner.mockRejectedValue(new AdminAuthError(403, "Release owner required"));
  expect((await releaseManagement(req(body()))).status).toBe(403); expect(update).not.toHaveBeenCalled();
});
test("cross-origin and stale requests cannot mutate settings", async () => {
  expect((await releaseManagement(req(body(), "https://evil.test"))).status).toBe(403);
  expect((await releaseManagement(req({ ...body(), revision: 6 }))).status).toBe(409); expect(update).not.toHaveBeenCalled();
});
test("dependencies are checked before writing, and actor identity always comes from Auth", async () => {
  expect((await releaseManagement(req({ ...body(), features: { ...closedFeatures(), checkout: true } }))).status).toBe(400);
  expect((await releaseManagement(req({ ...body(), actorId: "forged" }))).status).toBe(200);
  expect(update).toHaveBeenCalledWith("owner", 7, true, closedFeatures(), body().discordInvite);
});
test("tester requests use the same owner gate and atomic versioned RPC", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  expect((await releaseManagement(req({ revision: 7, userId, approved: true }), true)).status).toBe(200);
  expect(rpc).toHaveBeenCalledWith("set_website_tester_v1", { p_actor: "owner", p_revision: 7, p_user: userId, p_approved: true });
  rpc.mockResolvedValue({ error: {} }); expect((await releaseManagement(req({ revision: 7, userId, approved: false }), true)).status).toBe(409);
});
