// lib/buyDropdownPlacement.ts
//
// Where the Buy / Book dropdown opens relative to its button. On desktop the
// video card fills the viewport and the button sits ~70px above the bottom
// edge; a menu that always opens downward runs off-screen there, and because
// any scroll closes the menu, the clipped rows (Book, the refund-policy link
// Stripe requires in the purchase flow) are simply unreachable. Open upward
// when there is not enough room below and enough above.

export const DROPDOWN_MAX_WIDTH = 200;
export const DROPDOWN_GAP = 8;
export const DROPDOWN_EDGE_MARGIN = 8;
/** Generous upper bound: Pay in full + Book + divider + policy row + borders. */
export const DROPDOWN_ESTIMATED_HEIGHT = 140;

export type ButtonRect = { top: number; bottom: number; left: number };
export type Viewport = { width: number; height: number };
export type DropdownPlacement =
  | { left: number; top: number }
  | { left: number; bottom: number };

export function placeBuyDropdown(rect: ButtonRect, viewport: Viewport): DropdownPlacement {
  const left = Math.max(
    DROPDOWN_EDGE_MARGIN,
    Math.min(rect.left, viewport.width - DROPDOWN_MAX_WIDTH - DROPDOWN_EDGE_MARGIN),
  );
  const roomBelow = viewport.height - rect.bottom - DROPDOWN_GAP;
  const roomAbove = rect.top - DROPDOWN_GAP;
  if (roomBelow >= DROPDOWN_ESTIMATED_HEIGHT || roomAbove < DROPDOWN_ESTIMATED_HEIGHT) {
    return { left, top: rect.bottom + DROPDOWN_GAP };
  }
  // Anchor to the viewport bottom so the menu grows upward from the button.
  return { left, bottom: viewport.height - rect.top + DROPDOWN_GAP };
}
