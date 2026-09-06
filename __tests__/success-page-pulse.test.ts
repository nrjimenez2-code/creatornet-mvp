/**
 * @jest-environment jsdom
 */
/**
 * app/success/page.tsx — the ✨ pulses only while a request is in flight.
 *
 * With status "checking" (confirm call pending) the icon animates; once the
 * page settles on an error it stops, so "Heads up" no longer looks like it
 * is still loading. No money-path code is exercised: fetch is a stub.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

let mockSearch = "";
const router = { replace: jest.fn(), push: jest.fn() };

jest.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));
jest.mock("@/lib/useUser", () => ({
  useUser: () => ({ userId: "buyer_1", session: null, loading: false }),
}));

import SuccessPage from "@/app/success/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(createElement(SuccessPage));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const sparkle = () => Array.from(container.querySelectorAll("div")).find((d) => d.textContent === "✨") ?? null;

beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("SuccessPage sparkle", () => {
  test("pulses while the confirm request is still in flight", async () => {
    mockSearch = "session_id=cs_test_1";
    (globalThis as { fetch?: unknown }).fetch = jest.fn(() => new Promise(() => {})); // never resolves

    await render();

    expect(container.textContent).toContain("Almost there");
    expect(sparkle()?.classList.contains("animate-pulse")).toBe(true);
    expect(sparkle()?.getAttribute("aria-hidden")).toBe("true");
  });

  test("stops pulsing once the page settles on an error", async () => {
    mockSearch = ""; // no session_id → immediate error state, no network
    (globalThis as { fetch?: unknown }).fetch = jest.fn();

    await render();

    expect(container.textContent).toContain("Heads up");
    expect(container.textContent).toContain("Missing session id.");
    expect(sparkle()?.classList.contains("animate-pulse")).toBe(false);
    expect((globalThis as { fetch?: jest.Mock }).fetch).not.toHaveBeenCalled();
  });
});
