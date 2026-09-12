/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mockParams = new URLSearchParams(), mockRouter = { replace: jest.fn(), prefetch: jest.fn() };
let mockLibraryError: { message: string } | null = null;
type NavigationQuery = { select: () => NavigationQuery; eq: () => NavigationQuery; in: () => NavigationQuery;
  order: () => Promise<{ data: never[]; error: { message: string } | null }>;
  maybeSingle: () => Promise<{ data: { avatar_url: null }; error: null }> };
const mockQuery: NavigationQuery = { select: jest.fn(() => mockQuery), eq: jest.fn(() => mockQuery), in: jest.fn(() => mockQuery),
  order: jest.fn(async () => ({ data: [], error: mockLibraryError })), maybeSingle: jest.fn(async () => ({ data: { avatar_url: null }, error: null })) };
const mockClient = { from: jest.fn(() => mockQuery) };
jest.mock("next/navigation", () => ({ useRouter: () => mockRouter, useSearchParams: () => mockParams }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "19000000-0000-4000-8000-000000000001", loading: false }) }));
jest.mock("@/components/FeedList", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/PostComposerModal", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/SearchDrawer", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/SidebarSignOutButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/StripeConnectBanner", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/utils", () => ({ DEFAULT_AVATAR_URL: "/Default_DP.png" }));
import Dashboard from "@/app/dashboard/page";
import Library from "@/app/library/page";
let container: HTMLDivElement, root: Root;
beforeEach(() => { jest.clearAllMocks(); jest.useFakeTimers(); mockLibraryError = null;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.useRealTimers(); });
test("step 5: the live dashboard navigation reaches membership management and keeps the mobile Library route", async () => {
  await act(async () => root.render(createElement(Dashboard))); await act(async () => jest.runOnlyPendingTimers());
  expect(container.querySelector('nav a[href="/memberships"]')?.textContent).toContain("Mentorships");
  expect(container.querySelector('a[href="/library"]')).not.toBeNull();
});
test("step 5: monthly-only buyers can reach management from an otherwise empty legacy Library", async () => {
  await act(async () => root.render(createElement(Library)));
  expect(container.querySelector('a[href="/memberships"]')).not.toBeNull();
  expect(container.textContent).toContain("Monthly mentorship access and billing are managed separately");
});
test("step 5: legacy Library read failure does not hide monthly account recovery", async () => {
  mockLibraryError = { message: "Synthetic legacy read failure" }; const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await act(async () => root.render(createElement(Library)));
    expect(container.querySelector('a[href="/memberships"]')).not.toBeNull(); expect(container.textContent).toContain("Couldn't load your library");
    expect(container.textContent).not.toContain("Synthetic legacy read failure");
  } finally { error.mockRestore(); }
});
