import {
  isUnreliableVideoUrl,
  isWithinRenderWindow,
  mapFeedV3Row,
  mapFeedV3Rows,
  resolvePriceCents,
  RENDER_WINDOW_RADIUS,
  type FeedV3Row,
} from "@/lib/feedV3";

function makeRow(overrides: Partial<FeedV3Row> = {}): FeedV3Row {
  return {
    post_id: "post-1",
    creator_id: "creator-1",
    product_id: null,
    price_cents: null,
    title: "A title",
    video_url: "https://cdn.example.com/v.mp4",
    poster_url: null,
    interests: ["fitness"],
    hashtags: null,
    created_at: "2026-08-01T00:00:00Z",
    likes_count: 3,
    comments_count: 1,
    shares_count: 0,
    allow_booking: false,
    booking_url: null,
    creator_name: "Jane",
    creator_username: "jane",
    creator_avatar_url: "https://cdn.example.com/a.png",
    product_type: null,
    product_price_cents: null,
    is_liked: false,
    is_following: false,
    ...overrides,
  };
}

describe("resolvePriceCents", () => {
  test("post price wins when positive", () => {
    expect(resolvePriceCents(500, 900)).toBe(500);
  });

  test("falls back to product price when post price is 0 or null", () => {
    expect(resolvePriceCents(0, 900)).toBe(900);
    expect(resolvePriceCents(null, 900)).toBe(900);
  });

  test("returns the post price number when product price is absent", () => {
    expect(resolvePriceCents(0, null)).toBe(0);
  });

  test("returns 0 when both are absent", () => {
    expect(resolvePriceCents(null, null)).toBe(0);
    expect(resolvePriceCents(undefined, undefined)).toBe(0);
  });

  test("matches the old waterfall for negative post prices", () => {
    // Old code: post price only wins when > 0, then product price when
    // truthy, then the raw post price, then 0.
    expect(resolvePriceCents(-5, 900)).toBe(900);
    expect(resolvePriceCents(-5, null)).toBe(-5);
    expect(resolvePriceCents(-5, 0)).toBe(-5);
  });
});

describe("isUnreliableVideoUrl", () => {
  test("flags known-bad hosts and their subdomains", () => {
    expect(isUnreliableVideoUrl("https://sample-videos.com/v.mp4")).toBe(true);
    expect(isUnreliableVideoUrl("https://cdn.sample-videos.com/v.mp4")).toBe(true);
  });

  test("allows normal hosts and tolerates junk input", () => {
    expect(isUnreliableVideoUrl("https://cdn.example.com/v.mp4")).toBe(false);
    expect(isUnreliableVideoUrl("not a url")).toBe(false);
    expect(isUnreliableVideoUrl(null)).toBe(false);
  });
});

