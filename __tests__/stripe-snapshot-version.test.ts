import { isSupportedStripeSnapshotVersion } from "../lib/stripeSnapshotVersion";

test.each(["2025-09-30.clover", "2025-10-29.clover"])("reviewed %s snapshots can accompany pinned October resource reads", version => {
  expect(isSupportedStripeSnapshotVersion(version, "2025-10-29.clover")).toBe(true);
});

test.each([null, undefined, "", "2025-10-29", "2025-09-30.preview", "2025-08-27.basil", "2025-11-17.clover",
  "2026-07-29.dahlia", "2025-09-30.clover ", {}, ["2025-09-30.clover"]])("unknown snapshot representation %p stays rejected", version => {
  expect(isSupportedStripeSnapshotVersion(version, "2025-10-29.clover")).toBe(false);
});

test.each([null, undefined, "2025-09-30.clover", "2025-11-17.clover", "2026-07-29.dahlia"])("snapshot compatibility cannot change request version to %p", version => {
  expect(isSupportedStripeSnapshotVersion("2025-09-30.clover", version)).toBe(false);
  expect(isSupportedStripeSnapshotVersion("2025-10-29.clover", version)).toBe(false);
});
