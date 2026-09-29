/** @jest-environment jsdom */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const mockClient = createMockClient(op => op.table === "profiles" ? { data: { avatar_url: "https://example.invalid/avatar.png" }, error: null } : undefined);
let mockUserId: string | null = "viewer";
const searchParams = new URLSearchParams();
const router = { replace: jest.fn(), push: jest.fn() };
let feedMounts = 0;
jest.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => searchParams }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: mockUserId, loading: false }) }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient }));
jest.mock("@/components/FeedList", () => {
  function MockFeedList({ activeTab }: { activeTab: string }) {
    useEffect(() => { feedMounts += 1; }, []);
    return createElement("div", { "data-feed-tab": activeTab });
  }
  return { __esModule: true, default: MockFeedList };
});
jest.mock("@/components/SearchDrawer", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/StripeConnectBanner", () => ({ __esModule: true, default: () => createElement("p", null, "Connect Stripe to sell") }));
jest.mock("@/components/SidebarSignOutButton", () => ({ __esModule: true, default: () => createElement("button", null, "Sign out") }));
jest.mock("@/components/PostComposerModal", () => ({ __esModule: true, default: () => createElement("div", { role: "dialog" }, "New post") }));
import DashboardPage from "@/app/dashboard/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mockUserId = "viewer";
  searchParams.delete("tab");
  feedMounts = 0;
  jest.clearAllMocks();
  container = document.createElement("div");
  root = createRoot(container);
});

test("Following direct URL and browser Back select the feed and restore a separate mount", async () => {
  searchParams.set("tab", "following");
  await act(async () => root.render(createElement(DashboardPage)));
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-feed-tab")).toBe("following");
  const firstMounts = feedMounts;

  searchParams.delete("tab"); // browser Back to /dashboard
  await act(async () => root.render(createElement(DashboardPage)));
  expect(container.querySelector("[data-feed-tab]")?.getAttribute("data-feed-tab")).toBe("discover");
  expect(feedMounts).toBe(firstMounts + 1);

  const following = Array.from(container.querySelectorAll<HTMLButtonElement>("aside button")).find(button => button.title === "Following")!;
  await act(async () => following.click());
  expect(router.push).toHaveBeenCalledWith("/dashboard?tab=following", { scroll: false });
});

test("post creation from the shared mobile composer refreshes the feed", async () => {
  await act(async () => root.render(createElement(DashboardPage)));
  const firstMounts = feedMounts;
  await act(async () => window.dispatchEvent(new Event("creatornet:post-created")));
  expect(feedMounts).toBe(firstMounts + 1);
});
afterEach(async () => { await act(async () => root.unmount()); });

test("losing the session clears the old avatar and replaces Sign out with Sign in", async () => {
  await act(async () => root.render(createElement(DashboardPage)));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(container.querySelector('img[src="https://example.invalid/avatar.png"]')).not.toBeNull();
  mockUserId = null;
  await act(async () => root.render(createElement(DashboardPage)));
  const aside = container.querySelector("aside")!;
  expect(container.querySelector('img[src="https://example.invalid/avatar.png"]')).toBeNull();
  expect(aside.textContent).not.toContain("Sign out");
  expect(aside.querySelector('a[href="/auth"]')?.textContent).toBe("Sign in");
});

test("desktop create action is in the scrollable sidebar flow, before sign out", async () => {
  await act(async () => root.render(createElement(DashboardPage)));
  const aside = container.querySelector("aside")!;
  const create = Array.from(aside.querySelectorAll("button")).find((b) => b.textContent?.includes("Create post"));
  const signOut = Array.from(aside.querySelectorAll("button")).find((b) => b.textContent === "Sign out")!;
  expect(create).toBeDefined();
  expect(create!.className).not.toContain("fixed");
  expect(create!.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(aside.className).toContain("overflow-y-auto");
  expect(aside.className).toContain("overflow-x-hidden");
  expect(aside.className).toContain("[scrollbar-width:thin]");
  expect(aside.firstElementChild?.className).toContain("w-full");
  expect(aside.className).toContain("max-h-[calc(100dvh-3rem)]");
  await act(async () => create!.click());
  expect(container.querySelector('[role="dialog"]')?.textContent).toBe("New post");
});

test("the existing floating tablet action is hidden on desktop", async () => {
  await act(async () => root.render(createElement(DashboardPage)));
  const floating = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Create post") && b.className.includes("fixed"));
  expect(floating?.className).toContain("md:flex");
  expect(floating?.className).toContain("lg:hidden");
});
