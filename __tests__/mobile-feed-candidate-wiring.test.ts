/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComponentProps } from "react";
import type VideoCard from "@/components/VideoCard";
let desktop = false;
const cards = new Map<string, ComponentProps<typeof VideoCard>>();
const channel = { on: jest.fn().mockReturnThis(), subscribe: jest.fn().mockReturnThis() };
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({ channel: () => channel, removeChannel: jest.fn() }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "candidate-viewer", loading: false }) }));
jest.mock("@/lib/browserVisibility", () => ({ useDesktopViewport: () => desktop, usePageVisible: () => true }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn(), normalizeCategory: (value: unknown) => value }));
jest.mock("@/components/VideoCard", () => ({ __esModule: true, default: (props: ComponentProps<typeof VideoCard>) => {
  cards.set(props.postId!, props); return createElement("div", { "data-card": props.postId });
} }));
jest.mock("@/lib/discoverClient", () => ({ rememberDiscoverSession: jest.fn(), fetchDiscoverPage: async () => ({
  items: ["one", "two"].map(post_id => ({ post_id, creator_id: "creator", video_url: `https://example.test/${post_id}.mp4` })),
  session: "candidate-session", nextOffset: 2, hasMore: false,
}) }));
import FeedList from "@/components/FeedList";
import { clearMobileFeedSnapshot } from "@/lib/mobileFeedSnapshot";
import { mobileFeedHandoffSnapshot } from "@/lib/mobileFeedCandidate";
import { exportFeedTrace } from "@/lib/mobileFeedDiagnostics";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoopObserver { observe() {} unobserve() {} disconnect() {} }
let root: Root, container: HTMLDivElement;
let savedObserver: typeof IntersectionObserver, savedFetch: typeof global.fetch;
beforeEach(() => {
  desktop = false; cards.clear();
  for (const tab of ["discover", "following"] as const) clearMobileFeedSnapshot(tab, "candidate-viewer");
  window.history.replaceState({}, "", "/?feedTransfer=0"); mobileFeedHandoffSnapshot();
  savedObserver = global.IntersectionObserver; global.IntersectionObserver = NoopObserver as unknown as typeof IntersectionObserver;
  savedFetch = global.fetch; global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ offers: {} }) });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  global.IntersectionObserver = savedObserver; global.fetch = savedFetch;
});
async function render(tab: "discover" | "following") {
  await act(async () => root.render(createElement(FeedList, { activeTab: tab, onChangeTab: jest.fn() })));
  expect(cards.size).toBe(2);
}

test.each(["discover", "following"] as const)("%s passes the opt-in prepared controller to its actual cards", async tab => {
  window.history.replaceState({}, "", "/?feedTransfer=prepared-preload-audio");
  await render(tab);
  expect([...cards.values()].every(card => card.mobileHandoff === "prepared-preload-audio")).toBe(true);
  expect(exportFeedTrace().context).toEqual(expect.objectContaining({ feed: tab, mode: "candidate", feedTransfer: "prepared-preload-audio", retiredSourceCleanup: "immediate" }));
  window.history.replaceState({}, "", "/");
  await render(tab === "discover" ? "following" : "discover");
  expect([...cards.values()].every(card => card.mobileHandoff === "prepared-preload-audio")).toBe(true);
});

test.each([false, true])("baseline and desktop stay outside prepared transfer (desktop=%s)", async isDesktop => {
  desktop = isDesktop;
  if (desktop) window.history.replaceState({}, "", "/?feedTransfer=prepared-preload-audio");
  await render("discover");
  expect([...cards.values()].every(card => card.mobileHandoff === false)).toBe(true);
});
