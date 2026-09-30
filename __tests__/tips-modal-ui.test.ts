/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

jest.mock("@stripe/stripe-js/pure", () => ({ loadStripe: jest.fn() }));

import TipModal from "@/components/TipModal";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalFetch = globalThis.fetch;
const onClose = jest.fn();
const tipId = "44444444-4444-4444-8444-444444444444";
const postId = "33333333-3333-4333-8333-333333333333";

async function render(open: boolean) {
  await act(async () => {
    root.render(createElement(TipModal, {
      open, postId, creatorName: "creator", resumeTipId: tipId, onClose,
    }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onClose.mockClear();
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: "processing", amountCents: 1000 }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  jest.useRealTimers();
});

test.each([401, 403, 404])("an inaccessible tip (%s) stops polling without offering another payment", async (status) => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status, json: async () => ({ error: "PRIVATE_DETAIL", status: "paid", amountCents: 500 }) });
  await render(true);
  expect(container.textContent).toContain("Tip status unavailable");
  expect(container.textContent).not.toContain("Confirming your tip");
  expect(container.textContent).not.toContain("Tip sent");
  expect(container.textContent).not.toContain("PRIVATE_DETAIL");
  expect(container.textContent).not.toContain("Start a new tip");
  expect(container.querySelector('a[href="/payments"]')).not.toBeNull();
  await act(async () => jest.advanceTimersByTime(30_000));
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect((globalThis.fetch as jest.Mock).mock.calls[0][1].method).toBeUndefined();
});

test("closing a pending return stops status reads and reopening resumes the same tip", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
  await render(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  await render(false);
  await act(async () => jest.advanceTimersByTime(30_000));
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  await render(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect((globalThis.fetch as jest.Mock).mock.calls.every(([url]) => url === `/api/tips/${tipId}/status`)).toBe(true);
  expect(container.textContent).toContain("Confirming your tip");
});

test("a transient status error keeps the original pending tip instead of claiming payment", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ status: "paid" }) });
  await render(true);
  expect(container.textContent).toContain("Confirming your tip");
  expect(container.textContent).not.toContain("Tip sent");
  await act(async () => jest.advanceTimersByTime(1500));
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

test("a denial after reopening clears the earlier processing timeout message", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
  await render(true);
  await act(async () => jest.advanceTimersByTimeAsync(30_000));
  expect(container.textContent).toContain("Payment is still processing");
  await render(false);
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
  await render(true);
  expect(container.textContent).toContain("Tip status unavailable");
  expect(container.textContent).not.toContain("Payment is still processing");
});

test("reopening a returned active tip keeps its payment status", async () => {
  await render(true);
  expect(container.textContent).toContain("Confirming your tip");
  await render(false);
  await render(true);
  expect(container.textContent).toContain("Confirming your tip");
  expect(container.textContent).not.toContain("Custom amount");
});

test("Shift+Tab from the focused dialog stays inside it", async () => {
  await render(true);
  const dialog = container.querySelector<HTMLElement>("[role=dialog]")!;
  expect(document.activeElement).toBe(dialog);
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => dialog.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(dialog);
});
