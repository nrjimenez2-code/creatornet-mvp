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
