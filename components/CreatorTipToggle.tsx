"use client";

import { useState } from "react";

export default function CreatorTipToggle({ postId, initialEnabled, onChange }: {
  postId: string; initialEnabled: boolean; onChange?: (enabled: boolean) => void;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (saving) return;
    const next = !enabled;
    setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(postId)}/tips`, {
        method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Tip setting could not be updated.");
      setEnabled(next); onChange?.(next);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Tip setting could not be updated."); }
    finally { setSaving(false); }
  };
  return <div className="rounded-xl border border-white/15 bg-black/80 p-2 text-xs text-white shadow-xl backdrop-blur">
    <button type="button" disabled={saving} onClick={() => void toggle()} className="rounded-full bg-[#655BFF] px-4 py-2 font-semibold disabled:opacity-50">
      {saving ? "Saving…" : enabled ? "Disable tips" : "Enable tips"}
    </button>
    {enabled && <p className="mt-2 max-w-56 text-white/60">Completed tips remain in payment history and Earnings.</p>}
    {error && <p role="alert" className="mt-2 max-w-56 text-red-300">{error}</p>}
  </div>;
}
