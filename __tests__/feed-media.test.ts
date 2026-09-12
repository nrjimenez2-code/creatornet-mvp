import { feedMediaUrl, feedPosterUrl, feedAdaptiveUrl } from "../lib/feedMedia";
import manifest from "../lib/feedMediaManifest.json";

describe("public feed CDN routing", () => {
  it("selects only approved adaptive copies, preserving private and unrelated URLs", () => {
    const original = "https://pub-91a8d994910d498d90b109487939e1db.r2.dev/videos/073e7bcb-5986-49cc-8be9-8567c6494562/1788481864376.mov";
    expect(feedAdaptiveUrl(original)).toContain("/c8bd16d36f015db9c6b1333dd711f831/manifest/video.m3u8");
    expect(feedAdaptiveUrl(feedMediaUrl(original))).toBe(feedAdaptiveUrl(original));
    for (const url of [undefined, original + "?token=private", "https://example.com/videos/file.mp4", "https://media.creatornet.net/videos/new.mp4"])
      expect(feedAdaptiveUrl(url)).toBeUndefined();
  });
  it("routes public thumbnails but preserves signed and third-party posters", () => {
    expect(feedPosterUrl("https://pub-91a8d994910d498d90b109487939e1db.r2.dev/thumbnails/a.jpg")).toBe("https://media.creatornet.net/thumbnails/a.jpg");
    for (const source of ["https://example.com/thumbnails/a.jpg", "https://media.creatornet.net/thumbnails/a.jpg?signature=private", "/poster.jpg"])
      expect(feedPosterUrl(source)).toBe(source);
    expect(feedPosterUrl(null)).toBeUndefined();
  });
  const origin = "https://pub-91a8d994910d498d90b109487939e1db.r2.dev";
  it("routes future public uploads through the CDN", () => {
    expect(feedMediaUrl(origin + "/videos/new-user/new.mp4")).toBe("https://media.creatornet.net/auto/videos/new-user/new.mp4");
  });
  it.each([
    "https://project.supabase.co/storage/v1/object/sign/premium/video.mp4?token=secret",
    origin + "/private/file.mp4",
    origin + "/videos/file.mp4?signature=abc",
    origin + ".evil.example/videos/file.mp4",
    "https://example.com/videos/file.mp4",
    "/video.mp4",
  ])("preserves unrelated or signed URL %s", (url) => {
    expect(feedMediaUrl(url)).toBe(url);
  });
  it("preserves absent media", () => expect(feedMediaUrl(undefined)).toBeUndefined());
  it("selects published optimized copies on both old and new public origins", () => {
    const entries = Object.entries(manifest);
    expect(entries.length).toBeGreaterThan(0);
    for (const [source, optimized] of entries) {
      expect(source).toMatch(/^\/videos\//);
      expect(optimized).toMatch(/^\/feed-v1\/[a-f0-9]{64}\.mp4$/);
      expect(feedMediaUrl(origin + source)).toBe("https://media.creatornet.net" + optimized);
      expect(feedMediaUrl("https://media.creatornet.net" + source)).toBe("https://media.creatornet.net" + optimized);
    }
  });
});
