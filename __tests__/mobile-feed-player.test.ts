/** @jest-environment jsdom */

import { claimMobileFeedPlayer, mobileFeedPlaybackReady, mobileFeedSeekFailed, releaseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";

describe("mobile feed media element", () => {
  beforeEach(() => {
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "currentSrc", "get").mockImplementation(function (this: HTMLMediaElement) { return this.src; });
  });

  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it("keeps the same element through three posts and a profile return", () => {
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    const thirdHost = document.createElement("div");
    const returnHost = document.createElement("div");
    const first = Symbol("first");
    const second = Symbol("second");
    const third = Symbol("third");
    const returned = Symbol("returned");

    const video = claimMobileFeedPlayer(firstHost, first, "/first.mp4");
    expect(video.parentElement).toBe(firstHost);
    releaseMobileFeedPlayer(first);
    expect(video.isConnected).toBe(true);
    expect(claimMobileFeedPlayer(secondHost, second, "/second.m3u8")).toBe(video);
    // Cleanup from the previous card cannot park a newer card's player.
    releaseMobileFeedPlayer(first);
    expect(video.parentElement).toBe(secondHost);
    releaseMobileFeedPlayer(second);
    expect(claimMobileFeedPlayer(thirdHost, third, "/third.m3u8")).toBe(video);
    releaseMobileFeedPlayer(third);
    expect(video.isConnected).toBe(true);
    expect(claimMobileFeedPlayer(returnHost, returned, "/first.mp4")).toBe(video);
    expect(video.parentElement).toBe(returnHost);
    expect(video.getAttribute("src")).toBe("/first.mp4");
    releaseMobileFeedPlayer(returned);
  });

  it("resumes a post watched moments ago before playback starts", async () => {
    jest.useFakeTimers();
    const a = Symbol("resume-a");
    const b = Symbol("resume-b");
    const returned = Symbol("resume-return");
    const video = claimMobileFeedPlayer(document.createElement("div"), a, "/resume-a.mp4", "resume-a");
    video.currentTime = 12.4;
    releaseMobileFeedPlayer(a);
    claimMobileFeedPlayer(document.createElement("div"), b, "/resume-b.mp4", "resume-b");
    video.currentTime = 1;
    releaseMobileFeedPlayer(b);
    jest.advanceTimersByTime(3_000);

    claimMobileFeedPlayer(document.createElement("div"), returned, "/resume-a.mp4", "resume-a");
    const ready = mobileFeedPlaybackReady(returned);
    expect(ready).not.toBeNull();
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.currentTime).toBe(12.4);
    video.dispatchEvent(new Event("seeked"));
    await ready;
    expect(mobileFeedPlaybackReady(returned)).toBeNull();
    releaseMobileFeedPlayer(returned);
  });

  it("forgets a post after five seconds, including a profile return", async () => {
    jest.useFakeTimers();
    const first = Symbol("expired-first");
    const returned = Symbol("expired-return");
    const video = claimMobileFeedPlayer(document.createElement("div"), first, "/expired.mp4", "expired");
    video.currentTime = 9;
    releaseMobileFeedPlayer(first);
    jest.advanceTimersByTime(5_001);

    claimMobileFeedPlayer(document.createElement("div"), returned, "/expired.mp4", "expired");
    const ready = mobileFeedPlaybackReady(returned);
    expect(ready).not.toBeNull();
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("seeked"));
    await ready;
    expect(video.currentTime).toBe(0);
    releaseMobileFeedPlayer(returned);
  });

  it("does not complete a requested seek on a mismatched seeked event", async () => {
    jest.useFakeTimers();
    const token = Symbol("strict-seek");
    const video = claimMobileFeedPlayer(document.createElement("div"), token, "/strict.mp4", "strict", { position: 12 });
    const ready = mobileFeedPlaybackReady(token)!;
    video.currentTime = 0; video.dispatchEvent(new Event("seeked"));
    expect(mobileFeedPlaybackReady(token)).toBe(ready);
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.currentTime).toBe(12);
    video.dispatchEvent(new Event("seeked")); await ready;
    expect(mobileFeedSeekFailed(token)).toBe(false);
    releaseMobileFeedPlayer(token);
  });

  it("reports a failed seek separately from successful readiness", async () => {
    jest.useFakeTimers();
    const token = Symbol("failed-seek");
    claimMobileFeedPlayer(document.createElement("div"), token, "/bad-seek.mp4", "bad-seek", { position: 12 });
    const ready = mobileFeedPlaybackReady(token);
    jest.advanceTimersByTime(2_000); await ready;
    expect(mobileFeedSeekFailed(token)).toBe(true);
    releaseMobileFeedPlayer(token);
  });
});
