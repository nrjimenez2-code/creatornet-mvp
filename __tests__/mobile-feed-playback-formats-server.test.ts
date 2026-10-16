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

test("original Noah startup control pins only Noah's audited source and isolates rendition history", async () => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "startup-source-build" };
  const params = { format: "mp4", transfer: "prepared-preload-audio", noahSource: "original", feedReadout: "0" };
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve(params) });
  expect(result.key).toBe("formats:mp4:prepared-preload-audio:noah-original");
  expect(result.props).toEqual(expect.objectContaining({ originalNoahStartup: true, controllerMode: "prepared-preload-audio",
    deferPreparedRetirement: false, directMainTransfer: false, liveReadout: false, buildCommit: "startup-source-build" }));
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual([sources.mp4[0], sources.original[1]]);
  expect(result.props.fixtures.map((fixture: { id: string }) => fixture.id)).toEqual(["preview-format-carlos-mp4", "preview-format-noah-original"]);
  expect(result.props.fixtures.map((fixture: { contentVersion: string }) => fixture.contentVersion)).toEqual([`${versions[0]}:mp4`, `${versions[1]}:original`]);
  const baseline = await PlaybackFormatsPage({ searchParams: Promise.resolve({ ...params, noahSource: undefined }) });
  expect(baseline.props.originalNoahStartup).toBe(false);
  expect(baseline.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(sources.mp4);
  process.env = { ...originalEnvironment, VERCEL_ENV: "production" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
});

test.each([
  { format: "mp4", transfer: "prepared-preload-audio", noahSource: "processed" },
  { format: "mp4", transfer: "prepared-preload-audio", noahSource: ["original"] },
  { format: "mp4", transfer: "prepared-preload-audio", noahSource: "https://example.test/a.mp4" },
  { format: "mp4", transfer: "prepared-preload-audio", noahSource: "original", retire: "after-startup" },
  { format: "mp4", transfer: "prepared-audio", noahSource: "original" },
  { format: "mp4", transfer: "parked", noahSource: "original" },
  { format: "original", transfer: "prepared-preload-audio", noahSource: "original" },
  { format: "hls", transfer: "parked", noahSource: "original" },
])("rejects startup source selection outside its one-source control: %j", async params => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
});

test.each([
  { format: "mp4", transfer: "prepared-preload-audio", feedReadout: "0", live: false },
  { format: "mp4", transfer: "prepared-preload-audio", feedReadout: undefined, live: true },
  { format: "mp4", transfer: "prepared-preload-audio", feedReadout: "1", live: true },
  { format: "mp4", transfer: "prepared-preload-audio", feedReadout: ["0"], live: true },
  { format: "mp4", transfer: "prepared-audio", feedReadout: "0", live: true },
  { format: "hls", transfer: "parked", feedReadout: "0", live: true },
])("capture-only readout is an exact opt-in in the paused-preload MP4 Preview: %j", async ({ live, ...params }) => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve(params) });
  expect(result.props.liveReadout).toBe(live);
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(sources[params.format as keyof typeof sources]);
  process.env = { ...originalEnvironment, VERCEL_ENV: "production" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
});

test.each([undefined, "production", "development", "Preview", ""])("format page is unavailable in %s environment", async environment => {
  process.env = { ...originalEnvironment, VERCEL_ENV: environment };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "original" }) })).rejects.toThrow("NOT_FOUND");
});

test("deferred retirement is an exact Preview paused-preload MP4 opt-in with unchanged sources and readout", async () => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "retirement-build" };
  const params = { format: "mp4", transfer: "prepared-preload-audio", retire: "after-startup", feedReadout: "0" };
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve(params) });
  expect(result.key).toBe("formats:mp4:prepared-preload-audio:retire-after-startup");
  expect(result.props).toEqual(expect.objectContaining({ controllerMode: "prepared-preload-audio", deferPreparedRetirement: true,
    liveReadout: false, buildCommit: "retirement-build" }));
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(sources.mp4);
  const baseline = await PlaybackFormatsPage({ searchParams: Promise.resolve({ ...params, retire: undefined }) });
  expect(baseline.props.deferPreparedRetirement).toBe(false);
  process.env = { ...originalEnvironment, VERCEL_ENV: "production" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
});

