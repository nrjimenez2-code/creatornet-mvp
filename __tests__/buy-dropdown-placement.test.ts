/**
 * lib/buyDropdownPlacement.ts — the Buy / Book dropdown must open upward when
 * there is no room below the button, or its lower rows (Book, and the
 * refund-policy link Stripe requires in the purchase flow) are clipped off the
 * bottom of the viewport and unreachable (any scroll closes the menu).
 * Mutation-checked.
 */
import {
  placeBuyDropdown,
  DROPDOWN_GAP,
  DROPDOWN_ESTIMATED_HEIGHT,
  DROPDOWN_MAX_WIDTH,
  DROPDOWN_EDGE_MARGIN,
} from "@/lib/buyDropdownPlacement";

const viewport = { width: 1440, height: 900 };

describe("placeBuyDropdown", () => {
  it("opens downward when there is room below", () => {
    const p = placeBuyDropdown({ top: 100, bottom: 140, left: 300 }, viewport);
    expect(p).toEqual({ left: 300, top: 140 + DROPDOWN_GAP });
  });

  it("opens upward when the button sits near the bottom edge (desktop 100dvh card)", () => {
    // Button ends 72px above the viewport bottom — less than the menu needs.
    const rect = { top: 900 - 72 - 40, bottom: 900 - 72, left: 300 };
    const p = placeBuyDropdown(rect, viewport);
    expect(p).toEqual({ left: 300, bottom: 900 - rect.top + DROPDOWN_GAP });
    expect("top" in p).toBe(false);
  });

  it("keeps opening downward when neither side has room (tiny viewport)", () => {
    const tiny = { width: 400, height: 200 };
    const p = placeBuyDropdown({ top: 90, bottom: 130, left: 10 }, tiny);
    expect(p).toEqual({ left: 10, top: 130 + DROPDOWN_GAP });
  });

  it("flips exactly at the estimated height threshold", () => {
    const bottomWithRoom = viewport.height - DROPDOWN_GAP - DROPDOWN_ESTIMATED_HEIGHT;
    expect("top" in placeBuyDropdown({ top: bottomWithRoom - 40, bottom: bottomWithRoom, left: 0 }, viewport)).toBe(true);
    expect("bottom" in placeBuyDropdown({ top: bottomWithRoom - 39, bottom: bottomWithRoom + 1, left: 0 }, viewport)).toBe(true);
  });

  it("clamps left to the viewport edges", () => {
    expect(placeBuyDropdown({ top: 10, bottom: 50, left: -20 }, viewport).left).toBe(DROPDOWN_EDGE_MARGIN);
    expect(placeBuyDropdown({ top: 10, bottom: 50, left: 1439 }, viewport).left).toBe(
      viewport.width - DROPDOWN_MAX_WIDTH - DROPDOWN_EDGE_MARGIN,
    );
  });
});
