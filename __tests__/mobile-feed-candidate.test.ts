/** @jest-environment jsdom */
import { resolveMobileFeedHandoff, normalFeedController, mobileFeedReadoutSnapshot } from "@/lib/mobileFeedCandidate";
import { mobileFeedController } from "@/lib/mobileFeedController";
import { PreparedMobileFeedController } from "@/lib/mobileFeedPreparedController";

test("normal feed is off by default and only the exact transfer selector opts in", () => {
  expect(resolveMobileFeedHandoff("")).toBe(false);
  expect(resolveMobileFeedHandoff("?feedTransfer=prepared-preload-audio")).toBe("prepared-preload-audio");
  for (const value of ["1", "prepared", "prepared-audio", "prepared-inplace-audio", "", "0", "unknown"]) {
    expect(resolveMobileFeedHandoff(`?feedTransfer=${value}`, "prepared-preload-audio")).toBe(false);
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
