/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockRouter = { prefetch: jest.fn(), push: jest.fn(), refresh: jest.fn() };
const mockSearchParams = new URLSearchParams();
const mockClient = {};
jest.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useSearchParams: () => mockSearchParams, useRouter: () => mockRouter }));
jest.mock("next/dynamic", () => ({ __esModule: true, default: () => jest.requireActual("@/components/SearchDrawer").default }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: null, loading: false }) }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient }));
jest.mock("@/lib/mobileFeedPlayer", () => ({ pauseMobileFeedPlayer: jest.fn() }));
jest.mock("@/components/DesktopStripeConnectBanner", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/SidebarSignOutButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/SearchSuggestions", () => ({ __esModule: true, default: () => null }));
import DesktopNavigationShell from "@/components/DesktopNavigationShell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let rail: HTMLElement;
let search: HTMLButtonElement;

beforeEach(async () => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: true }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(DesktopNavigationShell, null, createElement("main", null, "Page"))));
  rail = container.querySelector<HTMLElement>('.cn-desktop-nav')!;
  search = rail.querySelector<HTMLButtonElement>('[aria-label="Search"]')!;
  jest.spyOn(rail, "getBoundingClientRect").mockReturnValue({ left: 16, right: 104, top: 12, bottom: 788 } as DOMRect);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); jest.restoreAllMocks(); });

async function openSearch() {
  await act(async () => { search.focus(); search.click(); });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement).toBe(container.querySelector("input"));
}

async function pointerClose(target: HTMLElement, x: number, y: number, pointerType = "mouse") {
  await act(async () => {
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(pointerDown, "pointerType", { value: pointerType });
    target.dispatchEvent(pointerDown);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y, detail: 1 }));
  });
}

test.each(["Close", "backdrop"])("mouse dismissal via %s outside the sidebar collapses immediately and Search can reopen", async (method) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    await openSearch();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const target = method === "Close" ? dialog.querySelector<HTMLButtonElement>("button")! : dialog.previousElementSibling as HTMLElement;
    await pointerClose(target, 600, 100);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(search);
    expect(rail.getAttribute("data-expanded")).toBe("false");
  }
  await act(async () => rail.querySelector<HTMLAnchorElement>('[aria-label="Discover"]')!.focus());
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("pointer dismissal inside the sidebar keeps it expanded", async () => {
  await openSearch();
  await pointerClose(container.querySelector<HTMLButtonElement>('[role="dialog"] button')!, 60, 100);
  expect(document.activeElement).toBe(search);
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("Escape restores Search focus and keyboard users can continue or collapse the sidebar", async () => {
  await openSearch();
  const input = container.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, clientX: 400, clientY: 100 });
    Object.defineProperty(pointerDown, "pointerType", { value: "mouse" });
    input.dispatchEvent(pointerDown);
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(search);
  expect(rail.getAttribute("data-expanded")).toBe("true");
  await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(rail.getAttribute("data-expanded")).toBe("false");
  expect(document.activeElement).toBe(rail.querySelector('[aria-label="Expand menu"]'));
  await act(async () => search.focus());
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("keyboard activation of Close preserves focus restoration", async () => {
  await openSearch();
  const close = container.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
  await act(async () => {
    close.focus();
    close.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    close.click();
  });
  expect(document.activeElement).toBe(search);
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("no-hover devices keep their existing focus and toggle behavior", async () => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
  await openSearch();
  await pointerClose(container.querySelector<HTMLButtonElement>('[role="dialog"] button')!, 600, 100);
  expect(document.activeElement).toBe(search);
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("touch dismissal on a desktop with a mouse also keeps the existing focus behavior", async () => {
  await openSearch();
  await pointerClose(container.querySelector<HTMLButtonElement>('[role="dialog"] button')!, 600, 100, "touch");
  expect(document.activeElement).toBe(search);
  expect(rail.getAttribute("data-expanded")).toBe("true");
});

test("sidebar changes while Search is open do not restart the drawer focus lifecycle", async () => {
  await openSearch();
  const close = container.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
  await act(async () => close.focus());
  await act(async () => rail.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(document.activeElement).toBe(close);
});
