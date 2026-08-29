"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAdminData } from "@/components/admin/AdminDataContext";
import { Avatar, StatusBadge, VideoThumb } from "@/components/admin/ui";
import {
  IconCard,
  IconStar,
  IconGrid,
  IconPlaySquare,
  IconSearch,
  IconUsers,
} from "@/components/admin/icons";
import { formatCents } from "@/lib/admin/format";

/** Fired by the sidebar search button — the palette listens globally. */
export const OPEN_PALETTE_EVENT = "creatornet:open-admin-palette";

interface PaletteResult {
  id: string;
  group: "Pages" | "Users" | "Videos" | "Orders";
  title: string;
  subtitle: string;
  href: string;
  media: React.ReactNode;
  badge?: React.ReactNode;
}

const MAX_PER_GROUP = 4;

const PAGES = [
  { title: "Overview", href: "/admin", icon: <IconGrid size={15} /> },
  { title: "Users & Creators", href: "/admin/users", icon: <IconUsers size={15} /> },
  { title: "Content", href: "/admin/content", icon: <IconPlaySquare size={15} /> },
  { title: "Commerce", href: "/admin/commerce", icon: <IconCard size={15} /> },
  { title: "Reviews", href: "/admin/reviews", icon: <IconStar size={15} /> },
] as const;

function rank(haystack: string, query: string): number {
  const value = haystack.toLowerCase();
  if (value.startsWith(query)) return 0;
  if (value.includes(query)) return 1;
  return -1;
}

/**
 * Global ⌘K command palette — jump to a page or search any user, video, or
 * order and land on the right page with the search pre-filled (?q=).
 *
 * INTEGRATION: swap the in-memory filter for a Supabase textSearch RPC when
 * datasets outgrow the client (docs/ADMIN_HANDOFF.md).
 */
export function CommandPalette() {
  const router = useRouter();
  const { users, videos, orders } = useAdminData();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsOpen((prev) => !prev);
        setQuery("");
        setActiveIndex(0);
      }
      if (event.key === "Escape") close();
    }
    function handleOpenEvent() {
      setIsOpen(true);
      setQuery("");
      setActiveIndex(0);
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, handleOpenEvent);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, handleOpenEvent);
    };
  }, [close]);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const results = useMemo<PaletteResult[]>(() => {
    const q = query.trim().toLowerCase();

    const pageResults: PaletteResult[] = PAGES.filter(
      (page) => q === "" || rank(page.title, q) >= 0,
    ).map((page) => ({
      id: `page-${page.href}`,
      group: "Pages",
      title: page.title,
      subtitle: "Jump to page",
      href: page.href,
      media: (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[#f3eefc] text-[#7c5cbf]">
          {page.icon}
        </span>
      ),
    }));

    if (q === "") return pageResults;

    const userResults: PaletteResult[] = users
      .map((user) => ({
        user,
        score: Math.max(
          rank(user.displayName, q),
          rank(user.username, q),
          rank(user.email, q),
        ),
      }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, MAX_PER_GROUP)
      .map(({ user }) => ({
        id: `user-${user.id}`,
        group: "Users" as const,
        title: user.displayName,
        subtitle: `@${user.username} · ${user.isCreator ? "Creator" : "Viewer"}`,
        href: `/admin/users?q=${encodeURIComponent(user.username)}`,
        media: <Avatar id={user.id} name={user.displayName} size={32} />,
        badge: <StatusBadge status={user.status} />,
      }));

    const videoResults: PaletteResult[] = videos
      .map((video) => ({
        video,
        score: Math.max(rank(video.title, q), rank(video.creatorUsername, q)),
      }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, MAX_PER_GROUP)
      .map(({ video }) => ({
        id: `video-${video.id}`,
        group: "Videos" as const,
        title: video.title,
        subtitle: `@${video.creatorUsername}`,
        href: `/admin/content?q=${encodeURIComponent(video.title)}`,
        media: <VideoThumb id={video.id} size={36} />,
        badge: <StatusBadge status={video.status} />,
      }));

    const orderResults: PaletteResult[] = orders
      .map((order) => ({
        order,
        score: Math.max(
          rank(order.offerTitle, q),
          rank(order.buyerUsername, q),
          rank(order.creatorUsername, q),
        ),
      }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, MAX_PER_GROUP)
      .map(({ order }) => ({
        id: `order-${order.id}`,
        group: "Orders" as const,
        title: order.offerTitle,
        subtitle: `@${order.buyerUsername} → @${order.creatorUsername} · ${formatCents(order.grossCents)}`,
        href: `/admin/commerce?q=${encodeURIComponent(order.offerTitle)}`,
        media: (
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
            <IconCard size={15} />
          </span>
        ),
        badge: <StatusBadge status={order.status} />,
      }));

    return [...pageResults, ...userResults, ...videoResults, ...orderResults];
  }, [query, users, videos, orders]);

  // Clamp during render (no effect): if the result list shrinks below the
  // stored index, the highlight stays on the last row instead of going stale.
  const clampedIndex =
    results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1);

  const select = useCallback(
    (result: PaletteResult) => {
      close();
      router.push(result.href);
    },
    [close, router],
  );

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(Math.min(clampedIndex + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(Math.max(clampedIndex - 1, 0));
    } else if (event.key === "Enter" && results[clampedIndex]) {
      event.preventDefault();
      select(results[clampedIndex]);
    }
  }

  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex]);

  if (!isOpen) return null;

  let lastGroup: PaletteResult["group"] | null = null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Search everything"
    >
      <button
        type="button"
        aria-label="Close search"
        onClick={close}
        className="absolute inset-0 h-full w-full cursor-default bg-[#1a1030]/40 backdrop-blur-[3px] motion-safe:animate-[backdropIn_0.15s_ease-out]"
      />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-[#e9e3f7] bg-white shadow-[0_24px_80px_rgba(24,16,44,0.35)] motion-safe:animate-[paletteIn_0.18s_ease-out]">
        <div className="flex items-center gap-3 border-b border-[#f0ebfb] px-4 py-3.5">
          <span className="text-[#9370DB]">
            <IconSearch size={17} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Search users, videos, orders…"
            aria-label="Search users, videos, orders"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-zinc-900 outline-none placeholder:text-gray-400"
          />
          <kbd className="rounded-md border border-[#e5ddf5] bg-[#faf8ff] px-1.5 py-0.5 text-[10px] font-bold text-gray-400">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-gray-400">
              No matches for &ldquo;{query}&rdquo;
            </p>
          ) : (
            results.map((result, index) => {
              const showGroup = result.group !== lastGroup;
              lastGroup = result.group;
              const isActive = index === clampedIndex;
              return (
                <div key={result.id}>
                  {showGroup ? (
                    <p className="px-3 pt-3 pb-1.5 text-[10px] font-bold tracking-wider text-gray-400 uppercase">
                      {result.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    data-active={isActive}
                    onClick={() => select(result)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      isActive ? "bg-[#f3eefc]" : ""
                    }`}
                  >
                    {result.media}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-zinc-900">
                        {result.title}
                      </span>
                      <span className="block truncate text-xs text-gray-400">
                        {result.subtitle}
                      </span>
                    </span>
                    {result.badge ?? null}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-[#f0ebfb] bg-[#faf8ff] px-4 py-2.5 text-[11px] text-gray-400">
          <span>
            <kbd className="font-sans font-bold">↑↓</kbd> navigate
          </span>
          <span>
            <kbd className="font-sans font-bold">↵</kbd> open
          </span>
          <span className="ml-auto font-semibold text-[#9370DB]">CreatorNet Admin</span>
        </div>
      </div>
    </div>
  );
}
