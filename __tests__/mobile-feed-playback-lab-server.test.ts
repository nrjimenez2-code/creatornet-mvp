import PlaybackLabPage, { dynamic, metadata } from "@/app/playback-lab/page";
import manifest from "@/lib/feedAdaptiveManifest.json";

jest.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
jest.mock("@/app/playback-lab/PlaybackLab", () => ({ __esModule: true, default: () => null }));

const originalEnvironment = process.env;
afterEach(() => { process.env = originalEnvironment; });

test.each([undefined, "production", "development", "Preview", ""])("lab is unavailable in %s deployment context", async environment => {
  process.env = { ...originalEnvironment, VERCEL_ENV: environment };
  await expect(PlaybackLabPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NOT_FOUND");
});

test.each(["", "other", "https://example.test/video.m3u8", ["current", "rate"]].map(mode => ({ mode })))("rejects unsupported comparison mode $mode", async ({ mode }) => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview" };
  await expect(PlaybackLabPage({ searchParams: Promise.resolve({ mode }) })).rejects.toThrow("NOT_FOUND");
});

test.each([undefined, "current", "rate", "prearmed"])("Preview mode %s uses only fixed HLS assets and exact build identity", async mode => {
  process.env = { ...originalEnvironment, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_SHA: "exact-test-commit" };
  const result = await PlaybackLabPage({ searchParams: Promise.resolve({ mode }) });
  expect(dynamic).toBe("force-dynamic");
  expect(metadata.robots).toEqual({ index: false, follow: false });
  expect(result.props.controllerMode).toBe(mode ?? "current");
  expect(result.props.buildCommit).toBe("exact-test-commit");
  expect(result.props.fixtures.map((fixture: { src: string }) => fixture.src)).toEqual(Object.values(manifest));
  expect(result.props.fixtures).toHaveLength(3);
});
