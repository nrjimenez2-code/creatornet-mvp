import { clearMobileFeedSnapshot, readMobileFeedSnapshot, saveMobileFeedSnapshot } from "@/lib/mobileFeedSnapshot";
import type { PostRow } from "@/lib/feedV3";

const row = (id: string): PostRow => ({
  id, creator_id: "creator", product_id: null, price_cents: null,
  title: id, video_url: `/${id}.mp4`, poster_url: null,
  content: id, interests: null, created_at: null,
  purchaseOptionsReady: true,
});

describe("mobile feed profile-return snapshot", () => {
  afterEach(() => jest.restoreAllMocks());

  it("restores the active post and position only for the same viewer and tab", () => {
    saveMobileFeedSnapshot("discover", "viewer-a", [row("first"), row("third")], "third", 1320);
    const snapshot = readMobileFeedSnapshot("discover", "viewer-a");
    expect(snapshot?.activePostId).toBe("third");
    expect(snapshot?.scrollTop).toBe(1320);
    expect(snapshot?.items.map(item => item.id)).toEqual(["first", "third"]);
    expect(snapshot?.items[0].purchaseOptionsReady).toBe(false);
    expect(readMobileFeedSnapshot("discover", "viewer-b")).toBeNull();
    expect(readMobileFeedSnapshot("following", "viewer-a")).toBeNull();
  });

  it("expires quickly and ignores a snapshot without a valid active post", () => {
    const now = 1800000000000;
    jest.spyOn(Date, "now").mockReturnValue(now);
    saveMobileFeedSnapshot("following", "viewer-expiry", [row("one")], "missing", 1);
    expect(readMobileFeedSnapshot("following", "viewer-expiry")).toBeNull();
    saveMobileFeedSnapshot("following", "viewer-expiry", [row("one")], "one", 1);
    jest.spyOn(Date, "now").mockReturnValue(now + 2 * 60 * 1000 + 1);
    expect(readMobileFeedSnapshot("following", "viewer-expiry")).toBeNull();
  });

  it("drops stale rows when a fresh feed is empty or fails", () => {
    saveMobileFeedSnapshot("discover", "viewer-clear", [row("one")], "one", 0);
    clearMobileFeedSnapshot("discover", "viewer-clear");
    expect(readMobileFeedSnapshot("discover", "viewer-clear")).toBeNull();
  });
});
