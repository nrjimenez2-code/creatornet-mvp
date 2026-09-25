"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

type Notice = {
  id: string; kind: string; postId: string | null; readAt: string | null; createdAt: string;
  actorUsername: string | null; amountCents: number; currency: string;
};

export default function NotificationInbox({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(async () => {
    if (typeof fetch !== "function") return;
    const response = await fetch("/api/notifications", { credentials: "include", cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setItems(Array.isArray(data.items) ? data.items : []);
    setUnread(Number(data.unreadCount || 0));
    setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
    setLoaded(true);
  }, []);
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/notifications?cursor=${encodeURIComponent(nextCursor)}`, {
        credentials: "include", cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      const more = Array.isArray(data.items) ? data.items as Notice[] : [];
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...more.filter((item) => !seen.has(item.id))];
      });
      setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
    } finally { setLoadingMore(false); }
  };
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [load]);
  const markAllRead = async () => {
    await fetch("/api/notifications", { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) });
    setUnread(0); setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt || new Date().toISOString() })));
  };
  const markRead = (item: Notice) => {
    if (item.readAt) return;
    const now = new Date().toISOString();
    setUnread((value) => Math.max(0, value - 1));
    setItems((current) => current.map((notice) => notice.id === item.id ? { ...notice, readAt: now } : notice));
    void fetch(`/api/notifications/${encodeURIComponent(item.id)}/read`, {
      method: "PATCH", credentials: "include",
    }).then((response) => { if (!response.ok) void load(); });
  };
  return <div className={`relative ${className}`}>
    <button type="button" onClick={() => { setOpen((value) => !value); void load(); }} aria-label="Notifications"
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/75 text-white backdrop-blur hover:bg-white/10">
      <Bell className="h-5 w-5" />
      {unread > 0 && <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-[#655BFF] px-1 text-center text-[10px] font-bold leading-5">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && <>
      <button type="button" className="fixed inset-0 z-[70]" aria-label="Close notifications" onClick={() => setOpen(false)} />
      <section className="fixed inset-x-3 top-16 z-[80] max-h-[70vh] overflow-y-auto rounded-2xl border border-white/10 bg-[#09090b] p-3 text-white shadow-2xl sm:absolute sm:left-auto sm:right-0 sm:top-12 sm:w-96">
        <div className="flex items-center justify-between px-2 py-1"><h2 className="font-semibold">Notifications</h2>{unread > 0 && <button type="button" onClick={() => void markAllRead()} className="text-xs text-[#9c95ff]">Mark all read</button>}</div>
        {!loaded && <p className="p-4 text-sm text-white/60">Loading…</p>}
        {loaded && items.length === 0 && <p className="p-4 text-sm text-white/60">No notifications yet.</p>}
        <ul className="mt-2 space-y-1">{items.map((item) => <li key={item.id} className={`rounded-xl p-3 ${item.readAt ? "bg-white/[0.03]" : "bg-[#655BFF]/15"}`}>
          <Link href={item.postId ? `/dashboard?postId=${encodeURIComponent(item.postId)}` : "/dashboard/earnings"} onClick={() => { markRead(item); setOpen(false); }} className="block">
            <p className="text-sm"><span className="font-semibold">{item.actorUsername ? `@${item.actorUsername}` : "A viewer"}</span> tipped you ${(item.amountCents / 100).toFixed(2)}</p>
            <p className="mt-1 text-xs text-white/45">{new Date(item.createdAt).toLocaleString()}</p>
          </Link>
        </li>)}</ul>
        {nextCursor && <button type="button" disabled={loadingMore} onClick={() => void loadMore()}
          className="mt-3 w-full rounded-xl border border-white/10 p-3 text-center text-sm disabled:opacity-50">
          {loadingMore ? "Loading…" : "Load more"}
        </button>}
        <Link href="/dashboard/earnings" onClick={() => setOpen(false)} className="mt-3 block rounded-xl border border-white/10 p-3 text-center text-sm">View earnings</Link>
      </section>
    </>}
  </div>;
}
