/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import InstallmentLinkForm from "@/components/InstallmentLinkForm";

jest.mock("@/lib/supabaseBrowser", () => ({
  createBrowserClient: () => ({ from: () => ({ select: () => ({ eq: () => ({
    order: async () => ({ data: [], error: null }),
  }) }) }) }),
}));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: "creator-test", session: { access_token: "test-only-token" } }),
}));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: never }) => createElement("a", { href }, children),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let promptSpy: jest.SpyInstance;
const originalFetch = global.fetch;
const button = (text: string, index = 0) =>
  Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === text)[index]!;
const click = async (element: HTMLElement) => act(async () => element.click());
const submit = async () => act(async () => {
  container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});
const setMonths = async (value: string) => act(async () => {
  const input = container.querySelector<HTMLInputElement>('input[aria-describedby]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const renderForm = async (onGenerate = jest.fn(async () => true), disabled = false) => {
  await act(async () => root.render(createElement(InstallmentLinkForm, { disabled, onGenerate })));
  return onGenerate;
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  promptSpy = jest.spyOn(window, "prompt").mockImplementation(() => { throw new Error("prompt() is not supported."); });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: jest.fn(async () => undefined) } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  promptSpy.mockRestore();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test("opens an accessible inline count field with default 3, without a native prompt or initial focus theft", async () => {
  const generate = await renderForm();
  expect(document.activeElement).toBe(document.body);
  await click(button("Generate installment link"));
  const input = container.querySelector<HTMLInputElement>("input")!;
  expect(input.value).toBe("3");
  expect(container.querySelector("label")!.htmlFor).toBe(input.id);
  expect(document.activeElement).toBe(input);
  expect(button("Generate installment link").getAttribute("aria-expanded")).toBe("true");
  expect(generate).not.toHaveBeenCalled();
  expect(promptSpy).not.toHaveBeenCalled();
});

test.each(["", "1", "25", "2.5", "-3"])("rejects invalid count %s without generating", async (value) => {
  const generate = await renderForm();
  await click(button("Generate installment link"));
  await setMonths(value);
  await submit();
  expect(container.querySelector('[role="alert"]')!.textContent).toContain("whole number from 2 to 24");
  expect(container.querySelector("input")!.getAttribute("aria-invalid")).toBe("true");
  expect(generate).not.toHaveBeenCalled();
});

test.each([2, 3, 24])("submits valid count %s and closes after success", async (count) => {
  const generate = await renderForm();
  await click(button("Generate installment link"));
  await setMonths(String(count));
  await submit();
  expect(generate).toHaveBeenCalledTimes(1);
  expect(generate).toHaveBeenCalledWith(count);
  expect(container.querySelector("form")).toBeNull();
  expect(document.activeElement).toBe(button("Generate installment link"));
});

test.each(["Cancel", "Escape"])("%s closes without generation and restores focus", async (action) => {
  const generate = await renderForm();
  await click(button("Generate installment link"));
  if (action === "Cancel") await click(button("Cancel"));
  else await act(async () => {
    container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(container.querySelector("form")).toBeNull();
  expect(document.activeElement).toBe(button("Generate installment link"));
  expect(generate).not.toHaveBeenCalled();
});

test("pending submission blocks duplicate requests, input edits and cancellation", async () => {
  let finish!: (value: boolean) => void;
  const generate = jest.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  await renderForm(generate);
  await click(button("Generate installment link"));
  await act(async () => {
    const form = container.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(container.querySelector("input")!.disabled).toBe(true);
  expect(button("Cancel").disabled).toBe(true);
  await act(async () => finish(false));
  expect(container.querySelector("form")).not.toBeNull();
  expect(container.querySelector("input")!.disabled).toBe(false);
});

test("keeps a failed plan editable and supports retry", async () => {
  const generate = jest.fn(async () => false);
  await renderForm(generate);
  await click(button("Generate installment link"));
  await setMonths("6");
  await submit();
  expect(container.querySelector<HTMLInputElement>("input")!.value).toBe("6");
  generate.mockResolvedValueOnce(true);
  await submit();
  expect(generate).toHaveBeenCalledTimes(2);
  expect(container.querySelector("form")).toBeNull();
});

test("disabled controls cannot open a new plan", async () => {
  const generate = await renderForm(undefined, true);
  await click(button("Generate installment link"));
  expect(container.querySelector("form")).toBeNull();
  expect(generate).not.toHaveBeenCalled();
});

const bundle = (id: string) => ({
  booking: { id, creator_id: "creator-test", buyer_id: `buyer-${id}`, post_id: `post-${id}`, status: "booked", created_at: "2026-09-05T12:00:00Z" },
  post: null,
  product: { id: `product-${id}`, title: `Test ${id}`, amount_cents: 12000, currency: "usd" },
  buyer: { username: `Buyer ${id}` }, payments: [],
});
const response = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => data } as Response);
const renderPage = async () => {
  const fetchMock = jest.fn(async (url: string) => url === "/api/bookings/list"
    ? response({ bookings: [bundle("one"), bundle("two")] })
    : response({ payment: { id: "test-payment", plan_type: "installment", status: "pending", installment_months: 3, installment_amount_cents: 4000, amount_total_cents: 12000, creator_net_cents: null, created_at: "2026-09-05T12:00:00Z" } }));
  global.fetch = fetchMock as unknown as typeof fetch;
  const { default: Page } = await import("@/app/dashboard/closers/page");
  await act(async () => root.render(createElement(Page)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return fetchMock;
};

test("page sends the unchanged installment payload to the selected booking only", async () => {
  const fetchMock = await renderPage();
  await click(button("Generate installment link", 1));
  await submit();
  expect(fetchMock).toHaveBeenCalledWith("/api/bookings/two/payment-link", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-only-token" },
    body: JSON.stringify({ plan_type: "installment", installment_months: 3 }),
  });
  expect(fetchMock.mock.calls.filter(([url]) => url.includes("/payment-link"))).toHaveLength(1);
  expect(promptSpy).not.toHaveBeenCalled();
  expect(container.textContent).toContain("3 months");
  expect(container.textContent).toContain("$40.00 / mo");
});

test("full payment still uses the existing full-only request without a selector", async () => {
  const fetchMock = await renderPage();
  await click(button("Generate full payment link", 0));
  expect(fetchMock).toHaveBeenCalledWith("/api/bookings/one/payment-link", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-only-token" },
    body: JSON.stringify({ plan_type: "full" }),
  });
  expect(container.querySelector("form")).toBeNull();
});

test("page displays server failure and keeps the plan available without claiming success", async () => {
  const fetchMock = await renderPage();
  fetchMock.mockResolvedValueOnce(response({ error: "Test plan unavailable" }, false));
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  await click(button("Generate installment link"));
  await submit();
  expect(container.querySelector('[role="status"]')!.textContent).toBe("Test plan unavailable");
  expect(container.querySelector("form")).not.toBeNull();
  expect(container.textContent).not.toContain("Link generated");
});
