import { naturalDesktopFeedFrameFits } from "@/lib/desktopFeedFrame";

test("source-shaped cards never have less visible area than the old tall card", () => {
  expect(naturalDesktopFeedFrameFits(1, 1024, 768)).toBe(false);
  expect(naturalDesktopFeedFrameFits(16 / 9, 1024, 768)).toBe(false);
  expect(naturalDesktopFeedFrameFits(1, 1440, 900)).toBe(true);
  expect(naturalDesktopFeedFrameFits(16 / 9, 1440, 900)).toBe(true);
  expect(naturalDesktopFeedFrameFits(9 / 16, 1440, 900)).toBe(false);
});
