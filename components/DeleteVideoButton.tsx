"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";

export default function DeleteVideoButton({ postId, creatorId, onDeleted }: {
  postId: string; creatorId: string; onDeleted: () => void;
}) {
  const { userId, loading } = useUser();
  const dialog = useRef<HTMLDialogElement>(null);
  const options = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | undefined>();
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading || !userId || userId !== creatorId) return null;

  async function remove() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session?.access_token || data.session.user.id !== creatorId) {
        throw Error("Please sign in again before deleting this video.");
      }
      const response = await fetch(`/api/posts/${encodeURIComponent(postId)}`, {
        method: "DELETE", credentials: "include",
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      const result = await response.json();
      if (!response.ok || result.deleted !== true) throw Error(result.error || "Could not delete this video. Please try again.");
      dialog.current?.close();
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this video. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <>
    <button ref={trigger} type="button" aria-label="Video options" title="Video options" aria-haspopup="dialog" aria-expanded={optionsOpen}
      className="mx-auto flex h-11 w-11 items-center justify-center bg-transparent text-white/75 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setMenuPosition(window.innerWidth >= 1024 ? { top: Math.max(8, rect.top - 70), left: Math.max(8, Math.min(rect.right - 208, window.innerWidth - 216)) } : undefined);
        setOptionsOpen(true); options.current?.showModal();
      }}>
      <Ellipsis className="h-6 w-6" aria-hidden="true" />
    </button>
    {typeof document !== "undefined" && createPortal(
      <dialog ref={options} aria-label="Video options" style={menuPosition}
        onClose={() => { setOptionsOpen(false); if (!dialog.current?.open) trigger.current?.focus(); }}
        onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) options.current?.close(); }}
        onKeyDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()}
        className="fixed inset-x-0 bottom-0 top-auto m-0 w-full max-w-none rounded-t-2xl border border-white/15 bg-[#17141d] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-white shadow-2xl backdrop:bg-black/60 lg:bottom-auto lg:right-auto lg:w-52 lg:rounded-xl lg:p-1.5 lg:backdrop:bg-transparent">
        <div className="mx-auto mb-4 h-1 w-8 rounded-full bg-white/25 lg:hidden" />
        <button type="button" className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-red-300 hover:bg-white/5"
          onClick={() => { options.current?.close(); setOptionsOpen(false); setError(null); dialog.current?.showModal(); cancel.current?.focus(); }}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />Delete video
        </button>
        <button type="button" onClick={() => options.current?.close()} className="mt-3 w-full rounded-xl border border-white/10 bg-white/5 py-3 text-sm lg:hidden">Cancel</button>
      </dialog>, document.body)}
    {typeof document !== "undefined" && createPortal(
      <dialog ref={dialog} aria-labelledby={`delete-title-${postId}`} aria-describedby={`delete-description-${postId}`}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()} onTouchEnd={(event) => event.stopPropagation()}
        onCancel={(event) => { if (inFlight.current) event.preventDefault(); }}
        className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-white/15 bg-[#111015] p-6 text-white shadow-2xl backdrop:bg-black/70">
        <h2 id={`delete-title-${postId}`} className="text-lg font-semibold">Delete video?</h2>
        <p id={`delete-description-${postId}`} className="mt-2 text-sm leading-6 text-white/65">This removes the video from your profile and feed. Buyers keep access to everything they already paid for.</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-6 flex justify-end gap-3">
          <button ref={cancel} type="button" disabled={busy} onClick={() => dialog.current?.close()}
            className="rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50">Cancel</button>
          <button type="button" disabled={busy} onClick={remove}
            className="rounded-xl bg-[#4934c4] px-4 py-2 text-sm font-semibold hover:bg-[#5944d4] disabled:opacity-50">{busy ? "Deleting…" : "Delete"}</button>
        </div>
      </dialog>, document.body)}
  </>;
}
