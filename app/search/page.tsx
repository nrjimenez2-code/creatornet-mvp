"use client";

import { Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import BackButton from "@/components/BackButton";
// import { createBrowserClient } from "@/lib/supabaseBrowser"; // not used here
import { debounce, DEFAULT_AVATAR_URL } from "@/lib/utils";
import { trackEvent } from "@/lib/posthog";
import { readRecentSearches, subscribeRecentSearches, recentSearchesServerSnapshot, parseRecentSearches, saveRecentSearches } from "@/lib/recentSearches";

type Creator = {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  tagline: string | null;
};

type Post = {
  id: string;
  caption: string | null;
  media_url: string | null;
  poster_url: string | null;
  creator_id: string;
  creator_username: string | null;
  likes_count?: number;
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

function SearchPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const qParam = sp.get("q") ?? "";
  const [query, setQuery] = useState(qParam);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // sections
  const recentSnapshot = useSyncExternalStore(subscribeRecentSearches, readRecentSearches, recentSearchesServerSnapshot);
  const recent = useMemo(() => parseRecentSearches(recentSnapshot), [recentSnapshot]);
  const [suggested, setSuggested] = useState<string[]>(SUGGESTED_DEFAULT);
  const [trending, setTrending] = useState<string[]>(TRENDING_DEFAULT);

  // results
  const [creators, setCreators] = useState<Creator[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [noUserFound, setNoUserFound] = useState(false);
  const [suggestedCreators, setSuggestedCreators] = useState<Creator[]>([]);
  const [suggestedPosts, setSuggestedPosts] = useState<Post[]>([]);
  const [isTagSearch, setIsTagSearch] = useState(false);
  const [tab, setTab] = useState<"for-you" | "creators" | "videos" | "tags">(
    "for-you"
  );

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
      saveRecentSearches(next);
    },
    [recent]
  );

  const doSearch = useCallback(async (term: string) => {
    const q = term.trim();
    if (!q) {
      setCreators([]);
      setPosts([]);
      setNoUserFound(false);
      setSuggestedCreators([]);
      setSuggestedPosts([]);
      setIsTagSearch(false);
      return;
    }

    setLoading(true);
    setSearchError(null);
    try {
      const res = await fetch("/api/search/perform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q }),
      });

      // A failed search must not masquerade as "no results".
      if (!res.ok) {
        setCreators([]);
        setPosts([]);
        setSearchError("Search isn't working right now. Try again in a moment.");
        return;
      }

      // guard against empty/invalid JSON
      const payload = (await res.json().catch(() => ({}))) as {
        creators?: any[];
        items?: any[];
        noUserFound?: boolean;
        suggested_creators?: any[];
        suggested_posts?: any[];
        isTagSearch?: boolean;
      };

      const mapCreator = (r: any): Creator => ({
        id: String(r.id),
        username: r.username ?? null,
        full_name: r.full_name ?? null,
        avatar_url: r.avatar_url ?? null,
        tagline: r.tagline ?? null,
      });

      const mapPost = (r: any): Post => ({
        id: String(r.id),
        caption: r.caption ?? null,
        media_url: r.media_url ?? null,
        poster_url: r.poster_url ?? null,
        creator_id: String(r.creator_id ?? ""),
        creator_username: r.creator?.username ?? null,
        likes_count:
          typeof r.likes_count === "number" ? r.likes_count : undefined,
      });

      const items = Array.isArray(payload.items) ? payload.items : [];
      const mappedPosts: Post[] = items.map(mapPost);
      const mappedCreators: Creator[] = (Array.isArray(payload.creators) ? payload.creators : []).map(mapCreator);
      const suggestedC: Creator[] = (Array.isArray(payload.suggested_creators) ? payload.suggested_creators : []).map(mapCreator);
      const suggestedP: Post[] = (Array.isArray(payload.suggested_posts) ? payload.suggested_posts : []).map(mapPost);

      setCreators(mappedCreators);
      setPosts(mappedPosts);
      setNoUserFound(Boolean(payload.noUserFound));
      setSuggestedCreators(suggestedC);
      setSuggestedPosts(suggestedP);
      setIsTagSearch(Boolean(payload.isTagSearch));

      trackEvent("search_performed", {
        query: q,
        results_count: mappedCreators.length + mappedPosts.length,
      });
    } catch {
      // Network failure — surface it instead of an unhandled rejection.
      setCreators([]);
      setPosts([]);
      setSearchError("Search isn't working right now. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // debounce search while typing
  const debouncedSearch = useMemo(() => debounce(doSearch, 250), [doSearch]);
  const creatorIdSet = useMemo(
    () => new Set(creators.map((c) => c.id)),
    [creators]
  );
  const creatorVideoPosts = useMemo(
    () => posts.filter((p) => creatorIdSet.has(p.creator_id)),
    [posts, creatorIdSet]
  );
  const tagSortedPosts = useMemo(
    () => [...posts].sort((a, b) => (b.likes_count ?? 0) - (a.likes_count ?? 0)),
    [posts]
  );
  const topLikedPostsForNameSearch = useMemo(
    () => [...creatorVideoPosts].sort((a, b) => (b.likes_count ?? 0) - (a.likes_count ?? 0)),
    [creatorVideoPosts]
  );

  useEffect(() => {
    if (query) debouncedSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    pushRecent(query);
    doSearch(query);
  };

  const pick = (term: string, isCategory = false) => {
    setQuery(term);
    pushRecent(term);
    doSearch(term);
    if (isCategory) {
      trackEvent("category_clicked", { category: term.toLowerCase() });
    }
  };

  // UI
  return (
    <div className="min-h-screen bg-black text-white">
      {/* Top search bar */}
      <div className="sticky top-0 z-30 bg-black border-b border-white/10">
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="[&>div]:mb-0">
            <BackButton hrefOverride="/dashboard" className="inline-flex h-10 w-10 items-center justify-center text-white mix-blend-difference transition-transform hover:-translate-x-1 focus:outline-none" />
          </div>
          <form
            onSubmit={onSubmit}
            className="flex flex-1 items-center gap-2 sm:gap-3 max-w-4xl min-w-0"
          >
          <div className="flex-1 min-w-0 relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search creators, skills, or topics (e.g., fitness, AI, editing)."
              className="w-full rounded-full border border-white/20 px-5 py-3 pl-11 bg-black text-white placeholder-white/50 outline-none focus:ring-2 focus:ring-[#4A35C7]"
              inputMode="search"
            />
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-white/60"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M21 20.3 16.8 16a7.5 7.5 0 1 0-.8.8L20.3 21l.7-.7zM4 10.5a6.5 6.5 0 1 1 13 0a6.5 6.5 0 0 1-13 0z" />
            </svg>
          </div>
          <button
            type="submit"
            className="shrink-0 rounded-full bg-white text-black px-4 sm:px-5 py-2.5 font-medium"
          >
            Search
          </button>
        </form>
        </div>

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
                onClick={() => pick(c, true)}
                className={`px-3 py-1.5 rounded-full border text-sm transition ${
                  query.toLowerCase() === c.toLowerCase()
                    ? "bg-[#4A35C7] text-white border-[#4A35C7]"
                    : "bg-black text-white border-white/20 hover:bg-black/70"
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
                  <p className="text-sm text-white/50">No searches yet.</p>
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
                  className="text-left rounded-lg border border-white/20 px-3 py-2 bg-black text-white hover:bg-black/70"
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
                  className="text-left rounded-lg border border-white/20 px-3 py-2 bg-black text-white hover:bg-black/70"
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
          <div className="flex gap-6 border-b border-white/15 mb-4">
            {(["for-you", "creators", "videos", "tags"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-2 -mb-px border-b-2 ${
                  tab === t ? "border-white text-white font-semibold" : "border-transparent text-white/50 hover:text-white/80"
                }`}
              >
                {t === "for-you" ? "For you" : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {loading && <p className="text-sm text-white/60">Searching…</p>}

          {!loading && searchError && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3">
              <p className="text-sm text-red-300" role="alert">
                {searchError}
              </p>
              <button
                type="button"
                onClick={() => doSearch(query)}
                className="mt-2 rounded-full border border-white/20 px-4 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors"
              >
                Try again
              </button>
            </div>
          )}

          {/* For You tab */}
          {!loading && !searchError && tab === "for-you" && (
            <div className="space-y-6">
              {noUserFound && (
                <p className="text-sm text-white/80 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
                  No user found with that name. Here are some creators and posts you might like:
                </p>
              )}
              {(noUserFound ? suggestedCreators : creators).length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold mb-3">Creators</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {(noUserFound ? suggestedCreators : creators).map((c) => (
                      <CreatorCard key={c.id} c={c} />
                    ))}
                  </div>
                </div>
              )}
              <div>
                <h3 className="text-sm font-semibold mb-3">Posts</h3>
                <PostsGrid items={noUserFound ? suggestedPosts : posts} />
                {!(noUserFound ? suggestedPosts : posts).length && (
                  <p className="text-sm text-white/60 py-4">
                    {noUserFound ? "No suggested posts." : "No posts for this search."}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Creators tab */}
          {!loading && !searchError && tab === "creators" && (
            <div className="space-y-4">
              {isTagSearch ? (
                <p className="text-sm text-white/60 py-4">
                  Search by creator name to see accounts. Hashtag search only shows posts.
                </p>
              ) : (noUserFound ? suggestedCreators : creators).length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {(noUserFound ? suggestedCreators : creators).map((c) => (
                    <CreatorCard key={c.id} c={c} />
                  ))}
                </div>
              ) : (
                <p className="text-sm text-white/60 py-4">No creators found.</p>
              )}
            </div>
          )}

          {/* Videos tab */}
          {!loading && !searchError && tab === "videos" && (
            <div>
              {isTagSearch ? (
                <PostsGrid items={posts} />
              ) : noUserFound ? (
                <p className="text-sm text-white/60 py-4">No user found with that name.</p>
              ) : creators.length > 0 && creatorVideoPosts.length > 0 ? (
                <PostsGrid items={creatorVideoPosts} />
              ) : (
                <p className="text-sm text-white/60 py-4">This user has not posted anything yet.</p>
              )}
            </div>
          )}

          {/* Tags tab */}
          {!loading && !searchError && tab === "tags" && (
            <div>
              {isTagSearch ? (
                <>
                  <p className="text-sm text-white/80 mb-3">Top posts for this tag (by likes)</p>
                  <PostsGrid items={tagSortedPosts} />
                  {!tagSortedPosts.length && <p className="text-sm text-white/60 py-4">No posts with this tag yet.</p>}
                </>
              ) : topLikedPostsForNameSearch.length > 0 ? (
                <>
                  <p className="text-sm text-white/80 mb-3">Top posts (by likes)</p>
                  <PostsGrid items={topLikedPostsForNameSearch} />
                </>
              ) : (
                <p className="text-sm text-white/60 py-4">
                  Search with a hashtag (e.g. #fitness) to see top posts by likes.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SearchPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-sm text-white/60">Loading search…</div>}>
      <SearchPage />
    </Suspense>
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
      className="px-3 py-1.5 rounded-full border border-white/20 text-sm bg-black text-white hover:bg-black/70"
    >
      {children}
    </button>
  );
}

function CreatorCard({ c }: { c: Creator }) {
  const href =
    c.username && c.username.length > 0
      ? `/profile/${encodeURIComponent(c.username)}`
      : `/creators/${c.id}`;

  return (
    <Link
      href={href}
      className="rounded-xl border border-white/10 p-3 hover:bg-white/5 flex gap-3"
    >
      <div className="h-10 w-10 rounded-full bg-white/10 overflow-hidden">
        <img src={c.avatar_url || DEFAULT_AVATAR_URL} alt="" className="h-full w-full object-cover" />
      </div>
      <div className="min-w-0">
        <div className="font-medium truncate text-white">@{c.username || "creator"}</div>
        <div className="text-xs text-white/60 line-clamp-2">
          {c.tagline || "—"}
        </div>
      </div>
    </Link>
  );
}

function PostsGrid({ items }: { items: Post[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useMemo(
    () => Array.from({ length: items.length }, () => ({ current: null as HTMLDivElement | null })),
    [items.length]
  );

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const target = itemRefs[activeIndex]?.current;
    if (!target) return;
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: "center" });
    });
  }, [isOpen, activeIndex, itemRefs]);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 sm:gap-2">
        {items.map((p, index) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setActiveIndex(index);
              setIsOpen(true);
            }}
            aria-label={p.caption ? `Open post: ${p.caption}` : "Open post"}
            className="group aspect-square overflow-hidden border border-white/10 bg-black/60 block hover:ring-2 hover:ring-white/20 transition"
          >
            {p.poster_url ? (
              <img
                src={p.poster_url}
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
                alt=""
                loading="lazy"
              />
            ) : p.media_url ? (
              <video
                src={p.media_url}
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
                muted
                loop
                playsInline
                preload="none"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-white/60">
                No media
              </div>
            )}
          </button>
        ))}
      </div>

      {isOpen && items.length > 0 && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm">
          <div className="absolute top-4 left-4 z-10 [&>div]:mb-0">
            <BackButton
              hrefOverride={undefined}
              className="inline-flex h-10 w-10 items-center justify-center text-white mix-blend-difference transition-transform hover:-translate-x-1 focus:outline-none"
              onClick={() => setIsOpen(false)}
            />
          </div>

          <div className="h-full overflow-y-auto px-4 py-8 space-y-10 snap-y snap-mandatory scroll-smooth">
            {items.map((post, index) => (
              <div
                key={`search-modal-${post.id}`}
                ref={(el) => {
                  itemRefs[index].current = el;
                }}
                className="max-w-4xl mx-auto text-white snap-center"
              >
                <div className="relative aspect-[9/16] w-full max-w-[420px] mx-auto overflow-hidden rounded-3xl border border-white/10 bg-black">
                  {post.media_url ? (
                    <video
                      src={post.media_url}
                      poster={post.poster_url || undefined}
                      aria-label={post.caption || "Video"}
                      className="h-full w-full object-cover"
                      controls
                      autoPlay={index === activeIndex}
                      playsInline
                      preload="none"
                    />
                  ) : post.poster_url ? (
                    <img
                      src={post.poster_url}
                      alt={post.caption || "Post media"}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-white/60">
                      No media
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
