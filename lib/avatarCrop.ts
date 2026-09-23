export type CropCenter = { x: number; y: number };

export function avatarCropLayout(
  imageWidth: number,
  imageHeight: number,
  frameSize: number,
  zoom: number,
  center: CropCenter,
) {
  const scale = Math.max(frameSize / imageWidth, frameSize / imageHeight) * zoom;
  const halfVisible = frameSize / (2 * scale);
  const x = Math.min(imageWidth - halfVisible, Math.max(halfVisible, center.x));
  const y = Math.min(imageHeight - halfVisible, Math.max(halfVisible, center.y));

  return {
    scale,
    center: { x, y },
    sourceSize: frameSize / scale,
    left: frameSize / 2 - x * scale,
    top: frameSize / 2 - y * scale,
  };
}
