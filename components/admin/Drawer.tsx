"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { IconX } from "@/components/admin/icons";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible label for the dialog. */
  title: string;
  children: ReactNode;
}

/**
 * Right-hand slide-over used for user / video detail views.
 * Esc or backdrop click closes; body scroll locks while open; focus moves to
 * the close button on open and the panel keeps focus contained via `inert`
 * being unnecessary at this scale (single overlay, demo app).
 */
export function Drawer({ open, onClose, title, children }: DrawerProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Read onClose through a ref so the focus/scroll-lock effect below depends
  // on `open` alone — call sites pass inline arrows, and re-running the effect
  // on every parent re-render would yank focus back to the close button after
  // each action taken inside the drawer.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCloseRef.current();
    }

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-[#1a1030]/35 backdrop-blur-[2px] motion-safe:animate-[backdropIn_0.2s_ease-out]"
      />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto bg-white shadow-[-12px_0_40px_rgba(24,16,44,0.18)] motion-safe:animate-[drawerIn_0.28s_cubic-bezier(0.16,1,0.3,1)] max-sm:max-w-full">
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="absolute top-4 right-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/25 text-white backdrop-blur transition hover:bg-white/40 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
        >
          <IconX size={15} />
        </button>
        {children}
      </div>
    </div>
  );
}
