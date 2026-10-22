import { NextRequest } from "next/server";
import { closedFeatures, SETTINGS_ID } from "@/lib/release/policy";
const identity = jest.fn(), load = jest.fn(), privateAccess = jest.fn(), continuation = jest.fn();
jest.mock("@/lib/supabaseConnectAuth", () => ({ getAuthenticatedUser: (...args: unknown[]) => identity(...args) }));
jest.mock("@/lib/release/server", () => ({ loadReleaseSettings: () => load(), hasPrivateAccess: (...args: unknown[]) => privateAccess(...args), hasOwnedContinuation: (...args: unknown[]) => continuation(...args), verifiedIdentity: (user: {email_confirmed_at?: string;is_anonymous?:boolean} | null) => Boolean(user?.email_confirmed_at && !user.is_anonymous) }));
import { proxy } from "@/proxy";
const state = () => ({ id: SETTINGS_ID, owner_id: "owner", hidden: true, features: closedFeatures(), public_page: "coming-soon" as "blank" | "coming-soon", discord_invite: "https://discord.gg/bKC8q4z6B", revision: 0 });
beforeEach(() => { jest.clearAllMocks(); identity.mockResolvedValue(null); load.mockResolvedValue(state()); privateAccess.mockResolvedValue(false); continuation.mockResolvedValue(false); });
const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => proxy(new NextRequest("https://creatornet.test" + path, init));
test.each(["/", "/dashboard", "/creators/known", "/future", "/data.json"])("anonymous page %s renders only launch HTML", async path => {
  const response = await request(path); expect(response.status).toBe(200); expect(await response.text()).toContain("Coming soon."); expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("x-middleware-next")).toBeNull();
});
test("forged auth cookies cannot unlock direct endpoints", async () => {
  const response = await request("/api/feed", { headers: { cookie: "sb-fake=owner", "x-creatornet-public-shell": "0" } });
  expect(identity).toHaveBeenCalled(); expect(response.status).toBe(401);
});
test("ordinary existing and revoked accounts remain denied", async () => {
  identity.mockResolvedValue({ id: "ordinary", email_confirmed_at: "yes" }); expect((await request("/api/feed")).status).toBe(403);
  privateAccess.mockResolvedValueOnce(true); expect((await request("/api/feed")).headers.get("x-middleware-next")).toBe("1");
  expect((await request("/api/feed")).status).toBe(403);
});
test("owner and approved tester can browse, but only owner reaches release management", async () => {
  privateAccess.mockResolvedValue(true); identity.mockResolvedValue({ id: "tester", email_confirmed_at: "yes" });
  expect((await request("/api/feed")).headers.get("x-middleware-next")).toBe("1"); expect((await request("/api/admin/releases")).status).toBe(403);
  identity.mockResolvedValue({ id: "owner", email_confirmed_at: "yes" }); expect((await request("/api/admin/releases")).headers.get("x-middleware-next")).toBe("1");
});
test("opening feed does not open unrelated routes; master hide closes it again", async () => {
  const settings = state(); settings.hidden = false; settings.features.feed = true; load.mockResolvedValue(settings);
  expect((await request("/api/feed")).headers.get("x-middleware-next")).toBe("1"); expect((await request("/api/search/videos")).status).toBe(401);
  settings.hidden = true; expect((await request("/api/feed")).status).toBe(401);
});
test("configuration failure denies actions and supplies only a neutral document", async () => {
  load.mockResolvedValue(null); expect((await request("/api/feed")).status).toBe(401); expect(await (await request("/")).text()).toContain("<body></body>");
});
test("signed webhook and cron handlers remain reachable without granting adjacent API access", async () => {
  expect((await request("/api/stripe/webhook", { method: "POST" })).headers.get("x-middleware-next")).toBe("1");
  expect((await request("/api/memberships/collect")).headers.get("x-middleware-next")).toBe("1"); expect(identity).not.toHaveBeenCalled();
  expect((await request("/api/search/enrich")).headers.get("x-middleware-next")).toBe("1");
  expect((await request("/api/search/enrich", { method: "POST" })).status).toBe(401);
  expect((await request("/api/stripe/anything", { method: "POST" })).status).toBe(401);
});
test("fulfillment requires verified identity and uses the minimal shell", async () => {
  expect((await request("/api/library/eligibility", { method: "POST" })).status).toBe(401);
  identity.mockResolvedValue({ id: "buyer", email_confirmed_at: "yes" }); const response = await request("/library");
  expect(response.headers.get("x-middleware-next")).toBe("1"); expect(response.headers.get("x-middleware-request-x-creatornet-public-shell")).toBe("1");
});
test("saved buyer-owned booking continues; arbitrary selectors do not", async () => {
  identity.mockResolvedValue({ id: "buyer", email_confirmed_at: "yes" }); expect((await request("/api/scheduling/google/book/id?purchase_id=forged")).status).toBe(403);
  continuation.mockResolvedValue(true); expect((await request("/api/scheduling/google/book/id?purchase_id=owned")).headers.get("x-middleware-next")).toBe("1");
});
test("server actions are denied even on public auth and owner routes", async () => {
  for (const path of ["/auth", "/admin/releases", "/dashboard"]) expect((await request(path, { method: "POST", headers: { "next-action": "forged" } })).status).toBe(403);
});

