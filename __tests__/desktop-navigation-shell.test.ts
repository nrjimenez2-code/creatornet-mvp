/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let mockPathname = "/dashboard";
let mockUserId: string | null = "viewer";
let mockStripeNeedsAction = true;
const mockSearchParams = new URLSearchParams();
const mockPause = jest.fn();
const mockRefresh = jest.fn();
const mockClient = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { avatar_url: "https://example.invalid/avatar.png" } }) }) }) }) };
jest.mock("next/navigation", () => ({ usePathname: () => mockPathname, useSearchParams: () => mockSearchParams, useRouter: () => ({ refresh: mockRefresh }) }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: mockUserId, loading: false }) }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient }));
jest.mock("@/lib/mobileFeedPlayer", () => ({ pauseMobileFeedPlayer: () => mockPause() }));
jest.mock("@/components/DesktopStripeConnectBanner", () => ({ __esModule: true, default: () => mockStripeNeedsAction ? createElement("p", null, "Connect Stripe to sell") : null }));
jest.mock("@/components/SidebarSignOutButton", () => ({ __esModule: true, default: () => createElement("button", { "aria-label": "Sign out" }, "Sign out") }));
import DesktopNavigationShell, { currentDesktopDestination } from "@/components/DesktopNavigationShell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mockPathname = "/dashboard";
  mockUserId = "viewer";
  mockStripeNeedsAction = true;
  mockSearchParams.delete("tab");
  mockPause.mockClear();
  mockRefresh.mockClear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function render() {
  await act(async () => root.render(createElement(DesktopNavigationShell, null, createElement("main", { className: "dashboard-feed-shell" }, "Page"))));
}

test("all eight direct routes select their destination; deeper routes have no rail", () => {
  const routes = [
    ["/dashboard", null, "discover"],
    ["/dashboard", "following", "following"],
    ["/profile", null, "profile"],
    ["/dashboard/analytics", null, "analytics"],
    ["/dashboard/earnings", null, "earnings"],
    ["/library", null, "library"],
    ["/dashboard/closers", null, "bookings"],
    ["/memberships", null, "mentorships"],
  ] as const;
  routes.forEach(([path, tab, expected]) => expect(currentDesktopDestination(path, tab)).toBe(expected));
  expect(currentDesktopDestination("/profile/edit", null)).toBeNull();
  expect(currentDesktopDestination("/memberships/payoff", null)).toBeNull();
  expect(currentDesktopDestination("/search", null)).toBeNull();
});

