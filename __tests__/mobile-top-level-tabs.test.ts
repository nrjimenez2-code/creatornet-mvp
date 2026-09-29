/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let mockPathname = "/dashboard";
let mockTab: string | null = null;
let mockUserId: string | null = "viewer";
let mockLoading = false;
const mockPause = jest.fn();
const mockRefresh = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockTab ? `tab=${mockTab}` : ""),
  useRouter: () => ({ refresh: mockRefresh }),
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, onClick, children, ...props }: {
    href: string; onClick?: (event: MouseEvent) => void; children?: unknown;
  }) => createElement("a", { href, onClick, ...props }, children as never),
}));
jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => ({ onPosted, onClose }: { onPosted: () => void; onClose: () => void }) =>
    createElement("div", { role: "dialog" },
      createElement("button", { onClick: onPosted }, "Post"),
      createElement("button", { onClick: onClose }, "Close")),
}));
jest.mock("@/lib/mobileFeedPlayer", () => ({ pauseMobileFeedPlayer: () => mockPause() }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: mockUserId, loading: mockLoading }) }));
jest.mock("@/lib/supabaseClient", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { avatar_url: null } }) }) }) }) }),
}));

import MobileTabNav, { currentMobileTab } from "@/components/MobileTabNav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = "/dashboard";
  mockTab = null;
  mockUserId = "viewer";
  mockLoading = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => root.render(createElement(MobileTabNav)));
}

test("direct URLs and Back select the corresponding top-level tab", async () => {
  for (const [path, tab, label] of [
    ["/dashboard", null, "Discover"],
    ["/dashboard", "following", "Following"],
    ["/library", null, "Library"],
    ["/profile", null, "Profile"],
    ["/dashboard", null, "Discover"],
  ] as const) {
    mockPathname = path;
    mockTab = tab;
    await render();
    expect(container.querySelectorAll('nav[aria-label="Mobile navigation"]')).toHaveLength(1);
    expect(container.querySelector('a[aria-current="page"]')?.textContent).toBe(label);
  }
  expect(currentMobileTab("/profile/edit", null)).toBeNull();
  expect(currentMobileTab("/profile/someone-else", null)).toBeNull();
  expect(currentMobileTab("/watch/post", null)).toBeNull();
  mockPathname = "/profile/edit";
  await render();
  expect(container.querySelector("nav")).toBeNull();
});

test("an active tap stays in place; another tab stops feed playback", async () => {
  await render();
  const discover = container.querySelector('a[href="/dashboard"]')!;
  const activeClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  discover.dispatchEvent(activeClick);
  expect(activeClick.defaultPrevented).toBe(true);
  expect(mockPause).not.toHaveBeenCalled();

  const library = container.querySelector('a[href="/library"]')!;
  const leaveClick = new MouseEvent("click", { bubbles: true, cancelable: true });
  library.dispatchEvent(leaveClick);
  expect(leaveClick.defaultPrevented).toBe(false);
  expect(mockPause).toHaveBeenCalledTimes(1);
});

test("the center plus has an accessible name, no visible label, and keeps the composer action", async () => {
  await render();
  const create = container.querySelector('nav button[aria-label="Create post"]') as HTMLButtonElement;
  expect(create).not.toBeNull();
  expect(create.textContent).toBe("");
  await act(async () => create.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  const posted = jest.fn();
  window.addEventListener("creatornet:post-created", posted, { once: true });
  await act(async () => (container.querySelector('[role="dialog"] button') as HTMLButtonElement).click());
  expect(posted).toHaveBeenCalledTimes(1);
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test("signed-out and deeper screens have no tab bar", async () => {
  mockUserId = null;
  await render();
  expect(container.querySelector("nav")).toBeNull();
  mockUserId = "viewer";
  mockLoading = true;
  await render();
  expect(container.querySelector("nav")).toBeNull();
});