test.each([
  { format: "mp4", transfer: "prepared-preload-audio", retire: "immediate" },
  { format: "mp4", transfer: "prepared-preload-audio", retire: ["after-startup"] },
  { format: "mp4", transfer: "prepared-audio", retire: "after-startup" },
  { format: "mp4", transfer: "parked", retire: "after-startup" },
  { format: "hls", transfer: "prepared-preload-audio", retire: "after-startup" },
  { format: "original", transfer: "prepared-preload-audio", retire: "after-startup" },
])("rejects deferred-retirement selection outside its fixed control: %j", async params => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
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

test("direct transfer is an explicit Preview-only steady MP4 control with the same sources", async () => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "transfer-build" };
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "mp4", transfer: "direct" }) });
  expect(result.key).toBe("formats:mp4:direct");
  expect(result.props).toEqual(expect.objectContaining({ controllerMode: "steady", sourceFormat: "mp4", directMainTransfer: true, buildCommit: "transfer-build" }));
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(sources.mp4);
  process.env = { ...originalEnvironment, VERCEL_ENV: "production" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "mp4", transfer: "direct" }) })).rejects.toThrow("NOT_FOUND");
});

test.each([
  { format: "mp4", transfer: "DIRECT" }, { format: "mp4", transfer: "" },
  { format: "mp4", transfer: ["direct", "parked"] },
  { format: "original", transfer: "direct" }, { format: "hls", transfer: "direct" },
  { transfer: "direct" },
])("rejects unsupported transfer selection %j", async params => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve(params) })).rejects.toThrow("NOT_FOUND");
});

test.each([undefined, "parked"])("transfer %s preserves the original format route", async transfer => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "mp4", transfer }) });
  expect(result.key).toBe("formats:mp4");
  expect(result.props.directMainTransfer).toBe(false);
});

test("prepared transfer opts in to the sole prepared player only for the closed Preview MP4 pair", async () => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "prepared-build" };
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "mp4", transfer: "prepared" }) });
  expect(result.key).toBe("formats:mp4:prepared"); expect(result.props.controllerMode).toBe("prepared");
  expect(result.props.directMainTransfer).toBe(false); expect(result.props.buildCommit).toBe("prepared-build");
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(sources.mp4);
});

test.each([undefined, "hls", "original"])("prepared transfer rejects %s sources", async format => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve({ format, transfer: "prepared" }) })).rejects.toThrow("NOT_FOUND");
});

test("prepared transfer is unavailable in Production", async () => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "production" };
  await expect(PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "mp4", transfer: "prepared" }) })).rejects.toThrow("NOT_FOUND");
});

test.each(["prepared-audio", "prepared-inplace-audio", "prepared-preload-audio"] as const)("%s is a separate exact-build Preview MP4 selector with unchanged fixtures", async transfer => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "audio-control-build" };
  const result = await PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "mp4", transfer }) });
  expect(result.key).toBe(`formats:mp4:${transfer}`);
  expect(result.props).toEqual(expect.objectContaining({ controllerMode: transfer, buildCommit: "audio-control-build", directMainTransfer: false }));
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(sources.mp4);
});

describe.each(["prepared-audio", "prepared-inplace-audio", "prepared-preload-audio"] as const)("%s restrictions", transfer => {
  test.each([undefined, "hls", "original"])("rejects %s sources", async format => {
    process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
    await expect(PlaybackFormatsPage({ searchParams: Promise.resolve({ format, transfer }) })).rejects.toThrow("NOT_FOUND");
  });

  test.each([undefined, "production", "development", "Preview"])("rejects %s environment", async environment => {
    process.env = { ...originalEnvironment, VERCEL_ENV: environment };
    await expect(PlaybackFormatsPage({ searchParams: Promise.resolve({ format: "mp4", transfer }) })).rejects.toThrow("NOT_FOUND");
  });
});
