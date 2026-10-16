/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentProps } from "react";
import type VideoCard from "@/components/VideoCard";
import type { PostRow } from "@/lib/feedV3";
let desktop = false;
const cards = new Map<string, ComponentProps<typeof VideoCard>>();
const mockDiscoverPage = jest.fn();
const page = (ids = ["one", "two"]) => ({
  items: ids.map(post_id => ({ post_id, creator_id: "creator", video_url: `https://example.test/${post_id}.mp4` })),
  session: "candidate-session", nextOffset: ids.length, hasMore: false,
});
const channel = { on: jest.fn().mockReturnThis(), subscribe: jest.fn().mockReturnThis() };
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ channel: () => channel, removeChannel: jest.fn() }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "candidate-viewer", loading: false }) }));
jest.mock("@/lib/browserVisibility", () => ({ useDesktopViewport: () => desktop, usePageVisible: () => true }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (value: unknown) => value }));
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: (props: ComponentProps<typeof VideoCard>) => {
  cards.set(props.postId!, props); return createElement("div", { "data-card": props.postId });
} }));
jest.mock("@/lib/discoverClient", () => ({ rememberDiscoverSession: jest.fn(), fetchDiscoverPage: (...args: unknown[]) => mockDiscoverPage(...args) }));
import FeedList from "@/components/FeedList";
import { clearMobileFeedSnapshot, saveMobileFeedSnapshot } from "@/lib/mobileFeedSnapshot";
import { mobileFeedHandoffSnapshot } from "@/lib/mobileFeedCandidate";
import { exportFeedTrace } from "@/lib/mobileFeedDiagnostics";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopObserver { observe() {} unobserve() {} disconnect() {} }
let root: Root, container: HTMLDivElement;
let savedObserver: typeof IntersectionObserver, savedFetch: typeof global.fetch;
let savedFrameCallback: typeof HTMLVideoElement.prototype.requestVideoFrameCallback;
beforeEach(() => {
  desktop = false; cards.clear();
  mockDiscoverPage.mockReset().mockResolvedValue(page());
  for (const tab of ["discover", "following"] as const) clearMobileFeedSnapshot(tab, "candidate-viewer");
  savedFrameCallback = HTMLVideoElement.prototype.requestVideoFrameCallback;
  HTMLVideoElement.prototype.requestVideoFrameCallback = jest.fn();
  window.history.replaceState({}, "", "/?feedTransfer=prepared-preload-audio"); mobileFeedHandoffSnapshot();
  savedObserver = global.IntersectionObserver; global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver;
  savedFetch = global.fetch; global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ offers: {} }) });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  global.IntersectionObserver = savedObserver; global.fetch = savedFetch;
  HTMLVideoElement.prototype.requestVideoFrameCallback = savedFrameCallback;
});
async function render(tab: "discover" | "following") {
  await act(async () => root.render(createElement(FeedList, { activeTab: tab, onChangeTab: jest.fn() })));
  expect(cards.size).toBe(2);
}

test.each(["discover", "following"] as const)("%s passes the default prepared controller to its actual cards without a selector", async tab => {
  window.history.replaceState({}, "", `/dashboard?tab=${tab}`);
  await render(tab);
  expect([...cards.values()].every(card => card.mobileHandoff === "prepared-preload-audio")).toBe(true);
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-feed-tab")).toBe(tab);
  expect(container.querySelector("[data-mobile-feed-transfer]")?.getAttribute("data-mobile-feed-transfer")).toBe("prepared-preload-audio");
  expect(exportFeedTrace().context).toEqual(expect.objectContaining({ feed: tab, mode: "candidate", feedTransfer: "prepared-preload-audio", retiredSourceCleanup: "immediate" }));
  window.history.replaceState({}, "", "/");
  await render(tab === "discover" ? "following" : "discover");
  expect([...cards.values()].every(card => card.mobileHandoff === "prepared-preload-audio")).toBe(true);
});

test.each([false, true])("baseline and desktop stay outside prepared transfer (desktop=%s)", async isDesktop => {
  desktop = isDesktop;
  window.history.replaceState({}, "", desktop ? "/dashboard" : "/dashboard?feedTransfer=0");
  await render("discover");
  expect([...cards.values()].every(card => card.mobileHandoff === false)).toBe(true);
  expect(container.querySelector("[data-mobile-feed-transfer]")?.getAttribute("data-mobile-feed-transfer")).toBe(desktop ? "desktop" : "conventional");
});

