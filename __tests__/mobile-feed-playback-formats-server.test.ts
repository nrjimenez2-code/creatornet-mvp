import PlaybackFormatsPage, { dynamic, metadata } from "@/app/playback-formats/page";

jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
jest.mock("@/app/playback-lab/PlaybackLab", () => ({ __esModule: true, default: () => null }));

const originalEnvironment = process.env;
afterEach(() => { process.env = originalEnvironment; });

const versions = [
  "sha256:1eb772bf1adb09390a6b6993ed85b44f68247d91a45b550523f900f55736af4a",
  "sha256:d2c530f03d2bde9217da9f830ff964141be5843a7ba5afee9332fb708bdf49ee",
];
const sources = {
  original: [
    "https://media.creatornet.net/videos/7cb02077-bcba-4c29-8f3c-f1584d1ed961/1790458342012.mp4",
    "https://media.creatornet.net/videos/767658b6-7b2a-4cc4-91b4-6a0f78073a8e/1789953087942.mp4",
  ],
  mp4: [
    "https://media.creatornet.net/feed-auto/1eb772bf1adb09390a6b6993ed85b44f68247d91a45b550523f900f55736af4a.mp4",
    "https://media.creatornet.net/feed-auto/d2c530f03d2bde9217da9f830ff964141be5843a7ba5afee9332fb708bdf49ee.mp4",
  ],
  hls: [
    "https://customer-emx4uma3h4ofg314.cloudflarestream.com/055c52cd11ab6482f3c4fdbc9336fb10/manifest/video.m3u8",
    "https://customer-emx4uma3h4ofg314.cloudflarestream.com/50eed272e3d4283f18f4b67a03e04ae7/manifest/video.m3u8",
  ],
};

test.each([undefined, "production", "development", "Preview", ""])("format page is unavailable in %s environment", async environment => {
  process.env = { ...originalEnvironment, VERCEL_ENV: environment };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "original" }) })).rejects.toThrow("NOT_FOUND");
});

test.each(["", "MP4", "single", "https://example.test/a.mp4", ["original", "hls"]].map(format => ({ format })))("rejects unsupported format $format", async ({ format }) => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve({ format }) })).rejects.toThrow("NOT_FOUND");
});

test.each([undefined, "original", "mp4", "hls"] as const)("format %s pins audited sources, steady controller and exact build", async requested => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "exact-format-build" };
  const format = requested ?? "hls";
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve({ format: requested }) });
  expect(dynamic).toBe("force-dynamic");
  expect(metadata.robots).toEqual({ index: false, follow: false });
  expect(metadata.referrer).toBe("no-referrer");
  expect(result.key).toBe(`formats:${format}`);
  expect(result.props.controllerMode).toBe("steady");
  expect(result.props.sourceFormat).toBe(format);
  expect(result.props.buildCommit).toBe("exact-format-build");
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(sources[format]);
  expect(result.props.fixtures.map((fixture: { label: string }) => fixture.label)).toEqual(["Carlos", "Noah"]);
  expect(result.props.fixtures.map((fixture: { id: string }) => fixture.id)).toEqual([`preview-format-carlos-${format}`, `preview-format-noah-${format}`]);
  expect(result.props.fixtures.map((fixture: { contentVersion: string }) => fixture.contentVersion)).toEqual(versions.map(version => `${version}:${format}`));
});

test("arbitrary source and controller parameters cannot replace the fixed comparison", async () => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  const params = { format: "mp4", src: "https://example.test/private.mp4", mode: "serial" };
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve(params) });
  expect(result.props.controllerMode).toBe("steady");
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(sources.mp4);
});
