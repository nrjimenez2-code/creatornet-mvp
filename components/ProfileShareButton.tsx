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
        className="flex h-8 w-8 items-center justify-center rounded-md bg-[#1A1F22] text-white hover:bg-[#232833] transition"
        aria-label={copied ? "Link copied" : "Share profile"}
      >
        <img
          src="/share.png"
          alt="Share"
          className="w-5 h-5 object-contain"
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
