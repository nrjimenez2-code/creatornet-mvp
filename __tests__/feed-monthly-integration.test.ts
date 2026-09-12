/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
let realtime: (event: any) => void;
let rpc: jest.Mock;
const channel = { on: (_event: unknown, _filter: unknown, fn: typeof realtime) => { realtime = fn; return channel; }, subscribe: () => channel };
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ rpc: (...args: unknown[]) => rpc(...args), channel: () => channel, removeChannel: jest.fn() }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "buyer", loading: false }) }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (v: unknown) => v }));
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: (props: any) => createElement("div", { "data-card": props.postId, "data-props": JSON.stringify(props) }) }));
import FeedList from "@/components/FeedList";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let observe: (entries: any[]) => void;
class Observer {
  constructor(fn: typeof observe) { observe = fn; }
  observe() {} unobserve() {} disconnect() {}
}
(globalThis as any).IntersectionObserver = Observer;
let container: HTMLDivElement, root: Root;
const terms = { version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true };
const row = (id: string) => ({ post_id: id, creator_id: "creator", product_id: `alias-${id}`, product_type: "mentorship", poster_url: "poster.jpg", price_cents: 100 });
const response = (ids: string[], monthlyTerms: unknown = terms) => ({ ok: true, json: async () => ({ offers: Object.fromEntries(ids.map(id => [id, {
  productId: `product-${id}`, linkedProductId: `alias-${id}`, creatorId: "creator", productType: "mentorship", priceCents: 9900, monthlyTerms,
}])) }) });
const props = (id: string) => JSON.parse(container.querySelector(`[data-card="${id}"]`)!.getAttribute("data-props")!);
beforeEach(() => {
  rpc = jest.fn(async () => ({ data: [row("one")], error: null }));
  global.fetch = jest.fn(async (url: string) => response(new URL(url, "https://site.invalid").searchParams.get("ids")!.split(","))) as unknown as typeof fetch;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async (activeTab: "discover" | "following" = "discover") => act(async () => root.render(createElement(FeedList, { activeTab, onChangeTab: jest.fn() })));
test("initial feed passes canonical product/post identity, terms and product monthly price to VideoCard", async () => {
  await render();
  expect(props("one")).toMatchObject({ postId: "one", productId: "product-one", priceCents: 9900, monthlyTerms: terms, purchaseOptionsReady: true });
});

test("media renders while offer data is pending, with purchases disabled", async () => {
  let finish!: (v: unknown) => void;
  (global.fetch as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  expect(props("one")).toMatchObject({ purchaseOptionsReady: false, monthlyTerms: null });
  expect(container.textContent).not.toContain("Loading…");
  await act(async () => finish(response(["one"])));
  expect(props("one")).toMatchObject({ purchaseOptionsReady: true, productId: "product-one" });
});

test("late initial offers cannot overwrite a newer realtime refresh", async () => {
  let finish!: (v: unknown) => void;
  (global.fetch as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  (global.fetch as jest.Mock).mockResolvedValueOnce(response(["one"], { ...terms, minimumMonths: 6 }));
  await act(async () => realtime({ eventType: "UPDATE", new: { id: "one", creator_id: "creator", product_id: "alias-one", poster_url: "poster.jpg" } }));
  await act(async () => finish(response(["one"])));
  expect(props("one").monthlyTerms.minimumMonths).toBe(6);
});
test("pagination enriches additional monthly cards", async () => {
  rpc.mockImplementation(async (_name, args) => ({ data: args.p_offset === 0 ? Array.from({ length: 20 }, (_, i) => row(String(i))) : [row("next")], error: null }));
  await render();
  await act(async () => observe([{ isIntersecting: true, intersectionRatio: 1, target: container.querySelector('[data-post-id="19"]') }]));
  expect(rpc).toHaveBeenCalledWith("get_feed_v3", expect.objectContaining({ p_offset: 20 }));
  expect(props("next")).toMatchObject({ productId: "product-next", monthlyTerms: terms, purchaseOptionsReady: true });
});
test("realtime inserts keep the current card in place until an explicit ranked refresh", async () => {
  await render();
  await act(async () => realtime({ eventType: "INSERT", new: { id: "two", creator_id: "creator", poster_url: "poster.jpg" } }));
  expect(container.querySelector('[data-card="two"]')).toBeNull();
  expect(props("one").isActive).toBe(true);
  rpc.mockResolvedValue({ data: [row("two"), row("one")], error: null });
  await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("New posts"))!.click());
  expect(props("two")).toMatchObject({ productId: "product-two", priceCents: 9900, monthlyTerms: terms, purchaseOptionsReady: true });
  expect(props("two").isActive).toBe(true);
});

test("offer enrichment does not rebuild the visibility observer", async () => {
  let finish!: (value: unknown) => void;
  (global.fetch as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  const originalObserver = observe;
  await act(async () => finish(response(["one"])));
  expect(observe).toBe(originalObserver);
});

test("a failed later page retries the same offset without moving or duplicating cards", async () => {
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    rpc.mockResolvedValueOnce({ data: Array.from({ length: 20 }, (_, index) => row(String(index))), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "offline" } })
      .mockResolvedValueOnce({ data: [row("next")], error: null });
    await render();
    await act(async () => observe([{ isIntersecting: true, intersectionRatio: 1, target: container.querySelector('[data-post-id="19"]') }]));
    expect(props("19").isActive).toBe(true);
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Retry"))!.click());
    expect(rpc.mock.calls.slice(1).map(call => call[1].p_offset)).toEqual([20, 20]);
    expect(props("19").isActive).toBe(true);
    expect(container.querySelectorAll('[data-post-id="next"]')).toHaveLength(1);
  } finally { errors.mockRestore(); }
});
test("realtime update blocks Buy while refreshing and discards an older metadata response", async () => {
  await render();
  let finish!: (v: unknown) => void;
  (global.fetch as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => realtime({ eventType: "UPDATE", new: { id: "one", creator_id: "creator", product_id: "alias-one", poster_url: "poster.jpg" } }));
  expect(props("one").purchaseOptionsReady).toBe(false);
  (global.fetch as jest.Mock).mockResolvedValueOnce(response(["one"], { ...terms, minimumMonths: 6 }));
  await act(async () => realtime({ eventType: "UPDATE", new: { id: "one", creator_id: "creator", product_id: "alias-one", poster_url: "poster.jpg" } }));
  await act(async () => finish(response(["one"])));
  expect(props("one").monthlyTerms.minimumMonths).toBe(6);
});
test("tab change discards stale initial enrichment", async () => {
  let finish!: (v: unknown) => void;
  (global.fetch as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  rpc.mockResolvedValue({ data: [row("following")], error: null });
  await render("following");
  await act(async () => finish(response(["one"])));
  expect(container.querySelector('[data-card="one"]')).toBeNull();
  expect(props("following").monthlyTerms).toEqual(terms);
});

test("native trackpad events are not swallowed and visibility controls playback", async () => {
  const scroll = jest.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  rpc.mockResolvedValue({ data: [row("one"), row("two"), row("three")], error: null });
  await render();
  const section = (id: string) => container.querySelector(`[data-post-id="${id}"]`)!;
  await act(async () => observe([{ target: section("one"), isIntersecting: true, intersectionRatio: 1 }]));
  expect(props("one").isActive).toBe(true);
  expect(props("two").preload).toBe("auto");
  expect(props("three").preload).toBe("metadata");
  const scroller = section("one").parentElement!;
  expect(scroller.style.touchAction).toBe("pan-y pinch-zoom");
  for (const delta of [1, 3, 60, 20, 8, -5, -60]) {
    const event = new WheelEvent("wheel", { deltaY: delta, bubbles: true, cancelable: true });
    await act(async () => { scroller.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(scroll).not.toHaveBeenCalled();
  await act(async () => observe([{ target: section("one"), isIntersecting: true, intersectionRatio: 0.49 }, { target: section("two"), isIntersecting: true, intersectionRatio: 0.51 }]));
  expect(props("one").isActive).toBe(false);
  expect(props("two").isActive).toBe(true);
});
