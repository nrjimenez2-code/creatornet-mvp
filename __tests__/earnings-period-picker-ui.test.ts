/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import EarningsPeriodPicker from "@/app/dashboard/earnings/EarningsPeriodPicker";
import EarningsTimeframeSelect from "@/app/dashboard/earnings/EarningsTimeframeSelect";
import { resolveEarningsPeriod } from "@/lib/earningsPeriod";

const push = jest.fn();
const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const period = resolveEarningsPeriod({ period: "this-month", tz: zone }, new Date("2026-09-29T12:00:00Z"))!;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

async function renderPicker() {
  await act(async () => root.render(createElement(EarningsPeriodPicker, { period, needsUrlRepair: false })));
}
const trigger = () => container.querySelector<HTMLButtonElement>("#earnings-period")!;
async function key(value: string) {
  await act(async () => trigger().dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true })));
}
async function select(index: number) {
  await act(async () => trigger().click());
  await act(async () => container.querySelector<HTMLElement>(`#earnings-period-option-${index}`)!.click());
}
async function date(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("all presets retain URL navigation and browser timezone", async () => {
  await renderPicker();
  expect(trigger().textContent).toBe("This Month");
  for (const [index, preset] of ["today", "yesterday", "this-week", "this-month"].entries()) {
    await select(index);
    const url = new URL(push.mock.lastCall![0], "https://example.invalid");
    expect(url.searchParams.get("period")).toBe(preset);
    expect(url.searchParams.get("tz")).toBe(zone);
    expect(container.querySelector("[role=listbox]")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  }
  expect(replace).not.toHaveBeenCalled();
});

test("pointer movement highlights an option without selecting until click", async () => {
  await renderPicker();
  await act(async () => trigger().click());
  expect(container.querySelectorAll("[role=option]")).toHaveLength(5);
  const yesterday = container.querySelector<HTMLElement>("#earnings-period-option-1")!;
  await act(async () => yesterday.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
  expect(trigger().getAttribute("aria-activedescendant")).toBe(yesterday.id);
  expect(yesterday.getAttribute("data-active")).toBe("true");
  expect(yesterday.getAttribute("aria-selected")).toBe("false");
  expect(push).not.toHaveBeenCalled();
  await act(async () => yesterday.click());
  expect(trigger().textContent).toBe("Yesterday");
  expect(push.mock.lastCall![0]).toContain("period=yesterday");
});

test("arrows, Home, End, typeahead and Enter select with focus retained", async () => {
  await renderPicker();
  trigger().focus();
  await key("ArrowDown"); await key("Home"); await key("ArrowDown"); await key("Enter");
  expect(trigger().textContent).toBe("Yesterday");
  expect(document.activeElement).toBe(trigger());
  await key("t"); await key("h"); await key("i"); await key("s"); await key("Enter");
  expect(trigger().textContent).toBe("This Week");
  await key(" "); await key("End"); await key("ArrowUp"); await key("Enter");
  expect(trigger().textContent).toBe("This Month");
  await key("End"); await key("Enter");
  expect(container.querySelector("#earnings-start")).not.toBeNull();
  expect(trigger().textContent).toBe("Custom Range");
});

test("Escape, Tab, outside pointer and focus dismiss without changing the period", async () => {
  await renderPicker();
  for (const dismissKey of ["Escape", "Tab"]) {
    await key("Enter"); await key("ArrowUp"); await key(dismissKey);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  }
  await key("Enter");
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(container.querySelector("[role=listbox]")).toBeNull();
  await key("Enter");
  await act(async () => document.body.dispatchEvent(new Event("focusin", { bubbles: true })));
  expect(container.querySelector("[role=listbox]")).toBeNull();
  expect(trigger().textContent).toBe("This Month");
  expect(push).not.toHaveBeenCalled();
});

test("Custom Range still validates and applies inclusive dates in the URL", async () => {
  await renderPicker();
  await select(4);
  expect(push).not.toHaveBeenCalled();
  await date("earnings-start", "2026-09-30"); await date("earnings-end", "2026-09-01");
  await act(async () => container.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector("[role=alert]")?.textContent).toContain("start on or before the end");
  expect(push).not.toHaveBeenCalled();
  await date("earnings-start", "2026-09-01"); await date("earnings-end", "2026-09-15");
  await act(async () => container.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const url = new URL(push.mock.lastCall![0], "https://example.invalid");
  expect(Object.fromEntries(url.searchParams)).toEqual({ period: "custom", tz: zone, start: "2026-09-01", end: "2026-09-15" });
  expect(container.querySelector("[role=alert]")).toBeNull();
});

test("disabled picker closes its menu and prevents selection during navigation", async () => {
  const onChange = jest.fn();
  await act(async () => root.render(createElement(EarningsTimeframeSelect, { value: "this-month", disabled: false, onChange })));
  await key("Enter");
  expect(container.querySelector("[role=listbox]")).not.toBeNull();
  await act(async () => root.render(createElement(EarningsTimeframeSelect, { value: "this-month", disabled: true, onChange })));
  expect(trigger().disabled).toBe(true);
  expect(container.querySelector("[role=listbox]")).toBeNull();
  await act(async () => trigger().click());
  expect(onChange).not.toHaveBeenCalled();
});
