/** @jest-environment jsdom */

import { claimMobileFeedPlayer, mobileFeedPlaybackReady, mobileFeedResumeSnapshot, mobileFeedSeekFailed, releaseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";

describe("Preview direct player transfer ownership", () => {
  let api: typeof import("@/lib/mobileFeedPlayer");
  let queued: VoidFunction[];
  beforeEach(async () => {
    jest.useFakeTimers(); jest.setSystemTime(100_000); queued = [];
    jest.spyOn(globalThis, "queueMicrotask").mockImplementation(callback => { queued.push(callback); });
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "currentSrc", "get").mockImplementation(function (this: HTMLMediaElement) { return this.src; });
    await jest.isolateModulesAsync(async () => { api = await import("@/lib/mobileFeedPlayer"); });
  });
  afterEach(() => { queued = []; jest.clearAllTimers(); jest.restoreAllMocks(); jest.useRealTimers(); });
  function host() { const element = document.createElement("div"); document.body.appendChild(element); return element; }

  test("a same-task switch moves the same sound element once and immediately revokes the departing owner", () => {
    const first = Symbol("first"), second = Symbol("second"), firstHost = host(), secondHost = host();
    const video = api.claimMobileFeedPlayer(firstHost, first, "/first.mp4", "first");
    video.muted = false; video.currentTime = 7;
    const moves = jest.spyOn(Node.prototype, "appendChild");
    jest.mocked(HTMLMediaElement.prototype.pause).mockClear();
    api.releaseMobileFeedPlayer(first, true, { deferParking: true });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    expect(api.ownsMobileFeedPlayer(first, video)).toBe(false);
    expect(video.parentElement).toBe(firstHost);
    expect(api.mobileFeedResumeSnapshot("first", "/first.mp4")).toEqual({ postId: "first", contentVersion: "/first.mp4", position: 7, expiresAt: 105_000 });
    expect(api.claimMobileFeedPlayer(secondHost, second, "/second.mp4", "second")).toBe(video);
    queued.shift()!();
    api.releaseMobileFeedPlayer(first); // obsolete card cleanup
    expect(video.parentElement).toBe(secondHost);
    expect(video.muted).toBe(false);
    expect(api.ownsMobileFeedPlayer(second, video)).toBe(true);
    expect(moves.mock.calls.filter(([child]) => child === video)).toHaveLength(1);
    // Another post's expiry must not clear the new source or its audible owner.
    jest.advanceTimersByTime(5_000);
    expect(video.getAttribute("src")).toBe("/second.mp4");
    expect(api.ownsMobileFeedPlayer(second, video)).toBe(true);
    api.releaseMobileFeedPlayer(second);
  });

  test("an abandoned transfer parks before the next task and keeps the original five-second deadline", () => {
    const token = Symbol("abandoned"), firstHost = host();
    const video = api.claimMobileFeedPlayer(firstHost, token, "/first.mp4", "first");
    video.currentTime = 9;
    api.releaseMobileFeedPlayer(token, true, { deferParking: true });
    queued.shift()!();
    expect(video.parentElement).not.toBe(firstHost);
    expect(video.isConnected).toBe(true);
    expect(video.parentElement!.style.width).toBe("1px");
    jest.advanceTimersByTime(4_999);
    expect(api.mobileFeedResumeSnapshot("first", "/first.mp4").position).toBe(9);
    jest.advanceTimersByTime(1);
    expect(api.mobileFeedResumeSnapshot("first", "/first.mp4").position).toBe(0);
    expect(video.hasAttribute("src")).toBe(false);
  });

  test("an older queued release cannot park a newer pending transfer", () => {
    const a = Symbol("a"), b = Symbol("b"), firstHost = host(), secondHost = host();
    const video = api.claimMobileFeedPlayer(firstHost, a, "/a.mp4", "a");
    api.releaseMobileFeedPlayer(a, true, { deferParking: true });
    api.claimMobileFeedPlayer(secondHost, b, "/b.mp4", "b");
    api.releaseMobileFeedPlayer(b, true, { deferParking: true });
    queued.shift()!();
    expect(video.parentElement).toBe(secondHost);
    queued.shift()!();
    expect(video.parentElement).not.toBe(secondHost);
    expect(video.isConnected).toBe(true);
  });

  test("ordinary exit parks immediately after a direct claim and invalidates the previous queued park", () => {
    const a = Symbol("a"), b = Symbol("b"), firstHost = host(), secondHost = host();
    const video = api.claimMobileFeedPlayer(firstHost, a, "/a.mp4", "a");
    api.releaseMobileFeedPlayer(a, true, { deferParking: true });
    api.claimMobileFeedPlayer(secondHost, b, "/b.mp4", "b");
    api.releaseMobileFeedPlayer(b);
    const parking = video.parentElement;
    expect(parking).not.toBe(secondHost);
    queued.shift()!();
    expect(video.parentElement).toBe(parking);
  });

  test("Retry never defers parking even if a caller requests the transfer option", () => {
    const token = Symbol("retry"), firstHost = host();
    const video = api.claimMobileFeedPlayer(firstHost, token, "/a.mp4", "a");
    video.currentTime = 8;
    api.releaseMobileFeedPlayer(token, false, { deferParking: true });
    expect(video.parentElement).not.toBe(firstHost);
    expect(queued).toHaveLength(0);
    expect(api.mobileFeedResumeSnapshot("a", "/a.mp4")).toEqual(expect.objectContaining({ position: 8, expiresAt: null }));
  });
});

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

