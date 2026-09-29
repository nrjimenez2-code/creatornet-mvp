"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BarChart3, BookOpen, CalendarDays, CircleDollarSign, LogIn, Phone, Plus, Search, Star, UserRound } from "lucide-react";
import { ModalSkeleton } from "@/components/loading/Skeletons";
import { pauseMobileFeedPlayer } from "@/lib/mobileFeedPlayer";
import { createClient } from "@/lib/supabaseClient";
import { useUser } from "@/lib/useUser";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";
import DesktopStripeConnectBanner from "@/components/DesktopStripeConnectBanner";
import SidebarSignOutButton from "@/components/SidebarSignOutButton";

const SearchDrawer = dynamic(() => import("@/components/SearchDrawer"), { loading: () => <ModalSkeleton kind="search" /> });
const PostComposerModal = dynamic(() => import("@/components/PostComposerModal"), { loading: () => <ModalSkeleton kind="composer" /> });

const destinations = [
  { id: "discover", label: "Discover", href: "/dashboard", icon: Star },
  { id: "following", label: "Following", href: "/dashboard?tab=following", icon: UserRound },
  { id: "profile", label: "Profile", href: "/profile", icon: UserRound },
  { id: "analytics", label: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { id: "earnings", label: "Earnings", href: "/dashboard/earnings", icon: CircleDollarSign },
  { id: "library", label: "Library", href: "/library", icon: BookOpen },
  { id: "bookings", label: "Bookings", href: "/dashboard/closers", icon: Phone },
  { id: "mentorships", label: "Mentorships", href: "/memberships", icon: CalendarDays },
] as const;

type Destination = (typeof destinations)[number]["id"];

export function currentDesktopDestination(pathname: string, tab: string | null): Destination | null {
  if (pathname === "/dashboard") return tab === "following" ? "following" : "discover";
  if (pathname === "/profile") return "profile";
  if (pathname === "/dashboard/analytics") return "analytics";
  if (pathname === "/dashboard/earnings") return "earnings";
  if (pathname === "/library") return "library";
  if (pathname === "/dashboard/closers") return "bookings";
  if (pathname === "/memberships") return "mentorships";
  return null;
}

export default function DesktopNavigationShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { userId, loading: authLoading } = useUser();
  const supabase = useMemo(() => createClient(), []);
  const [avatar, setAvatar] = useState<{ userId: string; url: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const active = currentDesktopDestination(pathname, searchParams.get("tab"));

  useEffect(() => {
    let cancelled = false;
    if (!userId || !active) return;
    void (async () => {
      try {
        const { data } = await supabase.from("profiles").select("avatar_url").eq("id", userId).maybeSingle();
        if (!cancelled) setAvatar({ userId, url: (data?.avatar_url as string | null) ?? null });
      } catch (error) {
        console.error("Error fetching desktop nav avatar:", error);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, userId, active, pathname]);

  if (!active) return <>{children}</>;

  function leaveFeed() {
    if (pathname === "/dashboard") {
      pauseMobileFeedPlayer();
      document.querySelectorAll<HTMLVideoElement>(".dashboard-feed-shell video").forEach(video => video.pause());
    }
  }

  return <>
    <aside
      ref={navRef}
      aria-label="Desktop navigation"
      data-expanded={open}
      className="cn-desktop-nav"
      onMouseEnter={() => {
        if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) setOpen(true);
      }}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={(event) => {
        if (event.target !== toggleRef.current) setOpen(true);
      }}
      onBlurCapture={(event) => {
        if (!navRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !searchOpen && !composerOpen) {
          event.stopPropagation();
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <div className="cn-desktop-nav-inner">
        <button ref={toggleRef} type="button" className="cn-desktop-nav-brand" aria-label={open ? "Collapse menu" : "Expand menu"} aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="h-10 w-10 shrink-0 object-contain" />
          <span className="cn-desktop-nav-label text-[23px] tracking-tight">CreatorNet</span>
        </button>

        <button type="button" className="cn-desktop-nav-action cn-desktop-nav-create" aria-label="Create post" onClick={() => setComposerOpen(true)}>
          <Plus aria-hidden="true" size={25} />
          <span className="cn-desktop-nav-label">Create post</span>
        </button>
        <button type="button" className="cn-desktop-nav-action cn-desktop-nav-search" aria-label="Search" onClick={() => setSearchOpen(true)}>
          <Search aria-hidden="true" size={25} />
          <span className="cn-desktop-nav-label">Search</span>
        </button>

        <nav aria-label="Main destinations" className="cn-desktop-nav-links">
          {destinations.map(({ id, label, href, icon: Icon }) => {
            const selected = id === active;
            return <Link
              key={id}
              href={href}
              title={label}
              aria-label={label}
              aria-current={selected ? "page" : undefined}
              className="cn-desktop-nav-link"
              onClick={(event) => {
                if (selected) event.preventDefault();
                else leaveFeed();
              }}
            >
              {id === "profile" ? <span className="cn-desktop-nav-avatar">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={(avatar?.userId === userId ? avatar.url : null) || DEFAULT_AVATAR_URL} alt="" className="avatar-image" />
              </span> : <Icon aria-hidden="true" size={25} strokeWidth={2} />}
              <span className="cn-desktop-nav-label">{label}</span>
            </Link>;
          })}
        </nav>

        {!authLoading && userId && <div className="cn-desktop-nav-stripe">
          <button type="button" className="cn-desktop-nav-stripe-icon" aria-label="Stripe connection" onClick={() => setOpen(true)}><CircleDollarSign aria-hidden="true" size={25} /></button>
          <div className="cn-desktop-nav-stripe-panel"><DesktopStripeConnectBanner /></div>
        </div>}
        <div className="cn-desktop-nav-bottom">
          {authLoading ? null : userId ? <SidebarSignOutButton /> : <Link href="/auth" className="cn-desktop-nav-action" aria-label="Sign in"><LogIn aria-hidden="true" size={25} /><span className="cn-desktop-nav-label">Sign in</span></Link>}
        </div>
      </div>
    </aside>
    <div className="cn-desktop-nav-content">{children}</div>
    {searchOpen && <SearchDrawer open onClose={() => setSearchOpen(false)} />}
    {composerOpen && <PostComposerModal onClose={() => setComposerOpen(false)} onPosted={() => {
      window.dispatchEvent(new Event("creatornet:post-created"));
      router.refresh();
    }} />}
  </>;
}
