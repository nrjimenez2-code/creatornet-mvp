/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ProfileDesktopMenu from "@/components/ProfileDesktopMenu";
import ProfileShareButton from "@/components/ProfileShareButton";

jest.mock("next/link", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    const { createElement } = jest.requireActual<typeof import("react")>("react");
    return createElement("a", props);
  },
}));

let container: HTMLDivElement;
let root: Root;
let media: EventTarget & { matches: boolean };
const writeText = jest.fn();
const trigger = () => container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
const menu = () => container.querySelector<HTMLElement>('[role="menu"]');
const items = () => Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"]'));
async function key(target: HTMLElement, value: string, shiftKey = false) {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })));
}
async function click(target: HTMLElement) { await act(async () => target.click()); }
async function renderMenu() { await act(async () => root.render(createElement(ProfileDesktopMenu, { userId: "owner-id" }))); }

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  media = Object.assign(new EventTarget(), { matches: true });
  Object.defineProperty(window, "matchMedia", { value: jest.fn(() => media), configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Observe link activation without allowing jsdom's unimplemented navigation.
  container.addEventListener("click", event => {
    if ((event.target as HTMLElement).closest("a")) event.preventDefault();
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("click toggles an associated menu in edit, reviews, share order with exact destinations", async () => {
  await renderMenu();
  expect(trigger().getAttribute("aria-label")).toBe("Open profile menu");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(menu()).toBeNull();
  await click(trigger());
  expect(menu()!.id).toBe(trigger().getAttribute("aria-controls"));
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(items().map(item => item.textContent)).toEqual(["Edit profile", "Reviews", "Share"]);
  expect(items().map(item => item.getAttribute("href"))).toEqual(["/profile/edit", "/creators/owner-id/reviews", null]);
  expect(document.activeElement).toBe(items()[0]);
  await act(async () => {
    trigger().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    trigger().focus();
  });
  await click(trigger());
  expect(menu()).toBeNull();
});

test.each(["Enter", " ", "ArrowDown", "ArrowUp"])("%s opens from keyboard and focuses the appropriate edge", async value => {
  await renderMenu();
  await key(trigger(), value);
  expect(document.activeElement).toBe(items()[value === "ArrowUp" ? 2 : 0]);
});

test("arrows wrap, Home/End move to edges, and Escape closes with trigger focus", async () => {
  await renderMenu(); await click(trigger());
  await key(items()[0], "ArrowUp"); expect(document.activeElement).toBe(items()[2]);
  await key(items()[2], "ArrowDown"); expect(document.activeElement).toBe(items()[0]);
  await key(items()[0], "ArrowDown"); expect(document.activeElement).toBe(items()[1]);
  await key(items()[1], "End"); expect(document.activeElement).toBe(items()[2]);
  await key(items()[2], "Home"); expect(document.activeElement).toBe(items()[0]);
  await key(items()[0], "Escape");
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(trigger());
});

test.each([[0, "Enter"], [1, " "]])("keyboard activation of destination %s closes the menu", async (index, value) => {
  await renderMenu(); await click(trigger());
  const item = items()[Number(index)];
  const activated = jest.fn(); item.addEventListener("click", activated);
  await act(async () => item.focus());
  await key(item, String(value));
  expect(activated).toHaveBeenCalledTimes(1); expect(menu()).toBeNull();
});

test.each([0, 1])("clicking destination %s closes the menu", async index => {
  await renderMenu(); await click(trigger()); await click(items()[index]); expect(menu()).toBeNull();
});

test("Share keeps the menu open, copies the current URL and shows confirmation for two seconds", async () => {
  await renderMenu(); await click(trigger());
  await act(async () => items()[2].focus()); await key(items()[2], " ");
  expect(writeText).toHaveBeenCalledWith(window.location.href);
  expect(menu()).not.toBeNull();
  expect(items()[2].textContent).toBe("Profile link copied");
  expect(items()[2].querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
  await act(async () => jest.advanceTimersByTime(1999));
  expect(items()[2].textContent).toBe("Profile link copied");
  await act(async () => jest.advanceTimersByTime(1));
  expect(items()[2].textContent).toBe("Share"); expect(menu()).not.toBeNull();
});

test("clipboard rejection preserves failure handling and does not claim a copy", async () => {
  const error = new Error("permission denied"); writeText.mockRejectedValue(error);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  await renderMenu(); await click(trigger()); await click(items()[2]);
  expect(log).toHaveBeenCalledWith("Failed to copy profile link", error);
  expect(menu()).not.toBeNull(); expect(items()[2].textContent).toBe("Share");
});

test("outside pointer dismisses, while an inside pointer leaves the menu open", async () => {
  await renderMenu(); await click(trigger());
  await act(async () => items()[1].dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(menu()).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(menu()).toBeNull();
});

test.each([false, true])("Tab leaving dismisses without preventing normal focus traversal (shift=%s)", async shift => {
  await renderMenu(); await click(trigger());
  const active = items()[0];
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  await act(async () => active.dispatchEvent(event)); expect(event.defaultPrevented).toBe(false);
  const next = document.createElement("button"); container.appendChild(next);
  await act(async () => (shift ? trigger() : next).focus());
  expect(menu()).toBeNull();
});

test("resizing below 1024 dismisses; opening below the breakpoint leaves it closed", async () => {
  await renderMenu(); await click(trigger());
  media.matches = false;
  const event = Object.assign(new Event("change"), { matches: false });
  await act(async () => media.dispatchEvent(event)); expect(menu()).toBeNull();
  await click(trigger()); expect(menu()).toBeNull();
  expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 1024px)");
});

test("default public-profile Share retains its icon and existing feedback", async () => {
  await act(async () => root.render(createElement(ProfileShareButton)));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="Share profile"]')!;
  expect(button.querySelector("img")?.getAttribute("src")).toBe("/share.png");
  expect(container.querySelector('[role="menuitem"]')).toBeNull();
  await click(button); expect(writeText).toHaveBeenCalledWith(window.location.href);
  expect(button.getAttribute("aria-label")).toBe("Link copied");
  expect(container.textContent).toContain("Profile link copied");
  await act(async () => jest.advanceTimersByTime(2000));
  expect(button.getAttribute("aria-label")).toBe("Share profile");
});
