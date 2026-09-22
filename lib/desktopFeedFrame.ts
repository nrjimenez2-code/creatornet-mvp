// The desktop dashboard leaves 240px for navigation and a 24px gap. The
// centered feed reserves the same amount on its right so it stays on screen.
export const DESKTOP_FEED_SIDE_CLEARANCE = 264;
export const ORIGINAL_DESKTOP_FEED_WIDTH = 420;

/** Use the source shape only when its visible area meets the old tall card. */
export function naturalDesktopFeedFrameFits(
  ratio: number,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  if (!Number.isFinite(ratio) || ratio < 1 || viewportWidth < 1024 || viewportHeight <= 0) return false;
  const availableWidth = viewportWidth - 2 * DESKTOP_FEED_SIDE_CLEARANCE;
  if (availableWidth <= 0) return false;
  const cardWidth = Math.min(ratio * viewportHeight, availableWidth);
  const cardHeight = cardWidth / ratio;
  return cardWidth * cardHeight >= ORIGINAL_DESKTOP_FEED_WIDTH * viewportHeight;
}
