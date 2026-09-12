/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
let mockUser = { userId: "creator-a", session: { access_token: "access" }, loading: false };
jest.mock("@/lib/useUser", () => ({ useUser: () => mockUser }));
jest.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
import StripeConnectedSuccess from "@/components/StripeConnectedSuccess";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const request = jest.fn();
const render = () => act(async () => { root.render(createElement(StripeConnectedSuccess)); });
const ready = { connected: true, onboarding_complete: true };
beforeEach(() => {
  mockUser = { userId: "creator-a", session: { access_token: "access" }, loading: false };
  localStorage.clear();
  window.history.replaceState({}, "", "/dashboard?connect=success&tab=discover#feed");
  request.mockReset().mockResolvedValue({ ok: true, json: async () => ready });
  global.fetch = request;
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

test.each(["", "?connect=pending", "?connect=error", "?connect=restart"])("no popup or extra status request for %s", async query => {
  window.history.replaceState({}, "", `/dashboard${query}`);
  await render();
  expect(request).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
});
test("waits for authentication, verifies capabilities and consumes only the return flag", async () => {
  mockUser.loading = true; await render(); expect(request).not.toHaveBeenCalled();
  mockUser.loading = false; await render();
  expect(request).toHaveBeenCalledWith("/api/stripe/connect/status", expect.objectContaining({ headers: { Authorization: "Bearer access" } }));
  expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  expect(container.querySelector("h2")?.textContent).toBe("Stripe Connected!");
  expect(container.querySelector("p")?.textContent).toBe("You’re all set. Start earning today.");
  expect(window.location.search).toBe("?tab=discover");
  expect(window.location.hash).toBe("#feed");
});
test.each(["button.primary", "button[aria-label]", "escape"])("dismiss via %s; remount and stale return URL never replay", async method => {
  await render();
  await act(async () => {
    if (method === "escape") container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { bubbles: true }));
    else if (method === "button.primary") (container.querySelectorAll("button")[1] as HTMLButtonElement).click();
    else (container.querySelector(method) as HTMLButtonElement).click();
  });
  expect(container.querySelector("dialog")).toBeNull();
  await act(async () => root.unmount()); root = createRoot(container);
  window.history.replaceState({}, "", "/dashboard?connect=success");
  await render();
  expect(container.querySelector("dialog")).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  expect(window.location.search).toBe("");
});
test.each([{ connected: false }, { connected: true, onboarding_complete: false }])("never trusts a forged success URL with status %j", async status => {
  request.mockResolvedValue({ ok: true, json: async () => status });
  await render();
  expect(container.querySelector("dialog")).toBeNull();
  expect(localStorage.length).toBe(0);
});
test.each([false, true])("failed verification stays quiet (network failure: %s)", async network => {
  if (network) request.mockRejectedValue(new Error("offline"));
  else request.mockResolvedValue({ ok: false });
  await render();
  expect(container.querySelector("dialog")).toBeNull();
  expect(localStorage.length).toBe(0);
});
test("ignores a stale request after account change", async () => {
  let resolve!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await render();
  mockUser = { userId: "creator-b", session: { access_token: "other" }, loading: false };
  request.mockResolvedValue({ ok: false }); await render();
  await act(async () => resolve({ ok: true, json: async () => ready }));
  expect(container.querySelector("dialog")).toBeNull();
  expect(localStorage.length).toBe(0);
});
test("storage restrictions do not block success or replay on normal visits", async () => {
  const get = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  const set = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  try {
    await render(); expect(container.querySelector("dialog")).not.toBeNull();
    await act(async () => root.unmount()); root = createRoot(container);
    await render(); expect(container.querySelector("dialog")).toBeNull();
  } finally { get.mockRestore(); set.mockRestore(); }
});
