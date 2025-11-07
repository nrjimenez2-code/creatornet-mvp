"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
// import { createBrowserClient } from "@/lib/supabaseBrowser"; // not used here
import { debounce } from "@/lib/utils"; // keep your helper

type Creator = {
  id: string;
  username: string | null;
  avatar_url: string | null;
  tagline: string | null;
};

type Post = {
  id: string;
  caption: string | null;
  media_url: string | null;
  creator_id: string;
  creator_username: string | null;
};

const SUGGESTED_DEFAULT = [
  "Dropshipping",
  "Digital Marketing",
  "SEO",
  "High-Ticket Sales",
  "Day Trading",
  "Affiliate Marketing",
];

const TRENDING_DEFAULT = [
  "AI Automation",
  "SMMA (Social Media Marketing Agency)",
  "E-Commerce",
  "Content Creation",
  "Personal Branding",
  "Digital Marketing",
];

export default function SearchPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const qParam = sp.get("q") ?? "";
  const [query, setQuery] = useState(qParam);
  const [loading, setLoading] = useState(false);

  // sections
  const [recent, setRecent] = useState<string[]>([]);
  const [suggested, setSuggested] = useState<string[]>(SUGGESTED_DEFAULT);
  const [trending, setTrending] = useState<string[]>(TRENDING_DEFAULT);

  // results
  const [creators, setCreators] = useState<Creator[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [tab, setTab] = useState<"for-you" | "creators" | "videos" | "tags">(
    "for-you"
  );

  // hydration
  useEffect(() => {
    try {
      const r = JSON.parse(localStorage.getItem("recent-searches") || "[]");
      if (Array.isArray(r)) setRecent(r.slice(0, 10));
    } catch {}
  }, []);

  // push to URL without full reload
  useEffect(() => {
    if (qParam !== query) {
      const p = new URLSearchParams(Array.from(sp.entries()));
      if (query) p.set("q", query);
      else p.delete("q");
      router.replace(`/search?${p.toString()}`, { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // persist recent
  const pushRecent = useCallback(
    (term: string) => {
      if (!term.trim()) return;
      const next = [
        term.trim(),
        ...recent.filter(
          (t) => t.toLowerCase() !== term.trim().toLowerCase()
        ),
      ].slice(0, 10);
      setRecent(next);
      localStorage.setItem("recent-searches", JSON.stringify(next));
    },
    [recent]
  );

  const doSearch = useCallback(async (term: string) => {
    const q = term.trim();
    if (!q) {
      setCreators([]);
      setPosts([]);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/search/perform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q }),
      });

      // if server returns non-200, keep UI stable
      if (!res.ok) {
        setCreators([]);
        setPosts([]);
        return;
      }

      // guard against empty/invalid JSON
      const payload = (await res.json().catch(() => ({ items: [] }))) as {
        items?: any[];
      };

      const items = Array.isArray(payload.items) ? payload.items : [];

      // Map server items -> Post[]
      const mapped: Post[] = items.map((r: any) => ({
        id: String(r.id),
        caption: r.caption ?? null,
        media_url: r.media_url ?? null,
        creator_id: String(r.creator_id ?? ""),
        creator_username: r.creator?.username ?? null,
      }));

      // We’re not returning creators yet from the API; clear for now.
      setCreators([]);
      setPosts(mapped);
    } finally {
      setLoading(false);
    }
  }, []);

  // debounce search while typing
  const debouncedSearch = useMemo(() => debounce(doSearch, 250), [doSearch]);

  useEffect(() => {
    if (query) debouncedSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    pushRecent(query);
    doSearch(query);
  };

  const pick = (term: string) => {
    setQuery(term);
    pushRecent(term);
    doSearch(term);
  };

  // UI
  return (
    <div className="min-h-screen">
      {/* Top search bar */}
      <div className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b">
        <form
          onSubmit={onSubmit}
          className="mx-auto max-w-3xl px-4 py-3 flex items-center gap-3"
        >
          <div className="flex-1 relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search creators, skills, or topics (e.g., fitness, AI, editing)."
              className="w-full rounded-full border px-5 py-3 pl-11 outline-none focus:ring-2 focus:ring-[#7F5CE6]"
              inputMode="search"
            />
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-500"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M21 20.3 16.8 16a7.5 7.5 0 1 0-.8.8L20.3 21l.7-.7zM4 10.5a6.5 6.5 0 1 1 13 0a6.5 6.5 0 0 1-13 0z" />
            </svg>
          </div>
          <button
            type="submit"
            className="rounded-full bg-[#7F5CE6] text-white px-5 py-2.5 font-medium"
          >
            Search
          </button>
        </form>

        {/* Niche filter chips (horizontal) */}
        <div className="mx-auto max-w-4xl px-4 pb-3 overflow-x-auto">
          <div className="flex gap-2 min-w-max">
            {[
              "Business",
              "Fitness",
              "Marketing",
              "AI",
              "Mindset",
              "UGC",
              "Design",
              "Productivity",
            ].map((c) => (
              <button
                key={c}
                onClick={() => pick(c)}
                className={`px-3 py-1.5 rounded-full border text-sm ${
                  query.toLowerCase() === c.toLowerCase()
                    ? "bg-[#7F5CE6] text-white border-[#7F5CE6]"
                    : "bg-white hover:bg-gray-50"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* If no query: show history / suggested / trending */}
      {!query && (
        <div className="mx-auto max-w-4xl px-4 py-6 space-y-8">
          <Section title="Recent">
            <div className="flex flex-wrap gap-2">
              {recent.length ? (
                recent.map((r) => <Chip key={r} onClick={() => pick(r)}>{r}</Chip>)
              ) : (
                <p className="text-sm text-gray-500">No searches yet.</p>
              )}
            </div>
          </Section>

          <Section
            title="Suggested"
            action={
              <button
                className="text-xs text-gray-500 hover:underline"
                onClick={() =>
                  setSuggested([...SUGGESTED_DEFAULT].sort(() => Math.random() - 0.5))
                }
              >
                refresh
              </button>
            }
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {suggested.map((s) => (
                <button
                  key={s}
                  onClick={() => pick(s)}
                  className="text-left rounded-lg border px-3 py-2 hover:bg-gray-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Trending">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {trending.map((t) => (
                <button
                  key={t}
                  onClick={() => pick(t)}
                  className="text-left rounded-lg border px-3 py-2 hover:bg-gray-50"
                >
                  {t}
                </button>
              ))}
            </div>
          </Section>
        </div>
      )}

      {/* Query active: show results layout like your mockup */}
      {!!query && (
        <div className="mx-auto max-w-6xl px-4 py-5">
          {/* Tabs */}
          <div className="flex gap-6 border-b mb-4">
            {(["for-you", "creators", "videos", "tags"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-2 -mb-px border-b-2 ${
                  tab === t ? "border-black font-semibold" : "border-transparent text-gray-500"
                }`}
              >
                {t === "for-you" ? "For you" : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {loading && <p className="text-sm text-gray-500">Searching…</p>}

          {/* Creators strip (top 5) - not populated yet from API */}
          {!loading && (tab === "for-you" || tab === "creators") && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold mb-3">Creators</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {creators.slice(0, 5).map((c) => (
                  <CreatorCard key={c.id} c={c} />
                ))}
                {!creators.length && (
                  <p className="text-sm text-gray-500">No creators yet.</p>
                )}
              </div>
            </div>
          )}

          {/* Posts grid */}
          {!loading && (tab === "for-you" || tab === "videos") && (
            <div>
              <h3 className="text-sm font-semibold mb-3">Posts</h3>
              <PostsGrid items={posts} />
            </div>
          )}

          {tab === "tags" && (
            <div className="text-sm text-gray-600">
              Tags view coming next; we’ll index hashtags and show their top posts.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Chip({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 text-sm"
    >
      {children}
    </button>
  );
}

function CreatorCard({ c }: { c: Creator }) {
  return (
    <Link
      href={`/profile?u=${encodeURIComponent(c.username || c.id)}`}
      className="rounded-xl border p-3 hover:bg-gray-50 flex gap-3"
    >
      <div className="h-10 w-10 rounded-full bg-gray-200 overflow-hidden">
        {c.avatar_url ? (
          <img src={c.avatar_url} alt="" className="h-full w-full object-cover" />
        ) : null}
      </div>
      <div className="min-w-0">
        <div className="font-medium truncate">@{c.username || "creator"}</div>
        <div className="text-xs text-gray-500 line-clamp-2">
          {c.tagline || "—"}
        </div>
      </div>
    </Link>
  );
}

function PostsGrid({ items }: { items: Post[] }) {
  // Pagination not implemented in the API yet; render the batch.
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {items.map((p) => (
          <div
            key={p.id}
            className="aspect-[9/16] rounded-xl overflow-hidden bg-gray-100"
          >
            {p.media_url ? (
              <img
                src={p.media_url}
                className="h-full w-full object-cover"
                alt={p.caption || ""}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
