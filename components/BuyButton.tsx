"use client";

import { forwardRef } from "react";
import { ChevronRight, ShoppingCart } from "lucide-react";

type Props = {
  /** Optional price in cents — renders next to the label when > 0. */
  priceCents?: number | null;
  /** Whether the dropdown menu (parent-managed) is currently open. */
  expanded?: boolean;
  /** Click handler — parent toggles the dropdown. */
  onClick?: () => void;
  /** Label override; defaults to "Buy". */
  label?: string;
};

/** Shared sizing for both icons — unchanged from the previous inline SVGs. */
const ICON_CLASS = "h-3 w-3 md:h-3.5 md:w-3.5";

/**
 * The purple pill "Buy $X.XX ›" button shown on every video card.
 * Rendered once here — visual changes you make in this file apply everywhere
 * VideoCard is used (feed, profile modal, hashtag modal, search, etc.).
 *
 * Behaviour (dropdown open/close, checkout flow) stays in VideoCard because
 * it depends on per-card state (price lookup, menu position, etc.). The
 * trailing chevron rotates to point down while the dropdown is open.
 */
const BuyButton = forwardRef<HTMLButtonElement, Props>(function BuyButton(
  { priceCents, expanded = false, onClick, label = "Buy" },
  ref
) {
  const showPrice = typeof priceCents === "number" && priceCents > 0;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-haspopup="menu"
      aria-expanded={expanded}
      className="inline-flex items-center gap-1 px-1 sm:px-1 md:px-1.5 py-0.5 sm:py-0.5 md:py-1 lg:py-1.5 h-5 sm:h-auto max-sm:!h-7 max-sm:!min-h-3 max-sm:!py-0 max-sm:overflow-hidden rounded-full max-sm:!rounded-xl bg-[#4A35C7] text-white text-xs font-semibold leading-none hover:bg-[#3D2BA3] transition focus:outline-none focus:ring-2 focus:ring-[#B5BAC2]/60"
    >
      <ShoppingCart className={ICON_CLASS} strokeWidth={2} aria-hidden="true" />
      <span className="font-semibold leading-none">{label}</span>
      {showPrice && (
        <span className="font-semibold leading-none">
          ${(priceCents! / 100).toFixed(2)}
        </span>
      )}
      <ChevronRight
        className={`${ICON_CLASS} transition-transform ${expanded ? "rotate-90" : ""}`}
        strokeWidth={2}
        aria-hidden="true"
      />
    </button>
  );
});

export default BuyButton;
