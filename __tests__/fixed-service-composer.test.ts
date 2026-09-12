/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mockClient = { from: () => ({ select: () => ({ limit: async () => ({ data: [{ interests: ["Entrepreneurship"] }], error: null }) }) }) };
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => mockClient }));
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: "creator_1" }) }));
import PostComposer from "@/components/PostComposer";

let container: HTMLDivElement;
let root: Root;
let mockFetch: jest.Mock;
let fixedReady = true;
let items: Record<string, unknown>[] = [];
const originalFetch = globalThis.fetch;
let alertSpy: jest.SpyInstance;
beforeEach(() => {
  fixedReady = true; items = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
  mockFetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/stripe/connect/status") return { ok: true, json: async () => ({ onboarding_complete: true }) };
    if (url === "/api/products" && init?.method === "GET") return {
      ok: true, json: async () => ({ success: true, items, capabilities: { fixedServiceDuration: fixedReady, monthlyMemberships: true, paidCalls: true } }),
    };
    if (url === "/api/products" && init?.method === "POST") return {
      ok: true, json: async () => ({ success: true, product: { ...JSON.parse(String(init.body)), id: "new-product" } }),
    };
    throw Error("Unexpected browser test request: " + url);
  });
  (globalThis as { fetch: unknown }).fetch = mockFetch;
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove(); alertSpy.mockRestore();
  globalThis.fetch = originalFetch;
});
async function click(node: HTMLElement) { await act(async () => { node.click(); }); }
function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(node => node.textContent === text);
  if (!found) throw Error("Missing button: " + text);
  return found;
}
function field(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]');
  if (!found) throw Error("Missing input: " + label);
  return found;
}
async function value(node: HTMLInputElement | HTMLSelectElement, next: string) {
  await act(async () => {
    const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, next);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function type(next: string) {
  await value(container.querySelector<HTMLSelectElement>('select[aria-label="Product type"]')!, next);
}
async function openNew() {
  await act(async () => { root.render(createElement(PostComposer)); });
  const attach = Array.from(container.querySelectorAll("label")).find(node => node.textContent?.includes('Attach "Buy / Book"'));
  await click(attach!.querySelector("input")!);
  await click(button("New"));
  await value(container.querySelector<HTMLInputElement>('input[placeholder^="Product title"]')!, "Ten-month mentorship");
  await value(field("Product price in USD"), "10000");
}
const productPosts = () => mockFetch.mock.calls.filter(([url, init]) => url === "/api/products" && init?.method === "POST");

test("duration controls remain hidden until the server advertises complete readiness", async () => {
  fixedReady = false;
  await openNew();
  await type("mentorship");
  expect(container.querySelector('input[aria-label="Set fixed service duration"]')).toBeNull();
});
test("creates a fixed mentorship with ten service months and the full ten-thousand-dollar price", async () => {
  await openNew(); await type("mentorship");
  await click(field("Set fixed service duration"));
  await value(field("Fixed service months"), "10");
  expect(field("Product price in USD").placeholder).toBe("Total purchase price in USD");
  expect(container.textContent).toContain("Installment count does not change service length.");
  await click(button("Create"));
  expect(alertSpy).not.toHaveBeenCalled();
  expect(productPosts()).toHaveLength(1);
  const body = JSON.parse(String(productPosts()[0][1].body));
  expect(body).toMatchObject({ type: "mentorship", price_cents: 1000000, fixed_service_months: 10, membership_terms: null });
  expect(body).not.toHaveProperty("service_start_at");
  expect(body).not.toHaveProperty("service_end_at");
  expect(container.textContent).toContain("10 calendar months from the first captured payment");
});
test.each(["", "0", "1.5"])("does not submit invalid duration %p", async months => {
  await openNew();
  await click(field("Set fixed service duration"));
  await value(field("Fixed service months"), months);
  await click(button("Create"));
  expect(alertSpy).toHaveBeenCalled();
  expect(productPosts()).toHaveLength(0);
});
test("switching to monthly mentorship clears fixed-duration intent", async () => {
  await openNew(); await type("mentorship");
  await click(field("Set fixed service duration"));
  await value(field("Fixed service months"), "10");
  const monthly = Array.from(container.querySelectorAll("label")).find(node => node.textContent?.includes("Sell monthly mentorship service"));
  await click(monthly!.querySelector("input")!);
  expect(container.querySelector('input[aria-label="Fixed service months"]')).toBeNull();
  expect(field("Product price in USD").placeholder).toBe("Monthly price in USD");
  await click(button("Create"));
  const body = JSON.parse(String(productPosts()[0][1].body));
  expect(body.membership_terms).toMatchObject({ minimumMonths: 1, autoRenew: false });
  expect(body).not.toHaveProperty("fixed_service_months");
});
test("switching to a paid call clears duration rather than hiding a submitted value", async () => {
  await openNew();
  await click(field("Set fixed service duration"));
  await value(field("Fixed service months"), "10");
  await type("call");
  expect(container.querySelector('input[aria-label="Fixed service months"]')).toBeNull();
  await value(container.querySelector<HTMLInputElement>('input[type="url"][placeholder="https://your-scheduler.com/paid-call"]')!, "https://scheduler.example/paid");
  await click(button("Create"));
  const body = JSON.parse(String(productPosts()[0][1].body));
  expect(body.type).toBe("call");
  expect(body).not.toHaveProperty("fixed_service_months");
});
test("leaving duration off preserves the legacy creation request without a fabricated limit", async () => {
  await openNew(); await click(button("Create"));
  expect(productPosts()).toHaveLength(1);
  expect(JSON.parse(String(productPosts()[0][1].body))).not.toHaveProperty("fixed_service_months");
});
