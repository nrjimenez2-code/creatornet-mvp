/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const db = createMockClient(), router = { push: jest.fn(), back: jest.fn() };
jest.mock("@/lib/supabaseClient", () => ({ supabase: db }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "buyer", loading: false }) }));
jest.mock("next/navigation", () => ({ useRouter: () => router }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (v: unknown) => v }));
jest.mock("@/components/CommentPanel", () => ({ __esModule: true, default: () => null }));
import ProfilePostsGallery from "@/components/ProfilePostsGallery";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class Observer { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: Observer });
Element.prototype.scrollIntoView = jest.fn();
const terms = { version: "monthly-mentorship-v1" as const, minimumMonths: 3, autoRenew: true };
const post = { id: "post & 1", creator_id: "creator", product_id: "product/1", title: "A-M1",
  poster_url: "poster.jpg", price_cents: 10000, product_type: "mentorship", monthlyTerms: terms,
  purchaseOptionsReady: true, allow_booking: true, booking_url: "https://booking.invalid" };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "Synthetic stop" }) })) as unknown as typeof fetch;
  jest.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.restoreAllMocks(); });
async function open(overrides: Record<string, unknown> = {}) {
  await act(async () => root.render(createElement(ProfilePostsGallery, {
    posts: [{ ...post, ...overrides }], creatorId: "creator", creatorName: "Creator",
  })));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open post: A-M1"]')!.click());
}
async function menu(label: string) {
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
  const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b => b.textContent!.includes(label));
  expect(item).toBeDefined(); return item!;
}
test("the actual gallery and VideoCard disclose monthly terms and enter the matching review without Checkout", async () => {
  await open();
  expect(container.textContent).toContain("$100.00/month");
  expect(container.textContent).toContain("3-month minimum commitment");
  expect(container.textContent).toContain("Renews monthly after the minimum until canceled");
  await act(async () => (await menu("Buy monthly mentorship")).click());
  expect(router.push).toHaveBeenCalledWith("/memberships/review?product_id=product%2F1&post_id=post+%26+1");
  expect((global.fetch as jest.Mock).mock.calls.some(([url]) => url === "/api/checkout" || url === "/api/memberships/checkout")).toBe(false);
});
test("unknown product terms disable paid purchase but preserve the separate free Book flow", async () => {
  await open({ monthlyTerms: null, purchaseOptionsReady: false });
  expect((await menu("Purchase unavailable")).disabled).toBe(true);
  const book = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b => b.textContent!.includes("Book"))!;
  await act(async () => book.click());
  const call = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === "/api/checkout")!;
  expect(JSON.parse(call[1].body)).toEqual({ type: "booking", post_id: post.id, creator_id: "creator", bookingRedirectUrl: post.booking_url });
  expect(router.push).not.toHaveBeenCalled();
});
test.each(["video", "course", "mentorship", "call"])("fixed/ordinary %s still uses its product flow", async productType => {
  await open({ monthlyTerms: null, product_type: productType });
  expect(container.textContent).not.toContain("/month");
  await act(async () => (await menu(productType === "call" ? "Pay for call" : "Pay in full")).click());
  const call = (global.fetch as jest.Mock).mock.calls.find(([url]) => url === "/api/checkout")!;
  expect(JSON.parse(call[1].body)).toMatchObject({ type: "product", product_id: post.product_id, post_id: post.id, buyer_id: "buyer" });
});
