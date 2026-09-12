import { feedMediaUrl, feedPosterUrl } from "../lib/feedMedia";
import manifest from "../lib/feedMediaManifest.json";

describe("public feed CDN routing", () => {
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
