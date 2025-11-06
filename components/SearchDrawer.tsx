// components/SearchDrawer.tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  open: boolean;
  onClose: () => void;
};

const CHIPS = ["Business","Fitness","Marketing","AI","Mindset","UGC","Design","Productivity"];

const SUGGESTED = [
  "Dropshipping","Digital Marketing","SEO","High-Ticket Sales","Day Trading","Affiliate Marketing",
];

const TRENDING = [
  "AI Automation","SMMA (Social Media Marketing Agency)","E-Commerce",
  "Content Creation","Personal Branding","Digital Marketing",
];

export default function SearchDrawer({ open, onClose }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<string[]>([]);

  // simple recent store in localStorage
  useEffect(() => {
    const raw = localStorage.getItem("recent_searches");
    if (raw) setRecent(JSON.parse(raw));
  }, []);

  const saveRecent = (term: string) => {
    const next = [term, ...recent.filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(0, 8);
    setRecent(next);
    localStorage.setItem("recent_searches", JSON.stringify(next));
  };

  // focus trap + ESC to close
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();

    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // prefetch search page so navigation is instant
  useEffect(() => { if (open) router.prefetch("/search"); }, [open, router]);

  const submit = (term: string) => {
    const value = term.trim();
    if (!value) return;
    saveRecent(value);
    onClose();
    router.push(`/search?q=${encodeURIComponent(value)}`);
  };

  const disabled = useMemo(() => !q.trim(), [q]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110]">
      {/* dim background */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      {/* drawer */}
      <aside
        className="
          absolute left-0 top-0 h-full w-[min(480px,95vw)]
          bg-white shadow-2xl border-r border-gray-200
          animate-in slide-in-from-left duration-200
          flex flex-col
        "
        role="dialog"
        aria-modal="true"
      >
        {/* header search input */}
        <div className="p-4 border-b border-gray-200">
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); submit(q); }}
          >
            <div className="relative flex-1">
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search creators, skills, or topics (e.g., fitness, AI, editing)…"
                className="w-full rounded-full border px-4 py-2 pl-9 focus:outline-none focus:ring-4 focus:ring-[#9370DB]/15"
              />
              <svg viewBox="0 0 24 24" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 fill-gray-500">
                <path d="M21 20.3 16.8 16a7.5 7.5 0 1 0-.8.8L20.3 21l.7-.7zM4 10.5a6.5 6.5 0 1 1 13 0a6.5 6.5 0 0 1-13 0z"/>
              </svg>
            </div>
            <button
              type="submit"
              disabled={disabled}
              className="rounded-full bg-[#7F5CE6] text-white px-4 py-2 font-semibold disabled:opacity-60"
            >
              Search
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border px-3 py-2 text-sm"
            >
              Close
            </button>
          </form>

          {/* top chip row */}
          <div className="mt-3 flex flex-wrap gap-2">
            {CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => submit(c)}
                className="rounded-full border px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-8">
          <section>
            <h4 className="text-sm font-semibold text-gray-700">Recent</h4>
            {recent.length === 0 ? (
              <p className="text-sm text-gray-500 mt-2">No searches yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {recent.map((r) => (
                  <li key={r}>
                    <button
                      type="button"
                      onClick={() => submit(r)}
                      className="rounded-md px-2 py-1.5 hover:bg-gray-50 text-left w-full"
                    >
                      {r}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-gray-700">Suggested</h4>
              <button
                type="button"
                className="text-xs text-gray-500 hover:underline"
                onClick={() => {
                  // simple reshuffle
                  const shuffled = [...SUGGESTED].sort(() => Math.random() - 0.5);
                  const first = shuffled[0];
                  submit(first);
                }}
              >
                refresh
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {SUGGESTED.map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => submit(s)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4 className="text-sm font-semibold text-gray-700">Trending</h4>
            <div className="mt-2 flex flex-wrap gap-2">
              {TRENDING.map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => submit(t)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  {t}
                </button>
              ))}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