test("a mobile browser without frame callbacks keeps conventional cards without a forced prepared watchdog", async () => {
  HTMLVideoElement.prototype.requestVideoFrameCallback = undefined as unknown as typeof savedFrameCallback;
  window.history.replaceState({}, "", "/dashboard");
  await render("discover");
  expect([...cards.values()].every(card => card.mobileHandoff === false)).toBe(true);
  expect(container.querySelector("[data-mobile-feed-transfer]")?.getAttribute("data-mobile-feed-transfer")).toBe("conventional");
});

// JSDOM has no layout or CSS scrolling. Model the browser rule that an implicit
// scrollTop assignment on this scroll-smooth container queues a smooth scroll;
// only an instant scroll (or temporarily disabling smooth CSS) moves it now.
// The assertions concern the restored viewport, not a particular API call.
function modelSmoothFeedScroll() {
  const positions = new WeakMap<Element, number>();
  const queued = new Map<Element, number>();
  const topDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const toDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
  const bounds = jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const section = this as HTMLElement;
    const scroller = section.closest(".scroll-smooth");
    const index = section.dataset.postId && section.parentElement
      ? [...section.parentElement.children].indexOf(section) : 0;
    const top = section.dataset.postId ? index * 600 - (scroller?.scrollTop ?? 0) : 0;
    return { x: 0, y: top, top, left: 0, right: 400, bottom: top + 600, width: 400, height: 600, toJSON: () => ({}) };
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get() { return positions.get(this) ?? 0; },
    set(value: number) {
      if (this.classList.contains("scroll-smooth") && (this as HTMLElement).style.scrollBehavior !== "auto") {
        if (value !== (positions.get(this) ?? 0)) queued.set(this, value);
      } else { positions.set(this, value); queued.delete(this); }
    },
  });
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value(this: Element, options: ScrollToOptions) {
      if (options.behavior === "instant") { positions.set(this, options.top ?? this.scrollTop); queued.delete(this); }
      else this.scrollTop = options.top ?? this.scrollTop;
    },
  });
  return {
    queued,
    restore() {
      bounds.mockRestore();
      if (topDescriptor) Object.defineProperty(Element.prototype, "scrollTop", topDescriptor);
      else delete (Element.prototype as Partial<Element>).scrollTop;
      if (toDescriptor) Object.defineProperty(Element.prototype, "scrollTo", toDescriptor);
      else delete (Element.prototype as Partial<Element>).scrollTo;
    },
  };
}

function seedReturn(activePostId: string, scrollTop: number) {
  const rows: PostRow[] = ["one", "two"].map(id => ({
    id, creator_id: "creator", product_id: null, price_cents: null, title: id,
    video_url: `https://example.test/${id}.mp4`, poster_url: null, content: null, interests: null, created_at: null,
  }));
  saveMobileFeedSnapshot("discover", "candidate-viewer", rows, activePostId, scrollTop);
}

test("profile return restores its saved viewport before a smooth scroll can pass other cards", async () => {
  const scroll = modelSmoothFeedScroll();
  let finish!: (value: ReturnType<typeof page>) => void;
  const pending = new Promise<ReturnType<typeof page>>(resolve => { finish = resolve; });
  mockDiscoverPage.mockReturnValueOnce(pending);
  seedReturn("two", 600);
  try {
    await render("discover");
    const scroller = container.querySelector<HTMLDivElement>(".scroll-smooth")!;
    expect(scroller.scrollTop).toBe(600);
    expect(scroll.queued.size).toBe(0);
    expect(cards.get("two")?.isActive).toBe(true);
  } finally {
    await act(async () => finish(page()));
    scroll.restore();
  }
});

test("profile revalidation keeps its active card fixed when fresh ranking moves that card", async () => {
  const scroll = modelSmoothFeedScroll();
  let finish!: (value: ReturnType<typeof page>) => void;
  const pending = new Promise<ReturnType<typeof page>>(resolve => { finish = resolve; });
  mockDiscoverPage.mockReturnValueOnce(pending);
  seedReturn("one", 0);
  try {
    await render("discover");
    const scroller = container.querySelector<HTMLDivElement>(".scroll-smooth")!;
    expect(scroller.scrollTop).toBe(0);
    await act(async () => finish(page(["two", "one"])));
    expect(scroller.scrollTop).toBe(600);
    expect(scroll.queued.size).toBe(0);
    expect(cards.get("one")?.isActive).toBe(true);
  } finally {
    await act(async () => finish(page(["two", "one"])));
    scroll.restore();
  }
});
