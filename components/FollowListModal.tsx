// components/FollowListModal.tsx — paginated followers / following list.
// Modal shell follows PostComposerModal (role=dialog, Esc, scroll lock,
// backdrop click). Data comes from /api/users/[userId]/follows.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import UserRow, { type UserRowUser } from "./UserRow";

export type FollowListType = "followers" | "following";

type FollowListModalProps = {
  userId: string;
  type: FollowListType;
  open: boolean;
  onClose: () => void;
  title: string;
};

type Page = { items: UserRowUser[]; nextCursor: string | null };
type Status = "idle" | "loading" | "loaded" | "error";

const EMPTY_TEXT: Record<FollowListType, string> = {
  followers: "No followers yet",
  following: "Not following anyone yet",
};
const LOAD_ERROR = "Could not load this list.";

async function fetchPage(userId: string, type: FollowListType, cursor: string | null): Promise<Page> {
  const params = new URLSearchParams({ type });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/follows?${params.toString()}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : LOAD_ERROR);
  }
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    nextCursor: typeof body?.nextCursor === "string" ? body.nextCursor : null,
  };
}

/** Appends `incoming` to `existing`, dropping any id already present. */
function mergeUnique(existing: UserRowUser[], incoming: UserRowUser[]): UserRowUser[] {
  const seen = new Set(existing.map((u) => u.id));
  const fresh = incoming.filter((u) => {
    if (seen.has(u.id)) return false;
    seen.add(u.id);
    return true;
  });
  return [...existing, ...fresh];
}

export default function FollowListModal({ userId, type, open, onClose, title }: FollowListModalProps) {
  // The parent remounts this component (via `key`) every time it opens, so
  // state always starts fresh: nothing to reset here.
  const [items, setItems] = useState<UserRowUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Bumped on every request and on close, so a late response is ignored.
  const requestSeq = useRef(0);

  // State moves only inside the promise callbacks, never synchronously in an
  // effect body (react-hooks/set-state-in-effect).
  const run = useCallback(
    (cursor: string | null) => {
      const seq = ++requestSeq.current;
      fetchPage(userId, type, cursor).then(
        (page) => {
          if (seq !== requestSeq.current) return;
          setItems((prev) => mergeUnique(cursor ? prev : [], page.items));
          setNextCursor(page.nextCursor);
          setStatus("loaded");
          setIsLoadingMore(false);
        },
        (err: unknown) => {
          if (seq !== requestSeq.current) return;
          setError(err instanceof Error ? err.message : LOAD_ERROR);
          setStatus("error");
          setIsLoadingMore(false);
        }
      );
    },
    [userId, type]
  );

  const retryInitial = () => {
    setError(null);
    setStatus("loading");
    run(null);
  };

  const loadMore = () => {
    setError(null);
    setIsLoadingMore(true);
    run(nextCursor);
  };

  // First page on open; cancel anything in flight on close.
  useEffect(() => {
    if (!open) return;
    run(null);
    return () => {
      requestSeq.current += 1;
    };
  }, [open, run]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const hasItems = items.length > 0;
  const showInitialLoading = status === "loading" && !hasItems;
  const showInitialError = status === "error" && !hasItems;
  const showEmpty = status === "loaded" && !hasItems;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-[min(480px,95vw)] max-h-[85vh] flex flex-col rounded-2xl bg-[#060606] p-5 shadow-2xl outline-none border border-white/10 text-white"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold tracking-wide">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-white/80 hover:bg-white/10 transition"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 min-h-0 overflow-y-auto">
          {showInitialLoading && <p className="py-6 text-center text-sm text-white/60">Loading…</p>}

          {showInitialError && (
            <div className="py-6 text-center">
              <p className="text-sm text-red-300">{error}</p>
              <button
                type="button"
                onClick={retryInitial}
                className="mt-3 px-3 py-1.5 rounded-full border border-white/20 text-sm bg-black text-white hover:bg-black/70"
              >
                Retry
              </button>
            </div>
          )}

          {showEmpty && <p className="py-6 text-center text-sm text-white/60">{EMPTY_TEXT[type]}</p>}

          {hasItems && (
            <ul className="flex flex-col gap-2">
              {items.map((u) => (
                <li key={u.id}>
                  <UserRow user={u} onNavigate={onClose} />
                </li>
              ))}
            </ul>
          )}

          {hasItems && status === "error" && (
            <div className="mt-3 text-center">
              <p className="text-sm text-red-300">{error}</p>
              <button
                type="button"
                onClick={loadMore}
                className="mt-2 px-3 py-1.5 rounded-full border border-white/20 text-sm bg-black text-white hover:bg-black/70"
              >
                Retry
              </button>
            </div>
          )}

          {hasItems && status !== "error" && nextCursor && (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={isLoadingMore}
                className="px-3 py-1.5 rounded-full border border-white/20 text-sm bg-black text-white hover:bg-black/70 disabled:opacity-50"
              >
                {isLoadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}

          {hasItems && status === "loaded" && !nextCursor && (
            <p className="mt-3 text-center text-xs text-white/40">That&apos;s everyone</p>
          )}
        </div>
      </div>
    </div>
  );
}
