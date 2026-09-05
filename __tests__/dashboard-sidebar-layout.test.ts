/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";
const mockClient = createMockClient();
const searchParams = new URLSearchParams();
const router = { replace: jest.fn(), push: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => searchParams }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "viewer", loading: false }) }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient }));
jest.mock("@/components/FeedList", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/SearchDrawer", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/StripeConnectBanner", () => ({ __esModule: true, default: () => createElement("p", null, "Connect Stripe to sell") }));
jest.mock("@/components/SidebarSignOutButton", () => ({ __esModule: true, default: () => createElement("button", null, "Sign out") }));
jest.mock("@/components/PostComposerModal", () => ({ __esModule: true, default: () => createElement("div", { role: "dialog" }, "New post") }));
import DashboardPage from "@/app/dashboard/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });

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
