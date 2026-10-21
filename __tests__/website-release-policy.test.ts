import { closedFeatures, dependenciesMet, featureOpen, routePolicy, validDiscordInvite, validFlags, SETTINGS_ID, type ReleaseSettings } from "@/lib/release/policy";
import { launchHtml } from "@/lib/release/launch";
const settings = (): ReleaseSettings => ({ id: SETTINGS_ID, owner_id: "owner", hidden: true, features: closedFeatures(), discord_invite: "https://discord.gg/bKC8q4z6B", revision: 0, updated_at: "now" });
test("initial state closes every public capability; hide retains feature choices", () => {
  const state = settings(); expect(Object.values(state.features).every(value => value === false)).toBe(true);
  state.features.feed = true; expect(featureOpen(state, "feed")).toBe(false);
  state.hidden = false; expect(featureOpen(state, "feed")).toBe(true); expect(featureOpen(state, "search")).toBe(false);
  state.hidden = true; expect(featureOpen(state, "feed")).toBe(false); expect(state.features.feed).toBe(true);
});
test("missing configuration, malformed flags and missing dependencies fail closed", () => {
  expect(featureOpen(null, "feed")).toBe(false); expect(validFlags({ ...closedFeatures(), future: true })).toBe(false);
  expect(validFlags({ feed: true })).toBe(false); expect(validFlags({ ...closedFeatures(), feed: "true" })).toBe(false);
  const state = settings(); state.hidden = false; state.features.search = true;
  expect(dependenciesMet(state.features)).toBe(false); expect(featureOpen(state, "search")).toBe(false);
  state.features.feed = state.features.profiles = true; expect(featureOpen(state, "search")).toBe(true);
});
test.each(["/future-product", "/api/future", "/api/stripe/future", "/product.json", "/api/webhook/extra"])("unknown route %s remains restricted", path => {
  expect(routePolicy(path)).toEqual({ kind: "product", feature: undefined });
});
test.each([["/api/stripe/webhook", "POST"], ["/api/webhook", "POST"], ["/api/scheduling/google/jobs", "GET"], ["/api/memberships/collect", "GET"]])("operation exception %s uses only its exact method", (path, method) => {
  expect(routePolicy(path, method).kind).toBe("operation"); expect(routePolicy(path, method === "POST" ? "GET" : "POST").kind).not.toBe("operation");
});
test.each([["/api/library/eligibility", "POST"], ["/api/private-videos/id/progress", "PUT"], ["/api/private-videos/id/download", "POST"], ["/api/calls/id/schedule", "GET"], ["/api/memberships/id/payoff", "GET"], ["/api/installments/recovery", "GET"], ["/api/scheduling/google/reservations/id", "DELETE"]])("preserves authenticated fulfillment %s %s", (path, method) => expect(routePolicy(path, method).kind).toBe("purchase"));
test("new purchases, uploads, bookings and admin access are not purchase exceptions", () => {
  for (const path of ["/api/checkout", "/api/book", "/api/upload/presign", "/api/memberships/checkout", "/purchase/review"]) expect(routePolicy(path, "POST").kind).toBe("product");
  expect(routePolicy("/api/scheduling/google/book/id", "POST").kind).toBe("continuation");
  expect(routePolicy("/admin/releases").kind).toBe("owner"); expect(routePolicy("/api/admin/refunds", "POST").kind).toBe("owner");
  expect(routePolicy("/profile/edit").feature).toBe("creatorTools");
});
test("existing setup callbacks can finish without opening new setup or unknown providers", () => {
  for (const path of ["/api/stripe/connect/return", "/api/stripe/connect/refresh", "/api/scheduling/oauth/callback/google", "/api/scheduling/oauth/callback/calcom", "/api/scheduling/oauth/callback/calendly"]) {
    expect(routePolicy(path, "GET").kind).toBe("purchase"); expect(routePolicy(path, "POST").kind).toBe("product");
  }
  for (const path of ["/api/stripe/connect/onboard", "/api/scheduling/oauth/start", "/api/scheduling/oauth/callback/unknown"]) expect(routePolicy(path).kind).toBe("product");
});
test("launch HTML contains legal/private access and only a validated Discord destination", () => {
  const html = launchHtml("https://discord.gg/bKC8q4z6B"); expect(html).toContain("Coming soon."); expect(html).toContain("Join our Discord"); expect(html).toContain("/auth?next=%2Fprivate-access");
  expect(html).not.toMatch(/<script|\/dashboard|\/api\/|video_url|post_id/); expect(html).toContain('/legal/support');
  expect(validDiscordInvite('https://discord.gg/x" onclick="evil')).toBe(false); expect(launchHtml("javascript:alert(1)")).not.toContain("javascript:");
});
