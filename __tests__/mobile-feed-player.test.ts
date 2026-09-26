/** @jest-environment jsdom */

import { claimMobileFeedPlayer, mobileFeedPlaybackReady, mobileFeedResumeSnapshot, mobileFeedSeekFailed, releaseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";

describe("mobile feed media element", () => {
  beforeEach(() => {
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
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

describe("fixed departure snapshots", () => {
  beforeEach(() => {
    jest.useFakeTimers(); jest.setSystemTime(100_000);
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
  function depart(id: string, position = 12.4, version = id) {
    const token = Symbol(id);
    const video = claimMobileFeedPlayer(document.createElement("div"), token, `https://example.test/${id}.mp4`, id, { contentVersion: version });
    video.currentTime = position; releaseMobileFeedPlayer(token);
    return video;
  }
  test.each([4_999, 5_000, 5_001])("return at %i ms uses a synchronously checked snapshot", delay => {
    const id = `boundary-${delay}`; depart(id);
    const saved = mobileFeedResumeSnapshot(id, id);
    // Advance the wall clock without delivering the expiry callback.
    jest.setSystemTime(100_000 + delay);
    expect(mobileFeedResumeSnapshot(id, id).position).toBe(delay < 5_000 ? 12.4 : 0);
    const token = Symbol(id);
    const video = claimMobileFeedPlayer(document.createElement("div"), token, `https://example.test/${id}.mp4`, id, { contentVersion: id, snapshot: saved });
    Object.defineProperty(video, "currentSrc", { configurable: true, get: () => video.src });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.currentTime).toBe(delay < 5_000 ? 12.4 : 0);
    expect(mobileFeedResumeSnapshot(id, id).position).toBe(0);
    releaseMobileFeedPlayer(token);
  });
  test("one timer expires parked media but keeps the audible element", () => {
    const video = depart("park-expiry");
    jest.advanceTimersByTime(5_000);
    expect(video.hasAttribute("src")).toBe(false);
    expect(video.isConnected).toBe(true);
    const token = Symbol("new");
    expect(claimMobileFeedPlayer(document.createElement("div"), token, "next.mp4", "new")).toBe(video);
    releaseMobileFeedPlayer(token);
  });
  test("expiry of another saved post never rewinds the watched post", () => {
    depart("offscreen");
    const token = Symbol("watching");
    const video = claimMobileFeedPlayer(document.createElement("div"), token, "watching.mp4", "watching");
    video.currentTime = 24;
    jest.advanceTimersByTime(5_001);
    expect(video.currentTime).toBe(24); expect(video.getAttribute("src")).toBe("watching.mp4");
    releaseMobileFeedPlayer(token);
  });
  test("two-entry eviction and overwritten content cannot inherit an old position", () => {
    depart("evicted"); depart("second"); depart("third");
    expect(mobileFeedResumeSnapshot("evicted", "evicted").position).toBe(0);
    expect(mobileFeedResumeSnapshot("second", "second").position).toBe(12.4);
    expect(mobileFeedResumeSnapshot("second", "replacement").position).toBe(0);
  });
  test("preparation reads and rendition changes do not extend a departure deadline", () => {
    depart("versioned", 8, "content-v1");
    const first = mobileFeedResumeSnapshot("versioned", "content-v1");
    jest.advanceTimersByTime(4_999);
    expect(mobileFeedResumeSnapshot("versioned", "content-v1")).toEqual(first);
    jest.advanceTimersByTime(1);
    const token = Symbol("replacement-source");
    const video = claimMobileFeedPlayer(document.createElement("div"), token, "other-rendition.mp4", "versioned", { contentVersion: "content-v1", snapshot: first });
    video.dispatchEvent(new Event("loadedmetadata")); expect(video.currentTime).toBe(0);
    releaseMobileFeedPlayer(token);
  });
  test("a consumed return and subsequent departure start a fresh window", () => {
    depart("repeat", 8); jest.advanceTimersByTime(4_000);
    const token = Symbol("repeat");
    const video = claimMobileFeedPlayer(document.createElement("div"), token, "repeat.mp4", "repeat", { contentVersion: "repeat" });
    video.currentTime = 9; releaseMobileFeedPlayer(token);
    jest.advanceTimersByTime(2_000);
    expect(mobileFeedResumeSnapshot("repeat", "repeat").position).toBe(9);
    jest.advanceTimersByTime(3_000);
    expect(mobileFeedResumeSnapshot("repeat", "repeat").position).toBe(0);
  });
  test("active source replacement retains position without a new departure", () => {
    const first = Symbol("replace-first"), second = Symbol("replace-second");
    const video = claimMobileFeedPlayer(document.createElement("div"), first, "v1.mp4", "replace", { contentVersion: "v1" });
    video.currentTime = 8; releaseMobileFeedPlayer(first, false);
    claimMobileFeedPlayer(document.createElement("div"), second, "other-v1.mp4", "replace", { contentVersion: "v1" });
    Object.defineProperty(video, "currentSrc", { configurable: true, get: () => video.src });
    video.dispatchEvent(new Event("loadedmetadata")); expect(video.currentTime).toBe(8);
    expect(mobileFeedResumeSnapshot("replace", "v1").expiresAt).toBeNull();
    releaseMobileFeedPlayer(second);
  });
});