test("all eight rendered destinations keep their routes and selected state", async () => {
  const routes = [
    ["/dashboard", null, "Discover", "/dashboard"],
    ["/dashboard", "following", "Following", "/dashboard?tab=following"],
    ["/profile", null, "Profile", "/profile"],
    ["/dashboard/analytics", null, "Analytics", "/dashboard/analytics"],
    ["/dashboard/earnings", null, "Earnings", "/dashboard/earnings"],
    ["/library", null, "Library", "/library"],
    ["/dashboard/closers", null, "Bookings", "/dashboard/closers"],
    ["/memberships", null, "Mentorships", "/memberships"],
  ] as const;
  for (const [path, tab, label, href] of routes) {
    mockPathname = path;
    mockSearchParams.delete("tab");
    if (tab) mockSearchParams.set("tab", tab);
    await render();
    const selected = container.querySelectorAll<HTMLAnchorElement>('.cn-desktop-nav-link[aria-current="page"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("aria-label")).toBe(label);
    expect(selected[0].getAttribute("href")).toBe(href);
    expect(container.querySelectorAll('.cn-desktop-nav-link')).toHaveLength(8);
  }
});

test("fixed header, scrollable middle, and pinned footer retain the 88/300 overlay geometry", async () => {
  await render();
  const rail = container.querySelector("aside")!;
  expect([...rail.children].map(element => element.className)).toEqual([
    "cn-desktop-nav-header", "cn-desktop-nav-scroll", "cn-desktop-nav-bottom",
  ]);
  expect(rail.querySelector(".cn-desktop-nav-scroll nav")?.getAttribute("aria-label")).toBe("Main destinations");
  expect(rail.querySelector(".cn-desktop-nav-bottom [aria-label='Sign out']")).not.toBeNull();
  expect(rail.querySelector(".cn-desktop-nav-header img")?.getAttribute("src")).toBe("/logo.png");
  expect(rail.querySelector(".cn-desktop-nav-stripe-icon")).toBeNull();
  const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");
  expect(css).toMatch(/\.cn-desktop-nav-content\s*\{\s*margin-left:\s*88px/);
  expect(css).toMatch(/\.cn-desktop-nav\[data-expanded="true"\]\s*\{\s*width:\s*300px/);
  expect(css).toMatch(/\.cn-desktop-nav-scroll\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s);
  expect(css).toMatch(/\.cn-desktop-nav-bottom\s*\{\s*flex:\s*0 0 auto/);
  expect(css).toContain("@media (max-width: 1023.98px) { .cn-desktop-nav { display: none; } }");
});

test("query changes and browser Back update selection in the persistent rail", async () => {
  await render();
  const rail = container.querySelector("aside")!;
  expect(rail.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("Discover");
  mockSearchParams.set("tab", "following");
  await render();
  expect(container.querySelector("aside")).toBe(rail);
  expect(rail.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("Following");
  mockPathname = "/dashboard/earnings";
  await render();
  expect(rail.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("Earnings");
  mockPathname = "/dashboard";
  mockSearchParams.delete("tab");
  await render();
  expect(rail.querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("Discover");
});

test("hover, Escape, and click toggle the overlay without changing the content wrapper", async () => {
  await render();
  const rail = container.querySelector("aside")!;
  const content = container.querySelector(".cn-desktop-nav-content")!;
  const toggle = rail.querySelector<HTMLButtonElement>('[aria-label="Expand menu"]')!;
  await act(async () => rail.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(rail.getAttribute("data-expanded")).toBe("true");
  expect(container.querySelector(".cn-desktop-nav-content")).toBe(content);
  await act(async () => rail.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(rail.getAttribute("data-expanded")).toBe("false");
  await act(async () => toggle.click());
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("leaving after Profile to Discover navigation collapses even while the clicked link keeps focus", async () => {
  mockPathname = "/profile";
  await render();
  const rail = container.querySelector("aside")!;
  const discover = rail.querySelector<HTMLAnchorElement>('a[aria-label="Discover"]')!;
  await act(async () => rail.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  await act(async () => discover.focus());
  mockPathname = "/dashboard";
  await render();
  expect(document.activeElement).toBe(discover);
  expect(rail.getAttribute("data-expanded")).toBe("true");
  await act(async () => rail.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
  expect(rail.getAttribute("data-expanded")).toBe("false");
  await act(async () => rail.querySelector<HTMLAnchorElement>('a[aria-label="Following"]')!.focus());
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("keyboard focus opens the panel and a no-hover device can use the toggle", async () => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
  await render();
  const rail = container.querySelector("aside")!;
  await act(async () => rail.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(rail.getAttribute("data-expanded")).toBe("false");
  await act(async () => container.querySelector<HTMLAnchorElement>('a[aria-label="Analytics"]')!.focus());
  expect(rail.getAttribute("data-expanded")).toBe("true");
  await act(async () => rail.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(rail.getAttribute("data-expanded")).toBe("false");
  await act(async () => rail.querySelector<HTMLButtonElement>('[aria-label="Expand menu"]')!.click());
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("leaving Discover pauses playback and the current item does not navigate", async () => {
  await render();
  const selected = container.querySelector<HTMLAnchorElement>('a[aria-label="Discover"]')!;
  const sameClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  selected.dispatchEvent(sameClick);
  expect(sameClick.defaultPrevented).toBe(true);
  expect(mockPause).not.toHaveBeenCalled();
  const next = container.querySelector<HTMLAnchorElement>('a[aria-label="Library"]')!;
  const leavingClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  next.dispatchEvent(leavingClick);
  expect(mockPause).toHaveBeenCalledTimes(1);
});

test("auth changes replace Sign in with Sign out and show the Stripe prompt", async () => {
  mockUserId = null;
  await render();
  expect(container.querySelector('a[aria-label="Sign in"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Connect Stripe to sell");
  mockUserId = "viewer";
  await render();
  expect(container.querySelector('a[aria-label="Sign in"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Sign out"]')).not.toBeNull();
  expect(container.textContent).toContain("Connect Stripe to sell");
  expect(container.querySelector(".cn-desktop-nav-scroll .cn-desktop-nav-stripe")).not.toBeNull();
  expect(container.querySelector(".cn-desktop-nav-bottom .cn-desktop-nav-stripe")).toBeNull();
  expect(container.querySelector('a[aria-label="Profile"] img')?.getAttribute("src")).toBe("https://example.invalid/avatar.png");
  mockStripeNeedsAction = false;
  await render();
  expect(container.querySelector(".cn-desktop-nav-stripe")?.childElementCount).toBe(0);
  expect(container.textContent).not.toContain("Connect Stripe to sell");
});
