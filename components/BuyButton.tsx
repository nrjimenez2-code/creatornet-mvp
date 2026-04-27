"use client";

import { forwardRef } from "react";

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

/**
 * The white pill "Buy $X.XX ▾" button shown on every video card.
 * Rendered once here — visual changes you make in this file apply everywhere
 * VideoCard is used (feed, profile modal, hashtag modal, search, etc.).
 *
 * Behaviour (dropdown open/close, checkout flow) stays in VideoCard because
 * it depends on per-card state (price lookup, menu position, etc.).
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
      className="inline-flex items-center gap-1 px-1 sm:px-1 md:px-1.5 py-0.5 sm:py-0.5 md:py-1 lg:py-1.5 h-5 sm:h-auto max-sm:!h-7 max-sm:!min-h-3 max-sm:!py-0 max-sm:overflow-hidden rounded-full max-sm:!rounded-xl bg-gradient-to-b from-[#B5BAC2]/45 to-[#B5BAC2]/30 backdrop-blur-sm border border-white/25 shadow-[inset_0_1px_1px_rgba(255,255,255,0.45)] text-black text-xs font-semibold leading-none hover:from-[#B5BAC2]/65 hover:to-[#B5BAC2]/50 transition focus:outline-none focus:ring-2 focus:ring-[#B5BAC2]/60"
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3 md:h-3.5 md:w-3.5" fill="currentColor" aria-hidden="true">
        <path d="M7 4h14l-1.5 9H8.6L7 4zM3 4h2l3 12h10v2H7a2 2 0 0 1-2-1.5L3 4zM9 21a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3zM17 21a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3z" />
      </svg>
      <span className="font-semibold leading-none">{label}</span>
      {showPrice && (
        <span className="font-semibold leading-none">
          ${(priceCents! / 100).toFixed(2)}
        </span>
      )}
      <svg viewBox="0 0 24 24" className="h-3 w-3 md:h-3.5 md:w-3.5" fill="currentColor" aria-hidden="true">
        <path d="M7 10l5 5 5-5z" />
      </svg>
    </button>
  );
});

export default BuyButton;
