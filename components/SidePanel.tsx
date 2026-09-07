"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Generic accessible side panel (right-side sheet on desktop, full-screen on
 * mobile). The first shared dialog primitive in the app with a real focus
 * trap — the older drawers each hand-roll Esc + scroll lock only.
 *
 * Contract:
 *  - role="dialog" + aria-modal + aria-labelledby (the title)
 *  - Esc and backdrop click call onClose
 *  - body scroll is locked while open; content scrolls inside the panel
 *  - focus moves INTO the panel on open and RETURNS to `returnFocusRef`
 *    (or whatever was focused before) on close
 *  - Tab / Shift+Tab wrap inside the panel
 *  - rendered through a portal on document.body: an ancestor with a
 *    transform/translate (the profile header uses md:translate-y-8) would
 *    otherwise become the containing block for `position: fixed` and clip
 *    the panel to that box instead of the viewport
 */
type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** The element that opened the panel; focus goes back here on close. */
  returnFocusRef?: RefObject<HTMLElement | null>;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export default function SidePanel({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  returnFocusRef,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Latest onClose without re-running the open effect when the parent
  // passes a new function identity each render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    // Captured at open time: the trigger that opened us is where focus
    // returns, even if the ref is reassigned before close.
    const returnTarget =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      returnTarget?.focus();
    };
  }, [open, returnFocusRef]);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;

    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const isInside = active instanceof Node && panel.contains(active);

    if (event.shiftKey) {
      if (!isInside || active === first || active === panel) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (!isInside || active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[120]">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={trapTab}
        className="absolute inset-0 flex w-full flex-col bg-[#0E0E10] text-white shadow-2xl outline-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-w-md sm:border-l sm:border-white/10 animate-[slideInRight_200ms_ease-out] motion-reduce:animate-none"
      >
        <header className="flex items-start justify-between gap-4 px-5 pb-4 pt-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-2xl font-semibold">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm text-white/60">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-5">{children}</div>

        {footer ? (
          <footer className="border-t border-white/10 px-5 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
