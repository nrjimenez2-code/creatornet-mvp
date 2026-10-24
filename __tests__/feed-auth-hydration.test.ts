/** @jest-environment jsdom */
import { act, createElement, Fragment, Suspense } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";

let mockUser: { userId: string | null; loading: boolean } = { userId: null, loading: true };
const mockSearchParams = new URLSearchParams();
const mockRouter = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn() };
const mockClient = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { avatar_url: null } }) }) }) }) };
jest.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useSearchParams: () => mockSearchParams, useRouter: () => mockRouter }));
jest.mock("@/lib/useUser", () => ({ useUser: () => mockUser }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient }));
jest.mock("@/lib/mobileFeedPlayer", () => ({ pauseMobileFeedPlayer: jest.fn() }));
// Keep data and media outside this test: the regression is the auth-dependent
// sibling of the feed and the separately hydrated root navigation boundary.
jest.mock("@/components/FeedList", () => ({ __esModule: true, default: () => createElement("div", { "data-testid": "server-feed" }, "Loading feed…") }));
import DashboardPage from "@/app/dashboard/page";
import MobileTabNav from "@/components/MobileTabNav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  mockUser = { userId: null, loading: true };
  mockSearchParams.delete("tab");
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container.remove(); });

function tree() {
  return createElement(Fragment, null,
    createElement(DashboardPage),
    createElement(Suspense, { fallback: null }, createElement(MobileTabNav)));
}

describe.each(["discover", "following"])("direct %s load", tab => {
  test.each(["signed-in", "signed-out"])("auth settles %s before the boundary hydrates without regenerating its server DOM", async state => {
    if (tab === "following") mockSearchParams.set("tab", "following");
    container.innerHTML = renderToString(tree());
    const serverFeed = container.querySelector('[data-testid="server-feed"]');
    expect(container.querySelector('[aria-label="Mobile navigation"]')).toBeNull();
    expect(container.querySelector('.dashboard-feed-nav')).toBeNull();
    // A parent provider effect can resolve while a separate streamed boundary
    // is still waiting to hydrate. Its first client pass sees the newer context.
    mockUser = { userId: state === "signed-in" ? "fixture-viewer" : null, loading: false };
    const errors: Array<{ message: string; stack: string | undefined | null }> = [];
    await act(async () => {
      root = hydrateRoot(container, tree(), { onRecoverableError: (error, info) => errors.push({ message: (error as Error).message, stack: info.componentStack }) });
    });
    expect(errors).toEqual([]);
    expect(container.querySelector('[data-testid="server-feed"]')).toBe(serverFeed);
    const nav = container.querySelector('[aria-label="Mobile navigation"]');
    if (state === "signed-in") {
      expect(nav).not.toBeNull();
      expect(nav?.querySelector('[aria-current="page"]')?.textContent).toBe(tab === "following" ? "Following" : "Discover");
      expect(container.textContent).not.toContain("Join CreatorNet");
    } else {
      expect(nav).toBeNull();
      expect(container.querySelector('.dashboard-feed-nav a')?.getAttribute("href")).toBe("/auth");
      expect(container.textContent).toContain("Join CreatorNet");
    }
  });

  test.each(["signed-in", "signed-out"])("delayed %s auth still shows the correct navigation after hydration", async state => {
    if (tab === "following") mockSearchParams.set("tab", "following");
    container.innerHTML = renderToString(tree());
    const errors: unknown[] = [];
    await act(async () => { root = hydrateRoot(container, tree(), { onRecoverableError: error => errors.push(error) }); });
    expect(container.querySelector('.dashboard-feed-nav')).toBeNull();
    mockUser = { userId: state === "signed-in" ? "fixture-viewer" : null, loading: false };
    await act(async () => root!.render(tree()));
    expect(errors).toEqual([]);
    expect(Boolean(container.querySelector('[aria-label="Mobile navigation"]'))).toBe(state === "signed-in");
    expect(container.textContent?.includes("Join CreatorNet")).toBe(state === "signed-out");
  });
});
