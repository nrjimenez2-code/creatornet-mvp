/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const db = createMockClient();
const router = { push: jest.fn() };
let user = { userId: "buyer" as string | null, loading: false };
jest.mock("@/lib/supabaseClient", () => ({ supabase: db }));
jest.mock("@/lib/useUser", () => ({ useUser: () => user }));
jest.mock("next/navigation", () => ({ useRouter: () => router }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (v: unknown) => v }));
jest.mock("@/components/CommentPanel", () => ({ __esModule: true, default: () => null }));
import VideoCard from "@/components/VideoCard";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class Observer { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).IntersectionObserver = Observer;
let container: HTMLDivElement, root: Root;
const terms = { version: "monthly-mentorship-v1" as const, minimumMonths: 3, autoRenew: true };
const base = { postId: "post & 1", productId: "product/1", creatorId: "creator", productType: "mentorship",
  priceCents: 9900, monthlyTerms: terms, purchaseOptionsReady: true, showCTA: true,
  poster: "poster.jpg", allowBooking: true, bookingRedirectUrl: "https://booking.invalid" };
beforeEach(() => {
  jest.clearAllMocks(); user = { userId: "buyer", loading: false };
  global.fetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "Synthetic checkout stop" }) })) as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.restoreAllMocks(); });
async function render(overrides: Partial<Parameters<typeof VideoCard>[0]> = {}) {
  await act(async () => root.render(createElement(VideoCard, { ...base, ...overrides })));
}
async function menu(label: string) {
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b => b.textContent!.includes(label))!;
  expect(button).toBeDefined(); return button;
}
test("monthly price, minimum and renewal display and Buy enters review with exact encoded identity", async () => {
  const override = jest.fn(); await render({ onBuy: override });
  expect(container.textContent).toContain("$99.00/month");
  expect(container.textContent).toContain("3-month minimum commitment");
  expect(container.textContent).toContain("Renews monthly after the minimum until canceled");
  await act(async () => (await menu("Buy monthly mentorship")).click());
  expect(router.push).toHaveBeenCalledWith("/memberships/review?product_id=product%2F1&post_id=post+%26+1");
  expect(override).not.toHaveBeenCalled();
  expect((global.fetch as jest.Mock).mock.calls.some(([url]) => url === "/api/checkout" || url === "/api/memberships/checkout")).toBe(false);
});
test("one paid month and non-renewing cadence are explicit", async () => {
  await render({ monthlyTerms: { ...terms, minimumMonths: 1, autoRenew: false } });
  expect(container.textContent).toContain("One paid month; no additional minimum");
  expect(container.textContent).toContain("Ends after 1 month; no automatic renewal");
});
test("signed out monthly Buy goes to auth", async () => {
  user.userId = null; await render(); const button = await menu("Buy monthly");
  await act(async () => button.click()); expect(router.push).toHaveBeenCalledWith("/auth");
});
test.each(["auth", "metadata", "seller"])("%s gate prevents monthly review", async gate => {
  if (gate === "auth") user.loading = true;
  await render({ purchaseOptionsReady: gate === "auth" });
  const button = await menu(gate === "auth" ? "Buy monthly" : "Purchase unavailable");
  expect(button.disabled).toBe(true); await act(async () => button.click()); expect(router.push).not.toHaveBeenCalled();
});
test.each(["productId", "postId"] as const)("missing %s cannot start monthly review", async key => {
  await render({ [key]: null }); const button = await menu("Buy monthly");
  await act(async () => button.click()); expect(router.push).not.toHaveBeenCalled();
});
test("free Book keeps its existing payload on the same monthly post even when Buy is blocked", async () => {
  await render({ purchaseOptionsReady: false }); const button = await menu("Book");
  await act(async () => button.click());
  const call = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === "/api/checkout")!;
  expect(JSON.parse(call[1].body)).toEqual({ type: "booking", post_id: base.postId, creator_id: "creator", bookingRedirectUrl: base.bookingRedirectUrl });
  expect(router.push).not.toHaveBeenCalled();
});
test.each(["video", "course", "mentorship", "call"])("ordinary/fixed %s retains generic product checkout", async productType => {
  await render({ monthlyTerms: null, productType, planMonths: 3 });
  expect(container.textContent).not.toContain("/month");
  const button = await menu(productType === "call" ? "Pay for call" : "Pay in full");
  await act(async () => button.click());
  const call = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === "/api/checkout")!;
  expect(JSON.parse(call[1].body)).toMatchObject({ type: "product", product_id: base.productId, post_id: base.postId, buyer_id: "buyer" });
  expect(router.push).not.toHaveBeenCalled();
});
