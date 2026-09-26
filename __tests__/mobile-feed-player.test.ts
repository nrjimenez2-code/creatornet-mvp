/** @jest-environment jsdom */

import { claimMobileFeedPlayer, releaseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";

describe("mobile feed media element", () => {
  beforeEach(() => {
    jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

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
});
