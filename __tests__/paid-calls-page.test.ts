/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import CallsPage from "@/app/calls/page";
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
let root: Root, container: HTMLDivElement;
const mockFetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>();
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
beforeEach(() => { mockFetch.mockReset(); globalThis.fetch = mockFetch; container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch; });
test("#5 actual paid calls page exposes only the internal paid-access route and supports pagination", async () => {
  mockFetch.mockResolvedValueOnce(reply({ items: [{ id: "owned", title: "Paid call", status: "paid", access_granted: true }], hasMore: true }))
    .mockResolvedValueOnce(reply({ items: [], hasMore: false }));
  await act(async () => root.render(createElement(CallsPage)));
  expect(container.querySelector('a[href="/api/calls/owned/schedule"]')).not.toBeNull();
  const next = [...container.querySelectorAll("button")].find(button => button.textContent === "Next")!;
  await act(async () => next.click());
  expect(mockFetch.mock.calls[1][0]).toBe("/api/calls?offset=20");
  expect(container.textContent).toContain("No paid calls on this page.");
});
test("#5 pending calls do not expose scheduling; failed loading can be retried", async () => {
  mockFetch.mockResolvedValueOnce(reply({ error: "Synthetic failure" }, false))
    .mockResolvedValueOnce(reply({ items: [{ id: "pending", title: "Pending call", status: "pending", access_granted: false }], hasMore: false }));
  await act(async () => root.render(createElement(CallsPage)));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Synthetic failure");
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Try again")!.click());
  expect(container.textContent).toContain("Awaiting payment confirmation");
  expect(container.querySelector('a[href*="/schedule"]')).toBeNull();
});