test.each(["/", "/dashboard", "/future", "/opengraph-image", "/legal/terms", "/legal/privacy", "/legal/cookies", "/legal/refunds", "/legal/delivery", "/legal/creators", "/legal/purchase-agreement", "/legal/support"])("blank mode hides anonymous page %s without mounting the product", async path => {
  load.mockResolvedValue({ ...state(), public_page: "blank" });
  const response = await request(path, { headers: { cookie: "sb-forged=owner", RSC: "1" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBeNull();
  expect(response.headers.get("x-robots-tag")).toContain("noindex");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
  const html = await response.text();
  expect(html).toContain("<body></body>");
  expect(html).not.toMatch(/CreatorNet|Coming soon|discord|<script|<a\s|\/legal\//i);
});

test("blank mode preserves owner access, buyer policies, fulfillment and private sign-in", async () => {
  load.mockResolvedValue({ ...state(), public_page: "blank" });
  expect((await request("/auth?next=%2Fadmin%2Freleases")).headers.get("x-middleware-next")).toBe("1");
  identity.mockResolvedValue({ id: "buyer", email_confirmed_at: "yes" });
  expect((await request("/legal/support")).headers.get("x-middleware-next")).toBe("1");
  expect((await request("/library")).headers.get("x-middleware-next")).toBe("1");
  expect((await request("/api/feed")).status).toBe(403);
  privateAccess.mockResolvedValue(true); identity.mockResolvedValue({ id: "owner", email_confirmed_at: "yes" });
  expect((await request("/admin/releases")).headers.get("x-middleware-next")).toBe("1");
  expect((await request("/dashboard")).headers.get("x-middleware-next")).toBe("1");
});

test("switching back restores Coming Soon and public legal pages; opening features ignores the holding choice", async () => {
  const settings = { ...state(), public_page: "blank" as "blank" | "coming-soon" }; load.mockResolvedValue(settings);
  expect(await (await request("/")).text()).toContain("<body></body>");
  settings.public_page = "coming-soon";
  expect(await (await request("/")).text()).toContain("Coming soon.");
  expect((await request("/legal/privacy")).headers.get("x-middleware-next")).toBe("1");
  settings.public_page = "blank"; settings.hidden = false; settings.features.feed = true;
  expect((await request("/dashboard")).headers.get("x-middleware-next")).toBe("1");
  expect((await request("/legal/privacy")).headers.get("x-middleware-next")).toBe("1");
});

test("blank HEAD has no body, and API/action denials remain unchanged", async () => {
  load.mockResolvedValue({ ...state(), public_page: "blank" });
  const head = await request("/legal/terms", { method: "HEAD" });
  expect(await head.text()).toBe(""); expect(head.headers.get("cache-control")).toContain("no-store");
  expect((await request("/api/feed")).status).toBe(401);
  expect((await request("/api/admin/releases/public-page", { method: "PATCH" })).status).toBe(401);
  expect((await request("/", { method: "POST", headers: { "next-action": "forged" } })).status).toBe(403);
});