describe("candidate resume seek recovery", () => {
  let api: typeof import("@/lib/mobileFeedPlayer");
  beforeEach(async () => {
    jest.useFakeTimers(); jest.setSystemTime(100_000);
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    jest.spyOn(HTMLMediaElement.prototype, "currentSrc", "get").mockImplementation(function (this: HTMLMediaElement) { return this.src; });
    await jest.isolateModulesAsync(async () => { api = await import("@/lib/mobileFeedPlayer"); });
  });
  afterEach(() => { jest.clearAllTimers(); jest.restoreAllMocks(); jest.useRealTimers(); });

  function missedSeek(target = 11.521602, landed = 8, recovery = true) {
    const token = Symbol("missed-return");
    const video = api.claimMobileFeedPlayer(document.createElement("div"), token, "/return.m3u8", "return", { position: target, boundedSeekRecovery: recovery });
    let readyState = 1;
    let position = 0;
    const writes: number[] = [];
    Object.defineProperty(video, "readyState", { configurable: true, get: () => readyState });
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => position, set: value => { writes.push(value); position = writes.length === 1 ? landed : value; } });
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("seeked"));
    return { token, video, writes, target, ready: api.mobileFeedPlaybackReady(token)!, setReady: (value: number) => { readyState = value; }, setPosition: (value: number) => { position = value; } };
  }

  test("corrects a completed wrong-position seek when current-frame data arrives", async () => {
    const run = missedSeek();
    expect(run.writes).toEqual([run.target]);
    expect(api.mobileFeedPlaybackReady(run.token)).toBe(run.ready);
    run.setReady(2); run.video.dispatchEvent(new Event("loadeddata"));
    expect(run.writes).toEqual([run.target, run.target]);
    expect(api.mobileFeedPlaybackReady(run.token)).toBe(run.ready);
    run.video.dispatchEvent(new Event("seeked")); await run.ready;
    expect(api.mobileFeedSeekFailed(run.token)).toBe(false);
    api.releaseMobileFeedPlayer(run.token);
  });

  test("allows only one correction and retains the original two-second timeout", async () => {
    const run = missedSeek(7.680641, 4);
    jest.advanceTimersByTime(1_900);
    run.setReady(4); run.video.dispatchEvent(new Event("canplay"));
    expect(run.writes).toEqual([run.target, run.target]);
    run.setPosition(4); run.video.dispatchEvent(new Event("seeked"));
    run.video.dispatchEvent(new Event("loadeddata"));
    run.video.dispatchEvent(new Event("canplay"));
    run.video.dispatchEvent(new Event("loadedmetadata"));
    expect(run.writes).toEqual([run.target, run.target]);
    jest.advanceTimersByTime(100); await run.ready;
    expect(api.mobileFeedSeekFailed(run.token)).toBe(true);
    api.releaseMobileFeedPlayer(run.token);
  });

  test("Retry retains the failed return target rather than the incorrect reached position", async () => {
    const run = missedSeek();
    jest.advanceTimersByTime(2_000); await run.ready;
    api.releaseMobileFeedPlayer(run.token, false);
    expect(api.mobileFeedResumeSnapshot("return", "/return.m3u8")).toEqual({ postId: "return", contentVersion: "/return.m3u8", position: run.target, expiresAt: null });
    // An in-place Retry consumes no new five-second departure window.
    jest.advanceTimersByTime(6_000);
    const retry = Symbol("retry");
    api.claimMobileFeedPlayer(document.createElement("div"), retry, "/return.m3u8", "return", { reload: true, boundedSeekRecovery: true });
    run.video.dispatchEvent(new Event("loadedmetadata"));
    expect(run.writes.at(-1)).toBe(run.target);
    run.video.dispatchEvent(new Event("seeked"));
    await api.mobileFeedPlaybackReady(retry);
    run.setPosition(13);
    api.releaseMobileFeedPlayer(retry, false);
    expect(api.mobileFeedResumeSnapshot("return", "/return.m3u8").position).toBe(13);
  });

  test("a real departure after failure keeps the intended target with the usual expiry", async () => {
    const run = missedSeek();
    jest.advanceTimersByTime(2_000); await run.ready;
    api.releaseMobileFeedPlayer(run.token);
    const saved = api.mobileFeedResumeSnapshot("return", "/return.m3u8");
    expect(saved.position).toBe(run.target); expect(saved.expiresAt).toBe(107_000);
    jest.advanceTimersByTime(5_000);
    expect(api.mobileFeedResumeSnapshot("return", "/return.m3u8").position).toBe(0);
  });

  test("cancelled ownership cannot correct or rewind the incoming post", async () => {
    const run = missedSeek();
    api.releaseMobileFeedPlayer(run.token);
    const incoming = Symbol("incoming");
    api.claimMobileFeedPlayer(document.createElement("div"), incoming, "/incoming.mp4", "incoming");
    const writesBeforeEvents = [...run.writes];
    run.setPosition(0); run.setReady(4);
    run.video.dispatchEvent(new Event("loadeddata")); run.video.dispatchEvent(new Event("canplay"));
    await run.ready;
    expect(run.writes).toEqual(writesBeforeEvents); expect(run.video.currentTime).toBe(0);
    api.releaseMobileFeedPlayer(incoming);
  });

  test("correction waits for the assigned source and for seeking to stop", async () => {
    const run = missedSeek();
    run.setReady(4);
    let attached = false, seeking = false;
    Object.defineProperty(run.video, "currentSrc", { configurable: true, get: () => attached ? run.video.src : "https://old.test/old.m3u8" });
    Object.defineProperty(run.video, "seeking", { configurable: true, get: () => seeking });
    run.video.dispatchEvent(new Event("canplay")); expect(run.writes).toEqual([run.target]);
    attached = true; seeking = true;
    run.video.dispatchEvent(new Event("loadeddata")); expect(run.writes).toEqual([run.target]);
    seeking = false; run.video.dispatchEvent(new Event("seeked"));
    expect(run.writes).toEqual([run.target, run.target]);
    run.video.dispatchEvent(new Event("seeked")); await run.ready;
    api.releaseMobileFeedPlayer(run.token);
  });

  test("replacement content cannot inherit a failed target parked for Retry", async () => {
    const run = missedSeek();
    jest.advanceTimersByTime(2_000); await run.ready;
    api.releaseMobileFeedPlayer(run.token, false);
    const replacement = Symbol("replacement-content");
    api.claimMobileFeedPlayer(document.createElement("div"), replacement, "/new.m3u8", "return", { contentVersion: "new-content", boundedSeekRecovery: true });
    run.setReady(1); run.video.dispatchEvent(new Event("loadedmetadata"));
    expect(run.writes.at(-1)).toBe(0);
    run.video.dispatchEvent(new Event("seeked")); await api.mobileFeedPlaybackReady(replacement);
    api.releaseMobileFeedPlayer(replacement);
  });

  test("Retry preserves the clamped target for a return near the media end", async () => {
    const run = missedSeek(50, 8);
    // The media duration arrives with the initial metadata in this case.
    api.releaseMobileFeedPlayer(run.token, false);
    Object.defineProperty(run.video, "duration", { configurable: true, value: 20 });
    const retry = Symbol("clamped-return");
    api.claimMobileFeedPlayer(document.createElement("div"), retry, "/return.m3u8", "return", { reload: true, boundedSeekRecovery: true });
    run.setPosition(8); run.video.dispatchEvent(new Event("seeked"));
    jest.advanceTimersByTime(2_000); await api.mobileFeedPlaybackReady(retry);
    api.releaseMobileFeedPlayer(retry, false);
    expect(api.mobileFeedResumeSnapshot("return", "/return.m3u8").position).toBe(19.99);
  });

  test("ordinary mobile playback does not opt into correction or target retention", async () => {
    const run = missedSeek(11.521602, 8, false);
    run.setReady(4); run.video.dispatchEvent(new Event("loadeddata")); run.video.dispatchEvent(new Event("canplay"));
    expect(run.writes).toEqual([run.target]);
    jest.advanceTimersByTime(2_000); await run.ready;
    api.releaseMobileFeedPlayer(run.token, false);
    expect(api.mobileFeedResumeSnapshot("return", "/return.m3u8").position).toBe(8);
  });
});
