"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ModalSkeleton } from "@/components/loading/Skeletons";
import { pauseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";

const PostComposerModal = dynamic(() => import("@/components/PostComposerModal"), {
  loading: () => <ModalSkeleton kind="composer" />,
});

const tabs = [
  { id: "discover", href: "/dashboard", label: "Discover" },
  { id: "following", href: "/dashboard?tab=following", label: "Following" },
  { id: "library", href: "/library", label: "Library" },
  { id: "profile", href: "/profile", label: "Profile" },
] as const;

type MobileTab = (typeof tabs)[number]["id"];

export function currentMobileTab(pathname: string, tab: string | null): MobileTab | null {
  if (pathname === "/dashboard") return tab === "following" ? "following" : "discover";
  if (pathname === "/library") return "library";
  if (pathname === "/profile") return "profile";
  return null;
}

export default function MobileTabNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { userId, loading } = useUser();
  const supabase = useMemo(() => createClient(), []);
  const [avatar, setAvatar] = useState<{ userId: string; url: string | null } | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const activeTab = currentMobileTab(pathname, searchParams.get("tab"));
  const isTopLevel = activeTab !== null;

  useEffect(() => {
    let cancelled = false;
    if (!userId || !isTopLevel) return;
    void (async () => {
      try {
        const { data } = await supabase.from("profiles").select("avatar_url").eq("id", userId).maybeSingle();
        if (!cancelled) setAvatar({ userId, url: (data?.avatar_url as string | null) ?? null });
      } catch (error) {
        console.error("Error fetching mobile nav avatar:", error);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, userId, isTopLevel]);

  if (loading || !userId || !activeTab) return null;

  return (
    <>
      <nav aria-label="Mobile navigation" className="dashboard-feed-nav lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-black/85 backdrop-blur supports-[padding:max(0px)]:pb-[max(env(safe-area-inset-bottom),0.5rem)]">
        <div className="grid h-[52px] grid-cols-5">
          {tabs.slice(0, 2).map(({ id, href, label }) => (
            <Link key={id} href={href} aria-current={activeTab === id ? "page" : undefined}
              onClick={(event) => {
                if (activeTab === id) event.preventDefault();
                else pauseMobileFeedPlayer();
              }}
              className={`flex flex-col items-center justify-center gap-1 text-xs ${activeTab === id ? "text-white" : "text-white/60"}`}>
              {id === "discover" ? (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true"><path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.86L12 17.77l-6.18 3.23L7 14.14l-5-4.87 6.91-1.01L12 2Z" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true"><path d="M12 12a5 5 0 1 0-5-5a5 5 0 0 0 5 5zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5Z" /></svg>
              )}
              <span>{label}</span>
            </Link>
          ))}

          <button type="button" aria-label="Create post" onClick={() => setComposerOpen(true)}
            className="flex items-center justify-center text-white disabled:opacity-60">
            <span aria-hidden="true" className="inline-flex h-7 w-8 items-center justify-center rounded-[7px] border-[1.5px] border-white/90 bg-transparent text-white">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M12 6v12M6 12h12" /></svg>
            </span>
          </button>

          {tabs.slice(2).map(({ id, href, label }) => (
            <Link key={id} href={href} aria-current={activeTab === id ? "page" : undefined}
              onClick={(event) => {
                if (activeTab === id) event.preventDefault();
                else pauseMobileFeedPlayer();
              }}
              className={`flex flex-col items-center justify-center gap-1 text-xs ${activeTab === id ? "text-white" : "text-white/60"}`}>
              {id === "library" ? (
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true"><path d="M4 4h7a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4Zm9 0h7a2 2 0 0 1 2 2v14h-7V4Z" /></svg>
              ) : (
                <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border border-white/25 bg-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={(avatar?.userId === userId ? avatar.url : null) || DEFAULT_AVATAR_URL} alt="" className="avatar-image h-full w-full object-cover" />
                </span>
              )}
              <span>{label}</span>
            </Link>
          ))}
        </div>
      </nav>
      {composerOpen && <PostComposerModal onClose={() => setComposerOpen(false)} onPosted={() => {
        window.dispatchEvent(new Event("creatornet:post-created"));
        router.refresh();
      }} />}
    </>
  );
}
