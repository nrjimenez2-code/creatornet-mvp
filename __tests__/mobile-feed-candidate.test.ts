/** @jest-environment jsdom */
import { resolveMobileFeedHandoff, normalFeedController, mobileFeedReadoutSnapshot } from "@/lib/mobileFeedCandidate";
import { mobileFeedController } from "@/lib/mobileFeedController";
import { PreparedMobileFeedController } from "@/lib/mobileFeedPreparedController";

test("normal feed defaults to prepared transfer and explicit selectors retain their opt-out behavior", () => {
  expect(resolveMobileFeedHandoff("")).toBe("prepared-preload-audio");
  expect(resolveMobileFeedHandoff("?feedTransfer=prepared-preload-audio")).toBe("prepared-preload-audio");
  for (const value of ["1", "prepared", "prepared-audio", "prepared-inplace-audio", "", "0", "unknown"]) {
    expect(resolveMobileFeedHandoff(`?feedTransfer=${value}`, "prepared-preload-audio")).toBe(false);
  }
});

test("a fresh supported page enables prepared playback without a selector and unsupported browsers fall back", () => {
  const original = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "requestVideoFrameCallback");
  window.history.replaceState({}, "", "/dashboard");
  try {
    Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { configurable: true, value: jest.fn() });
    jest.isolateModules(() => {
      const candidate = jest.requireActual<typeof import("@/lib/mobileFeedCandidate")>("@/lib/mobileFeedCandidate");
      expect(candidate.mobileFeedHandoffSnapshot()).toBe("prepared-preload-audio");
      window.history.replaceState({}, "", "/dashboard?tab=following");
      expect(candidate.mobileFeedHandoffSnapshot()).toBe("prepared-preload-audio");
      Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { configurable: true, value: undefined });
      expect(candidate.mobileFeedHandoffSnapshot()).toBe(false);
      Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", { configurable: true, value: jest.fn() });
      window.history.replaceState({}, "", "/dashboard?feedTransfer=0");
      expect(candidate.mobileFeedHandoffSnapshot()).toBe(false);
      window.history.replaceState({}, "", "/dashboard");
      expect(candidate.mobileFeedHandoffSnapshot()).toBe(false);
    });
  } finally {
    if (original) Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", original);
    else delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback;
  }
});

test("capture-only readout persists through same-page navigation without changing the controller", () => {
  window.history.replaceState({}, "", "/?feedReadout=0"); expect(mobileFeedReadoutSnapshot()).toBe(false);
  window.history.replaceState({}, "", "/?tab=following"); expect(mobileFeedReadoutSnapshot()).toBe(false);
  window.history.replaceState({}, "", "/?feedReadout=1"); expect(mobileFeedReadoutSnapshot()).toBe(true);
});

test("same-page navigation retains the choice and an explicit selector can disable or replace it", () => {
  expect(resolveMobileFeedHandoff("?tab=following", "prepared-preload-audio")).toBe("prepared-preload-audio");
  expect(resolveMobileFeedHandoff("?feedBridge=0", "prepared-preload-audio")).toBe(false);
  expect(resolveMobileFeedHandoff("?feedBridge=1", "prepared-preload-audio")).toBe(true);
  expect(resolveMobileFeedHandoff("?feedBridge=1&feedTransfer=0")).toBe(false);
  expect(resolveMobileFeedHandoff("?feedBridge=0&feedTransfer=prepared-preload-audio")).toBe("prepared-preload-audio");
  expect(normalFeedController(false)).toBe(mobileFeedController);
  expect(normalFeedController(true)).toBe(mobileFeedController);
  expect(normalFeedController("prepared-preload-audio")).toBeInstanceOf(PreparedMobileFeedController);
});
