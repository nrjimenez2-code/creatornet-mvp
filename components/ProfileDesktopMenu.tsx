"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import ProfileShareButton from "@/components/ProfileShareButton";

const itemClassName = "block w-full rounded-lg px-3 py-2 text-left text-sm text-white hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-2 focus-visible:outline-white transition";

export default function ProfileDesktopMenu({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openingIndex = useRef(0);
  const triggerPointer = useRef(false);

  useEffect(() => {
    if (!open) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    items?.[openingIndex.current === -1 ? items.length - 1 : 0]?.focus();

    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const dismissMobile = (event: MediaQueryListEvent) => {
      if (!event.matches) setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    desktop.addEventListener("change", dismissMobile);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      desktop.removeEventListener("change", dismissMobile);
    };
  }, [open]);

  function handleMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown": next = (index + 1) % items.length; break;
      case "ArrowUp": next = (index - 1 + items.length) % items.length; break;
      case "Home": next = 0; break;
      case "End": next = items.length - 1; break;
      case "Enter":
      case " ":
        if (index >= 0) {
          event.preventDefault();
          items[index].click();
        }
        return;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open profile menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="flex h-8 w-8 items-center justify-center rounded-md bg-transparent text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white transition"
        onPointerDown={() => { triggerPointer.current = true; }}
        onClick={() => {
          triggerPointer.current = false;
          openingIndex.current = 0;
          setOpen((value) => !value && window.matchMedia("(min-width: 1024px)").matches);
        }}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            openingIndex.current = event.key === "ArrowUp" ? -1 : 0;
            setOpen(window.matchMedia("(min-width: 1024px)").matches);
          }
        }}
      >
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Profile menu"
          className="absolute right-0 top-full z-50 mt-2 w-52 rounded-lg border border-white/10 bg-[#05060A] p-1.5 shadow-xl"
          onKeyDown={handleMenuKey}
          onBlur={(event) => {
            if (event.relatedTarget === triggerRef.current && triggerPointer.current) return;
            if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
          }}
        >
          <Link href="/profile/edit" role="menuitem" tabIndex={-1} className={itemClassName} onClick={() => setOpen(false)}>
            Edit profile
          </Link>
          <Link href={`/creators/${userId}/reviews`} role="menuitem" tabIndex={-1} className={itemClassName} onClick={() => setOpen(false)}>
            Reviews
          </Link>
          <ProfileShareButton appearance="menu-item" />
        </div>
      )}
    </div>
  );
}
