import { verifiedVideoDuration } from "@/lib/discoverMedia";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});
test("only processor metadata for the exact allowlisted source can award completion", async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        key: "videos/test.mp4",
        etag: "source",
        durationSeconds: 12,
      }),
    });
  global.fetch = fetcher;
  expect(
    await verifiedVideoDuration("https://media.creatornet.net/videos/test.mp4"),
  ).toBe(12);
  expect(fetcher).toHaveBeenCalledWith(
    "https://media.creatornet.net/auto/metadata/videos/test.mp4",
    expect.objectContaining({ redirect: "error" }),
  );
  for (const raw of [
    "https://evil.test/videos/test.mp4",
    "https://media.creatornet.net/premium/test.mp4",
    "https://media.creatornet.net/videos/test.mp4?duration=1",
  ])
    expect(await verifiedVideoDuration(raw)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      key: "videos/other.mp4",
      etag: "source",
      durationSeconds: 1,
    }),
  });
  expect(
    await verifiedVideoDuration("https://media.creatornet.net/videos/test.mp4"),
  ).toBeNull();
  fetcher.mockRejectedValue(new Error("not available"));
  expect(
    await verifiedVideoDuration("https://media.creatornet.net/videos/test.mp4"),
  ).toBeNull();
});
