// components/PostComposerModal.tsx
"use client";

import React, { useState } from "react";
import PostComposer from "./PostComposer";

type PostComposerModalProps = {
  onPosted?: () => void;  // optional: parent can refresh feed after post
  onClose?: () => void;   // optional: let parent know when modal closes
};

export default function PostComposerModal({
  onPosted,
  onClose,
}: PostComposerModalProps) {
  // Open by default because parent renders the modal on demand
  const [open, setOpen] = useState(true);

  const handleClose = () => {
    setOpen(false);
    onClose?.();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-[min(720px,95vw)] max-h-[92vh] overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">New post</h3>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-2 text-gray-600 hover:bg-gray-100"
            aria-label="Close"
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
