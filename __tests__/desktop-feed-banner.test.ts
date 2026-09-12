/** @jest-environment jsdom */
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
const mounted = jest.fn();
jest.mock("next/dynamic", () => ({ __esModule: true, default: () => function Banner() {
  useEffect(() => { mounted(); }, []);
  return createElement("span", null, "Stripe status");
} }));
import DesktopStripeConnectBanner from "@/components/DesktopStripeConnectBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
test("desktop-only banner never mounts on mobile and reacts to viewport changes", async () => {
  let matches = false;
  const listeners = new Set<() => void>();
  window.matchMedia = jest.fn(() => ({ get matches() { return matches; },
    addEventListener: (_event: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_event: string, fn: () => void) => listeners.delete(fn),
  })) as any;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(DesktopStripeConnectBanner)));
    expect(mounted).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    await act(async () => { matches = true; listeners.forEach(fn => fn()); });
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("Stripe status");
    await act(async () => { matches = false; listeners.forEach(fn => fn()); });
    expect(container.textContent).toBe("");
  } finally { await act(async () => root.unmount()); }
  expect(listeners.size).toBe(0);
});