describe("mapFeedV3Row", () => {
  test("maps the RPC row onto the render shape", () => {
    // Arrange
    const row = makeRow({
      product_id: "prod-1",
      product_type: "digital",
      price_cents: 0,
      product_price_cents: 1500,
      is_liked: true,
      is_following: true,
    });

    // Act
    const post = mapFeedV3Row(row);

    // Assert
    expect(post.id).toBe("post-1");
    expect(post.product_id).toBe("prod-1");
    expect(post.product_type).toBe("digital");
    expect(post.price_cents).toBe(1500);
    expect(post.is_liked).toBe(true);
    expect(post.is_following).toBe(true);
    expect(post.creator_name).toBe("Jane");
    expect(post.creator_username).toBe("jane");
    expect(post.content).toBe("A title");
  });

  test("nulls video_url for unreliable hosts but keeps the poster", () => {
    const post = mapFeedV3Row(
      makeRow({
        video_url: "https://sample-videos.com/v.mp4",
        poster_url: "  https://cdn.example.com/p.jpg  ",
      })
    );
    expect(post.video_url).toBeNull();
    expect(post.poster_url).toBe("https://cdn.example.com/p.jpg");
  });

  test("falls back to the username when the profile has no full_name", () => {
    const post = mapFeedV3Row(makeRow({ creator_name: null, creator_username: "jane" }));
    expect(post.creator_name).toBe("jane");
    expect(post.creator_username).toBe("jane");
  });

  test("hides product_type when the post has no product_id", () => {
    const post = mapFeedV3Row(makeRow({ product_id: null, product_type: "digital" }));
    expect(post.product_type).toBeNull();
  });

  test("strips NULL elements out of hashtag and interest arrays", () => {
    // Postgres text[] legally contains NULL elements; render code calls
    // string methods on every element, so the mapper must drop them.
    const post = mapFeedV3Row(
      makeRow({
        hashtags: ["ok", null, "also-ok"] as unknown as string[],
        interests: [null, "fitness"] as unknown as string[],
      })
    );
    expect(post.hashtags).toEqual(["ok", "also-ok"]);
    expect(post.interests).toEqual(["fitness"]);
  });

  test("maps creator_verified true through when the RPC returns it", () => {
    const post = mapFeedV3Row(makeRow({ creator_verified: true }));
    expect(post.creator_verified).toBe(true);
  });

  test("maps creator_verified to false when the column is missing or null", () => {
    // Before migration 023 is applied the RPC has no such column at all.
    const missing = mapFeedV3Row(makeRow());
    expect(missing.creator_verified).toBe(false);

    const nulled = mapFeedV3Row(makeRow({ creator_verified: null }));
    expect(nulled.creator_verified).toBe(false);

    const explicitFalse = mapFeedV3Row(makeRow({ creator_verified: false }));
    expect(explicitFalse.creator_verified).toBe(false);
  });

  test("never lets a truthy non-boolean become a verified badge", () => {
    // Defensive: only boolean true counts (a stray "true" string or 1 from a
    // mis-typed column must not light the badge).
    const post = mapFeedV3Row(makeRow({ creator_verified: "true" as unknown as boolean }));
    expect(post.creator_verified).toBe(false);
  });

  test("defaults counts and flags for null RPC values", () => {
    const post = mapFeedV3Row(
      makeRow({
        likes_count: null,
        comments_count: null,
        shares_count: null,
        allow_booking: null,
        is_liked: null,
        is_following: null,
        interests: null,
      })
    );
    expect(post.likes_count).toBe(0);
    expect(post.comments_count).toBe(0);
    expect(post.shares_count).toBe(0);
    expect(post.allow_booking).toBe(false);
    expect(post.is_liked).toBe(false);
    expect(post.is_following).toBe(false);
    expect(post.interests).toEqual([]);
  });
});

describe("mapFeedV3Rows", () => {
  test("drops rows with no renderable media", () => {
    const rows = [
      makeRow({ post_id: "keep" }),
      makeRow({ post_id: "drop", video_url: null, poster_url: null }),
    ];
    const posts = mapFeedV3Rows(rows);
    expect(posts.map((p) => p.id)).toEqual(["keep"]);
  });

  test("drops malformed rows and tolerates non-array input", () => {
    expect(mapFeedV3Rows(null)).toEqual([]);
    expect(mapFeedV3Rows(undefined)).toEqual([]);
    expect(mapFeedV3Rows("nope")).toEqual([]);
    expect(mapFeedV3Rows([{} as FeedV3Row])).toEqual([]);
  });
});

describe("isWithinRenderWindow", () => {
  test("mounts only indices within the radius of the active index", () => {
    expect(isWithinRenderWindow(5, 5)).toBe(true);
    expect(isWithinRenderWindow(5 - RENDER_WINDOW_RADIUS, 5)).toBe(true);
    expect(isWithinRenderWindow(5 + RENDER_WINDOW_RADIUS, 5)).toBe(true);
    expect(isWithinRenderWindow(5 + RENDER_WINDOW_RADIUS + 1, 5)).toBe(false);
    expect(isWithinRenderWindow(5 - RENDER_WINDOW_RADIUS - 1, 5)).toBe(false);
  });

  test("anchors to the top of the list when there is no active index yet", () => {
    expect(isWithinRenderWindow(0, -1)).toBe(true);
    expect(isWithinRenderWindow(RENDER_WINDOW_RADIUS, -1)).toBe(true);
    expect(isWithinRenderWindow(RENDER_WINDOW_RADIUS + 1, -1)).toBe(false);
  });

  test("honors a custom radius", () => {
    expect(isWithinRenderWindow(9, 5, 4)).toBe(true);
    expect(isWithinRenderWindow(10, 5, 4)).toBe(false);
  });
});
