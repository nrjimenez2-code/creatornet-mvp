// components/PostComposerModal.tsx
"use client";

import React, { useEffect, useRef, useState } from "react";
import PostComposer from "./PostComposer";

type PostComposerModalProps = {
  /** Called after a post is successfully created (parent can refresh feed). */
  onPosted?: () => void;
  /** Called whenever the modal closes (ESC, backdrop, or X). */
  onClose?: () => void;
};

export default function PostComposerModal({
  onPosted,
  onClose,
}: PostComposerModalProps) {
  const [open, setOpen] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = () => {
    if (!open) return;
    setOpen(false);
    onClose?.();
  };

  // Close on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Lock background scroll when open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Basic focus management: focus the dialog on mount
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Create a new post"
      onMouseDown={(e) => {
        // backdrop click to close (only if clicking the backdrop itself)
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-[min(720px,95vw)] max-h-[92vh] overflow-y-auto rounded-2xl bg-[#060606] p-5 shadow-2xl outline-none border border-white/10 text-white"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold tracking-wide">New post</h3>
          <button
            type="button"
            onClick={close}
            className="rounded-full p-2 text-white/80 hover:bg-white/10 transition"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mt-4">
          <PostComposer
            onPosted={() => {
              close();
              onPosted?.();
            }}
          />
        </div>
      </div>
    </div>
  );
}
