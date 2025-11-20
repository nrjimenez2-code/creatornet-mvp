"use client";

import { useState } from "react";

export default function ProfileShareButton() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy profile link", err);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleCopy}
        className="rounded-full p-2.5 text-white hover:bg-white/10 transition"
        aria-label={copied ? "Link copied" : "Share profile"}
      >
        <img
          src="/image.png"
          alt="Share"
          className="w-6 h-6 object-contain rounded-lg"
        />
      </button>
      {copied && (
        <div className="absolute top-full right-0 mt-2 px-3 py-1.5 bg-black/90 text-white text-xs rounded-md whitespace-nowrap border border-white/20 z-50">
          Profile link copied
        </div>
      )}
    </div>
  );
}
