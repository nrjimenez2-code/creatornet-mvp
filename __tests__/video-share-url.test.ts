import { videoShareUrl } from "@/lib/videoShareUrl";

test("a packaged iPhone share uses the configured HTTPS website, not capacitor localhost", () => {
  expect(videoShareUrl("video-1", "capacitor://localhost", "https://staging.example.com"))
    .toBe("https://staging.example.com/dashboard?postId=video-1");
  expect(() => videoShareUrl("video-1", "capacitor://localhost", "http://localhost:3000"))
    .toThrow("public website origin");
});

test("a website share remains on that website's current host", () => {
  expect(videoShareUrl("video-1", "https://preview.example.com", "https://www.creatornet.net"))
    .toBe("https://preview.example.com/dashboard?postId=video-1");
});
