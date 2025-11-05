// components/PostComposerModal.tsx
"use client";

import React, { useEffect, useRef, useState } from "react";
import PostComposer from "./PostComposer";

type PostComposerModalProps = {
  onPosted?: () => void;  // parent can refresh feed after post
  onClose?: () => void;   // parent notified when modal closes
};

export default function PostComposerModal({ onPosted, onClose }: PostComposerModalProps) {
  const [open, setOpen] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);

  const handleClose = () => {
    setOpen(false);
    onClose?.();
  };

  // Close on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Lock background scroll
  useEffect(() => {
    if (!open) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // backdrop click to close
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-[min(720px,95vw)] max-h-[92vh] overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">New post</h3>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-2 text-gray-600 hover:bg-gray-100"
            aria-label="Close composer"
          >
            ✕
          </button>
        </div>

        <div className="mt-3">
          <PostComposer
            onPosted={() => {
              handleClose();
              onPosted?.();
            }}
          />
        </div>
      </div>
    </div>
  );
}
