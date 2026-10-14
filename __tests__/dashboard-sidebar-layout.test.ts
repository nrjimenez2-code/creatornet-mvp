/** @jest-environment jsdom */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

let mockUserId: string | null = "viewer";
const searchParams = new URLSearchParams();
const router = { replace: jest.fn(), push: jest.fn() };
let feedMounts = 0;
jest.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => searchParams }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: mockUserId, loading: false }) }));
jest.mock("@/components/FeedList", () => {
  function MockFeedList({ activeTab, openTipPostId, resumeTipId, onTipReturnClosed }: {
    activeTab: string; openTipPostId?: string | null; resumeTipId?: string | null; onTipReturnClosed?: () => void;
  }) {
    useEffect(() => { feedMounts += 1; }, []);
    return createElement("div", { "data-feed-tab": activeTab, "data-open-tip-post-id": openTipPostId ?? "", "data-resume-tip-id": resumeTipId ?? "" },
      createElement("button", { onClick: onTipReturnClosed }, "Close returned tip"));
  }
  return { __esModule: true, default: MockFeedList };
});
import DashboardPage from "@/app/dashboard/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mockUserId = "viewer";
  searchParams.delete("tab");
  searchParams.delete("postId");
  searchParams.delete("tip");
  searchParams.delete("tipId");
  feedMounts = 0;
  jest.clearAllMocks();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });

test("Following direct URL and browser Back select the right feed without a second desktop sidebar", async () => {
  searchParams.set("tab", "following");
  await act(async () => root.render(createElement(DashboardPage)));
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-feed-tab")).toBe("following");
  expect(container.querySelector("aside")).toBeNull();
  const firstMounts = feedMounts;

  searchParams.delete("tab");
  await act(async () => root.render(createElement(DashboardPage)));
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-feed-tab")).toBe("discover");
  expect(feedMounts).toBe(firstMounts + 1);
});

test("post creation from the shared composer refreshes the feed", async () => {
  await act(async () => root.render(createElement(DashboardPage)));
  const firstMounts = feedMounts;
  await act(async () => window.dispatchEvent(new Event("creatornet:post-created")));
  expect(feedMounts).toBe(firstMounts + 1);
});

test.each([
  ["payment return", "tipId", "existing-tip"],
  ["sign-in return", "tip", "1"],
])("dismissing a %s clears its intent before the feed remounts", async (_case, parameter, value) => {
  searchParams.set("postId", "returned-post");
  searchParams.set(parameter, value);
  await act(async () => root.render(createElement(DashboardPage)));
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-open-tip-post-id")).toBe("returned-post");
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-resume-tip-id")).toBe(parameter === "tipId" ? value : "");

  await act(async () => (container.querySelector("[data-feed-tab] button") as HTMLButtonElement).click());
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-open-tip-post-id")).toBe("");
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-resume-tip-id")).toBe("");

  const beforeRemount = feedMounts;
  await act(async () => window.dispatchEvent(new Event("creatornet:post-created")));
  expect(feedMounts).toBe(beforeRemount + 1);
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-open-tip-post-id")).toBe("");
});

test("signed-out feed keeps its join action", async () => {
  mockUserId = null;
  await act(async () => root.render(createElement(DashboardPage)));
  expect(container.querySelector('a[href="/auth"]')?.textContent).toContain("Join CreatorNet");
});
