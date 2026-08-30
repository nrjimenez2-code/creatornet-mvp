"use client";

import { useState } from "react";

export default function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFailed(true);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-xl border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 transition-colors"
    >
      {copied ? "Copied!" : failed ? "Copy failed — select it above" : "Copy link"}
    </button>
  );
}
