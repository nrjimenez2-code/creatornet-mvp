/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let mockUserId: string | null = "creator";
jest.mock("@/lib/useUser", () => ({ useUser: () => ({ userId: mockUserId }) }));
jest.mock("@/lib/supabaseClient", () => ({ createClient: () => ({}) }));
jest.mock("@/components/SchedulingConnections", () => ({ __esModule: true, default: () => null }));
import PostComposer from "@/components/PostComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
type PendingResponse = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
};
function deferred(): PendingResponse {
  let resolve!: PendingResponse["resolve"], reject!: PendingResponse["reject"];
  const promise = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(data: unknown, ok = true): Response {
  return { ok, json: async () => data } as Response;
}
function settings(enabled = true): Response {
  return response({ success: true, items: [], capabilities: { premiumDelivery: enabled, premiumDeliveryReady: enabled } });
}

let root: Root, container: HTMLDivElement, pending: PendingResponse[], fetchMock: jest.Mock;
beforeEach(async () => {
  mockUserId = "creator";
  pending = [];
  fetchMock = jest.fn((url: RequestInfo | URL) => {
    if (String(url) === "/api/products") {
      const request = deferred(); pending.push(request); return request.promise;
    }
    if (String(url) === "/api/stripe/connect/status") {
      return Promise.resolve(response({ onboarding_complete: true, tipping_enabled: true }));
    }
    throw new Error("Unexpected request " + String(url));
  });
  globalThis.fetch = fetchMock as typeof fetch;
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(PostComposer)); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); globalThis.fetch = originalFetch;
});

function expectNoComposerControls() {
  expect(container.querySelector("#post-price")).toBeNull();
  expect(container.querySelector('input[type="file"]')).toBeNull();
  expect(container.querySelector('button[aria-pressed]')).toBeNull();
  expect(container.textContent).not.toContain('Attach "Buy / Book"');
  expect(container.textContent).not.toContain('Book a free call');
  expect(Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Post")).toBeUndefined();
}
function expectLoading() {
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading post settings");
  expect(container.querySelectorAll(".cn-skeleton").length).toBeGreaterThan(0);
  expect(container.textContent).toContain("Loading post settings");
  expectNoComposerControls();
}

test("keeps the legacy form hidden until delayed settings enable Buy/Book/Tip", async () => {
  expectLoading();
  await act(async () => pending[0].resolve(settings()));
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(Array.from(container.querySelectorAll('button[aria-pressed]')).map(button => button.textContent)).toEqual(["Buy", "Book", "Tip"]);
  expect(container.querySelector("#post-price")).toBeNull();
  expect(container.textContent).not.toContain('Attach "Buy / Book"');
});

test("a failed request shows Retry and stays gated while the retry loads", async () => {
  await act(async () => pending[0].reject(new Error("network unavailable")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t load post settings");
  expectNoComposerControls();
  const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry")!;
  await act(async () => retry.click());
  expectLoading();
  expect(pending).toHaveLength(2);
  await act(async () => pending[1].resolve(settings()));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Video button");
  expect(fetchMock.mock.calls.filter(([url]) => url === "/api/stripe/connect/status")).toHaveLength(1);
});

test.each([
  ["HTTP error", () => response({ error: "unavailable" }, false)],
  ["application error", () => response({ success: false, items: [] })],
  ["missing product list", () => response({ success: true })],
  ["invalid JSON", () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }) as unknown as Response],
])("%s shows an error without falling back to legacy controls", async (_name, failedResponse) => {
  await act(async () => pending[0].resolve(failedResponse()));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).toContain("Retry");
  expectNoComposerControls();
});

test("confirmed disabled capabilities retain the legacy flow after loading", async () => {
  expectLoading();
  await act(async () => pending[0].resolve(settings(false)));
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector("#post-price")).not.toBeNull();
  expect(container.textContent).toContain('Attach "Buy / Book"');
});

test("a previous user's late response cannot replace the current user's settings", async () => {
  mockUserId = "other-creator";
  await act(async () => root.render(createElement(PostComposer)));
  expectLoading();
  expect(pending).toHaveLength(2);
  await act(async () => pending[1].resolve(settings(false)));
  await act(async () => pending[0].resolve(settings()));
  expect(container.querySelector("#post-price")).not.toBeNull();
  expect(container.textContent).not.toContain("Video button");
});
