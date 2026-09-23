import { avatarCropLayout } from "@/lib/avatarCrop";

test("a tall photo uses a centered square without stretching", () => {
  const crop = avatarCropLayout(924, 1885, 256, 1, { x: 462, y: 942.5 });
  expect(crop.sourceSize).toBeCloseTo(924);
  expect(crop.left).toBeCloseTo(0);
  expect(crop.top).toBeLessThan(0);
  expect(crop.center).toEqual({ x: 462, y: 942.5 });
});

test("dragging and zooming stay within the original photo", () => {
  const crop = avatarCropLayout(1600, 900, 256, 2, { x: -100, y: 2000 });
  expect(crop.sourceSize).toBeCloseTo(450);
  expect(crop.center).toEqual({ x: 225, y: 675 });
  expect(crop.center.x - crop.sourceSize / 2).toBeGreaterThanOrEqual(0);
  expect(crop.center.y + crop.sourceSize / 2).toBeLessThanOrEqual(900);
});

test("a square photo fills the frame without a crop at normal zoom", () => {
  const crop = avatarCropLayout(700, 700, 256, 1, { x: 350, y: 350 });
  expect(crop.sourceSize).toBeCloseTo(700);
  expect(crop.left).toBeCloseTo(0);
  expect(crop.top).toBeCloseTo(0);
});
