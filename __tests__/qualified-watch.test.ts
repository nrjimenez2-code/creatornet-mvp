import { QualifiedWatch, qualifiedThreshold } from "@/lib/qualifiedWatch";
test("autoplay starts with zero and seeking cannot complete a video", () => {
  const watch = new QualifiedWatch();
  expect(watch.sample(0, 0, true)).toBe(0);
  expect(watch.sample(1000, 1, true)).toBe(1);
  expect(watch.sample(1100, 95, true)).toBe(1);
  expect(watch.sample(2100, 96, true)).toBe(2);
});
test("background, pauses, buffering and backward seeks earn no time", () => {
  const watch = new QualifiedWatch();
  watch.sample(0, 0, true);
  watch.sample(1000, 1, true);
  watch.sample(2000, 2, false);
  watch.sample(3000, 3, true);
  watch.sample(4000, 3, true);
  watch.sample(5000, 0, true);
  watch.sample(65000, 60, true);
  expect(watch.seconds).toBe(1);
});
test("speed does not multiply actual watch time and short clips can qualify", () => {
  const watch = new QualifiedWatch();
  watch.sample(0, 0, true, 2);
  watch.sample(1000, 2, true, 2);
  expect(watch.seconds).toBe(1);
  expect(qualifiedThreshold(2)).toBe(1.8);
  expect(qualifiedThreshold(60)).toBe(5);
});
