import {
  rankDiscover,
  wilsonLower,
  type DiscoverCandidate,
  type DiscoverEvent,
} from "@/lib/discoverRanking";
import { createHmac } from "node:crypto";
import { verifySchedulingSignature } from "@/lib/schedulingWebhook";
const now = Date.parse("2026-09-12T00:00:00Z");
function post(
  id: string,
  creator = id,
  interests = ["Entrepreneurship"],
): DiscoverCandidate {
  return {
    id,
    creator_id: creator,
    created_at: new Date(now).toISOString(),
    interests,
  };
}
function exposure(post_id: string, actor = "viewer"): DiscoverEvent {
  return {
    post_id,
    actor,
    kind: "exposure",
    categories: [],
    topics: [],
    audience: "general",
    offer_type: "none",
    occurred_at: new Date(now).toISOString(),
  };
}
test("database summaries preserve ranking without downloading other viewers events", () => {
  const rows = [post("a"), post("b")];
  const events: DiscoverEvent[] = [];
  for (const id of ["a", "b"])
    for (let i = 0; i < 25; i++) events.push(exposure(id, "other" + i));
  for (let i = 0; i < 5; i++)
    events.push({ ...exposure("a", "other" + i), kind: "purchase" });
  for (let i = 0; i < 3; i++)
    events.push({ ...exposure("a", "other" + i), kind: "booking_scheduled" });
  for (let i = 0; i < 2; i++)
    events.push({ ...exposure("b", "other" + i), kind: "purchase" });
  const evidence = ["a", "b"].map((id) => ({
    post_id: id,
    audience: "",
    exposures: 25,
    sales: id === "a" ? 5 : 2,
    bookings: id === "a" ? 3 : 0,
    commercial: id === "a" ? 5 : 2,
    intents: 0,
    taps: 0,
    views: 0,
    last_exposure: new Date(now).toISOString(),
  }));
  const original = rankDiscover(
    rows,
    events,
    "viewer",
    ["Entrepreneurship"],
    [],
    now,
  );
  expect(
    rankDiscover(
      rows,
      [],
      "viewer",
      ["Entrepreneurship"],
      [],
      now,
      [],
      evidence,
    ),
  ).toEqual(original);
  expect(original[0]).toBe("a");
});

test("onboarding personalizes immediately and unseen inventory wins over repeats", () => {
  expect(
    rankDiscover(
      [post("health", "a", ["Health & Fitness"]), post("business")],
      [],
      "viewer",
      ["Entrepreneurship"],
      [],
      now,
    )[0],
  ).toBe("business");
  expect(
    rankDiscover(
      [post("a"), post("b")],
      [exposure("a")],
      "viewer",
      [],
      [],
      now,
    ),
  ).toEqual(["b", "a"]);
});
test("avoids consecutive creators and still returns all inventory when alternatives are exhausted", () => {
  const rows = [post("a", "one"), post("b", "one"), post("c", "two")];
  expect(rankDiscover(rows, [], "viewer", [], [], now)).toEqual([
    "a",
    "c",
    "b",
  ]);
});
test("not interested suppresses a post, then expires", () => {
  const negative = { ...exposure("a"), kind: "not_interested" };
  expect(
    rankDiscover([post("a"), post("b")], [negative], "viewer", [], [], now),
  ).toEqual(["b"]);
  expect(
    rankDiscover(
      [post("a")],
      [negative],
      "viewer",
      [],
      [],
      now + 31 * 86400000,
    ),
  ).toEqual(["a"]);
});
test("small-sample uncertainty does not crown one lucky sale", () => {
  expect(wilsonLower(1, 1)).toBeLessThan(wilsonLower(50, 100));
  const events = [
    exposure("old", "buyer"),
    { ...exposure("old", "buyer"), kind: "purchase" },
  ];
  const candidates = [
    post("new"),
    { ...post("old"), created_at: "2020-01-01" },
  ];
  expect(rankDiscover(candidates, events, "viewer", [], [], now)).toEqual(
    rankDiscover(
      candidates,
      events.filter((e) => e.kind !== "purchase"),
      "viewer",
      [],
      [],
      now,
    ),
  );
});
test("provider signature checks bind exact body and reject stale/future Calendly messages", () => {
  const raw = '{"event":"invitee.created"}',
    timestamp = now / 1000,
    secret = "fixture-secret";
  const signature = createHmac("sha256", secret)
    .update(timestamp + "." + raw)
    .digest("hex");
  const header = `t=${timestamp},v1=${signature}`;
  expect(verifySchedulingSignature("calendly", raw, header, secret, now)).toBe(
    true,
  );
  expect(
    verifySchedulingSignature("calendly", raw + " ", header, secret, now),
  ).toBe(false);
  expect(
    verifySchedulingSignature("calendly", raw, header, secret, now + 181000),
  ).toBe(false);
  expect(
    verifySchedulingSignature("calendly", raw, header, secret, now - 181000),
  ).toBe(false);
});

test("only a proven video gets a reserved related-audience trial", () => {
  const candidates = [
    ...Array.from({ length: 10 }, (_, i) => post("business" + i)),
    post("money", "financier", ["Money & Investing"]),
  ];
  const trials = Array.from({ length: 20 }, (_, i) =>
    exposure("money", "buyer" + i),
  );
  const sale = (i: number) => ({
    ...exposure("money", "buyer" + i),
    kind: "purchase",
  });
  const first = rankDiscover(
    candidates,
    [...trials, sale(0)],
    "viewer",
    ["Entrepreneurship"],
    [],
    now,
  );
  expect(first.indexOf("money")).toBe(10);
  const proven = rankDiscover(
    candidates,
    [...trials, sale(0), sale(1)],
    "viewer",
    ["Entrepreneurship"],
    [],
    now,
  );
  expect(proven.indexOf("money")).toBe(5);
});
test("migration priors remain useful but old preferences fade", () => {
  const candidates = [
    post("a-health", "a", ["Health & Fitness"]),
    post("z-business", "z"),
  ];
  const prior = [
    {
      category: "entrepreneurship",
      score: 100,
      updated_at: new Date(now).toISOString(),
    },
  ];
  expect(rankDiscover(candidates, [], "viewer", [], [], now, prior)[0]).toBe(
    "z-business",
  );
});
