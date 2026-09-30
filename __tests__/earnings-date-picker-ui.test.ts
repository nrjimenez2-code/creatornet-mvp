/** @jest-environment jsdom */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import EarningsDatePicker from "@/app/dashboard/earnings/EarningsDatePicker";

let container: HTMLDivElement;
let root: Root;
const onChange = jest.fn();
const onSubmit = jest.fn();

function Harness({ initial = "2026-09-01", disabled = false }: { initial?: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return createElement("form", { onSubmit }, createElement(EarningsDatePicker, {
    id: "start", label: "Start", value, disabled,
    onChange: (next) => { onChange(next); setValue(next); },
  }));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const input = () => container.querySelector<HTMLInputElement>("#start")!;
const dialog = () => container.querySelector<HTMLElement>("[role=dialog]");
const day = (date: string) => container.querySelector<HTMLButtonElement>(`[data-date="${date}"]`)!;
const control = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function render(initial?: string, disabled = false) {
  await act(async () => root.render(createElement(Harness, { initial, disabled })));
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
async function open() { await click(control("Choose start date")); }
async function key(value: string, shiftKey = false) {
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true })));
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("opens at the selected date; choosing a day returns focus and never submits", async () => {
  await render(); await open();
  expect(dialog()?.getAttribute("aria-label")).toBe("Choose start date");
  expect(document.activeElement).toBe(day("2026-09-01"));
  expect(container.querySelectorAll("[role=grid] button[tabindex='0']")).toHaveLength(1);
  expect(day("2026-09-01").parentElement?.getAttribute("aria-selected")).toBe("true");
  await click(day("2026-09-16"));
  expect(onChange).toHaveBeenLastCalledWith("2026-09-16");
  expect(input().value).toBe("09/16/2026");
  expect(document.activeElement).toBe(input());
  expect(dialog()).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("adjacent-month dates remain clickable after pointer focus", async () => {
  await render(); await open();
  const august = day("2026-08-30");
  await act(async () => august.focus());
  expect(august.isConnected).toBe(true);
  await click(august);
  expect(input().value).toBe("08/30/2026");
  expect(dialog()).toBeNull();
});

test("arrow keys cross month/year boundaries and Home/End use Sunday weeks", async () => {
  await render("2026-12-31");
  input().focus(); await key("ArrowDown");
  await key("ArrowRight");
  expect(document.activeElement).toBe(day("2027-01-01"));
  await key("Home"); expect(document.activeElement).toBe(day("2026-12-27"));
  await key("End"); expect(document.activeElement).toBe(day("2027-01-02"));
  await key("ArrowUp"); expect(document.activeElement).toBe(day("2026-12-26"));
  await key("ArrowDown"); await key("ArrowLeft"); await key("Enter");
  expect(onChange).toHaveBeenLastCalledWith("2027-01-01");
  expect(onSubmit).not.toHaveBeenCalled();
});

test.each([
  ["2024-01-31", "2024-02-29", "2025-02-28"],
  ["2026-01-31", "2026-02-28", "2027-02-28"],
])("month/year keyboard navigation clamps %s to valid days", async (start, february, nextYear) => {
  await render(start); await open();
  await key("PageDown"); expect(document.activeElement).toBe(day(february));
  await key("PageDown", true); expect(document.activeElement).toBe(day(nextYear));
  await key("PageUp", true);
  await key("PageUp"); await key(" ");
  expect(onChange.mock.lastCall?.[0]).toBe(`${start.slice(0, 7)}-${nextYear.slice(8)}`);
});

test("month/year controls change the calendar without applying or submitting", async () => {
  await render("2026-12-31"); await open();
  await click(control("Next month")); expect(container.querySelector("h2")?.textContent).toBe("January 2027");
  await click(control("Previous month"));
  await click(control("Previous year")); expect(container.querySelector("h2")?.textContent).toBe("December 2025");
  await click(control("Next year")); expect(container.querySelector("h2")?.textContent).toBe("December 2026");
  expect(onChange).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(input().value).toBe("12/31/2026");
});

test.each([
  ["America/Phoenix", "2026-09-29"],
  ["Asia/Tokyo", "2026-09-30"],
])("Today uses the browser calendar date in %s at a UTC boundary", async (zone, expected) => {
  jest.useFakeTimers(); jest.setSystemTime(new Date("2026-09-30T02:30:00Z"));
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  jest.spyOn(Intl, "DateTimeFormat").mockImplementation((locales, options) => new NativeDateTimeFormat(locales, { timeZone: zone, ...options }));
  await render(""); await open();
  expect(day(expected).getAttribute("aria-current")).toBe("date");
  expect(document.activeElement).toBe(day(expected));
  await click(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Today")!);
  expect(onChange).toHaveBeenLastCalledWith(expected);
  expect(dialog()).toBeNull();
});

test("manual US/ISO dates, invalid dates and Clear preserve parent validation", async () => {
  await render();
  await type("9/16/2026"); expect(onChange).toHaveBeenLastCalledWith("2026-09-16");
  expect(input().value).toBe("09/16/2026");
  await type("2026-10-01"); expect(input().value).toBe("10/01/2026");
  await type("02/30/2026"); expect(input().getAttribute("aria-invalid")).toBe("true");
  await type("09/"); expect(input().value).toBe("09/");
  await open();
  await click(Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Clear")!);
  expect(onChange).toHaveBeenLastCalledWith("");
  expect(input().value).toBe(""); expect(dialog()).toBeNull();
});

test("Escape, outside pointer/focus and disabled state dismiss without changing dates", async () => {
  await render(); await open(); await key("Escape");
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(input());
  await open();
  await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(dialog()).toBeNull();
  await open();
  await act(async () => document.body.dispatchEvent(new Event("focusin", { bubbles: true })));
  expect(dialog()).toBeNull();
  await open(); await render(undefined, true);
  expect(dialog()).toBeNull(); expect(input().disabled).toBe(true);
  await open(); expect(dialog()).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

test("calendar controls and keyboard cannot go outside the supported date range", async () => {
  await render("2000-01-01"); await open();
  expect(control("Previous month").disabled).toBe(true);
  expect(control("Previous year").disabled).toBe(true);
  expect(day("1999-12-31").disabled).toBe(true);
  await key("ArrowLeft"); expect(document.activeElement).toBe(day("2000-01-01"));
  await key("Escape"); await type("2100-12-31"); await open();
  expect(control("Next month").disabled).toBe(true); expect(control("Next year").disabled).toBe(true);
  await key("ArrowRight"); expect(document.activeElement).toBe(day("2100-12-31"));
});
