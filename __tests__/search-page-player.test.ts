/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import SearchPage from "@/app/search/page";
import { EMPTY_SEARCH } from "@/lib/searchTypes";

const mockSearch = { result: { ...EMPTY_SEARCH,
  creators: [{ id: "luis", username: "luis", full_name: "Luis", avatar_url: null, tagline: "tagline", match_reason: "Matches public posts", match_evidence: "Dropshipping evidence", related_match: false }],
  items: [0, 1].map(index => ({ id: `p${index}`, creator_id: "luis", creator: { username: "luis" }, caption: `Video ${index}`, content: null, media_url: null, poster_url: null })),
  totals: { creators: 1, videos: 2, offerings: 0 },
}, loading: false, error: "", hasMore: false, loadMore: jest.fn(), retry: jest.fn() };
const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => mockRouter, useSearchParams: () => new URLSearchParams("q=e-commerce") }));
jest.mock("@/lib/useSearchResults", () => ({ useSearchResults: () => mockSearch }));
jest.mock("@/lib/posthog", () => ({ trackEvent: jest.fn() }));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/SearchSuggestions", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ children, ...props }: { children: never }) => createElement("a", props, children) }));
jest.mock("next/dynamic", () => ({ __esModule: true, default: () => (props: { initialIndex: number; posts: {id: string}[]; onClose: () => void }) => createElement("div", {
  role: "dialog", "data-index": props.initialIndex, "data-posts": props.posts.map(post => post.id).join(","),
}, createElement("button", { onClick: props.onClose }, "Close player")) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(async () => {
  jest.clearAllMocks();
  window.history.replaceState({}, "", "/search?q=e-commerce");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(SearchPage)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); jest.restoreAllMocks(); });

test("search cards omit match explanations and the category reads Offers", () => {
  expect(host.textContent).not.toContain("Matches public posts");
  expect(host.textContent).not.toContain("Dropshipping evidence");
  expect(host.textContent).not.toMatch(/offerings/i);
  expect(host.textContent).toContain("Offers");
  expect(host.querySelector('a[href="/profile/luis"]')).not.toBeNull();
});

test("video opens the chosen search result without navigating and browser Back preserves query and tab", async () => {
  const videos = Array.from(host.querySelectorAll('[role="tab"]')).find(tab => tab.textContent?.startsWith("videos")) as HTMLButtonElement;
  await act(async () => videos.click());
  await act(async () => (host.querySelector('[aria-label="Open video: Video 1"]') as HTMLButtonElement).click());
  expect(host.querySelector('[role="dialog"]')?.getAttribute("data-index")).toBe("1");
  expect(host.querySelector('[role="dialog"]')?.getAttribute("data-posts")).toBe("p0,p1");
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe("/search");
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(true);
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(videos.getAttribute("aria-selected")).toBe("true");
  expect((host.querySelector('input') as HTMLInputElement).value).toBe("e-commerce");
  expect(host.querySelector("main")?.hasAttribute("inert")).toBe(false);
});

test("double Close consumes only the player history entry", async () => {
  await act(async () => (host.querySelector('[aria-label="Open video: Video 0"]') as HTMLButtonElement).click());
  const back = jest.spyOn(window.history, "back").mockImplementation(() => {});
  const close = host.querySelector('[role="dialog"] button') as HTMLButtonElement;
  await act(async () => { close.click(); close.click(); });
  expect(back).toHaveBeenCalledTimes(1);
});
