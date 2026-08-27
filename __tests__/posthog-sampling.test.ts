import { sampleRateFor, shouldSendEvent } from "@/lib/posthogSampling";

describe("sampleRateFor", () => {
  test("samples pageview, pageleave, and video_impression by default", () => {
    expect(sampleRateFor("$pageview")).toBe(0.5);
    expect(sampleRateFor("$pageleave")).toBe(0.5);
    expect(sampleRateFor("video_impression")).toBe(0.25);
  });

  test("never samples any other event", () => {
    expect(sampleRateFor("feed_viewed")).toBe(1);
    expect(sampleRateFor("buy_click")).toBe(1);
    expect(sampleRateFor("$autocapture")).toBe(1);
  });
});

describe("shouldSendEvent", () => {
  test("always sends unsampled events regardless of the coin flip", () => {
    expect(shouldSendEvent("feed_viewed", () => 0.999)).toBe(true);
  });

  test("sends a sampled event when the flip lands under the rate", () => {
    // Arrange: $pageview rate is 0.5
    const underRate = () => 0.49;
    const overRate = () => 0.51;

    // Act + Assert
    expect(shouldSendEvent("$pageview", underRate)).toBe(true);
    expect(shouldSendEvent("$pageview", overRate)).toBe(false);
  });

  test("drops video_impression above its rate and keeps it below", () => {
    expect(shouldSendEvent("video_impression", () => 0.24)).toBe(true);
    expect(shouldSendEvent("video_impression", () => 0.26)).toBe(false);
  });
});
