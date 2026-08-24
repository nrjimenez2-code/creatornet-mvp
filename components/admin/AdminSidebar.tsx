"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAdminData } from "@/components/admin/AdminDataContext";
import { OPEN_PALETTE_EVENT } from "@/components/admin/CommandPalette";
import {
  IconCard,
  IconGrid,
  IconPlaySquare,
  IconSearch,
  IconUsers,
} from "@/components/admin/icons";
import type { ReactNode } from "react";

interface NavItem {
  href: string;
  label: string;
  exact: boolean;
  icon: ReactNode;
  showFlagCount?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/admin", label: "Overview", exact: true, icon: <IconGrid size={17} /> },
  { href: "/admin/users", label: "Users & Creators", exact: false, icon: <IconUsers size={17} /> },
  {
    href: "/admin/content",
    label: "Content",
    exact: false,
    icon: <IconPlaySquare size={17} />,
    showFlagCount: true,
  },
  { href: "/admin/commerce", label: "Commerce", exact: false, icon: <IconCard size={17} /> },
];

function openPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT));
}

/** Brand mark — gradient tile with the CreatorNet play glyph. */
function BrandMark() {
  return (
    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#9370DB] to-[#6b4fae] shadow-[0_4px_12px_rgba(109,78,182,0.4)]">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="white" aria-hidden="true">
        <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.54-6.86a1.04 1.04 0 0 0 0-1.76L9.56 4.26A1.04 1.04 0 0 0 8 5.14Z" />
      </svg>
    </span>
  );
}

export function AdminSidebar() {
  const pathname = usePathname();
  const { stats } = useAdminData();

  return (
    <aside className="sticky top-0 flex h-svh w-64 shrink-0 flex-col border-r border-[#e9e3f7] bg-white/80 backdrop-blur-sm max-md:static max-md:h-auto max-md:w-full max-md:flex-row max-md:items-center max-md:gap-3 max-md:border-r-0 max-md:border-b max-md:px-4 max-md:py-3">
      {/* Brand */}
      <div className="px-5 pt-6 max-md:p-0">
        <Link
          href="/admin"
          className="flex items-center gap-3 rounded-xl focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <BrandMark />
          <span className="max-md:hidden">
            <span className="block text-[15px] leading-tight font-black tracking-wide text-zinc-900">
              CREATORNET
            </span>
            <span className="block text-[11px] font-semibold text-[#9370DB]">
              Admin · Launch Board
            </span>
          </span>
        </Link>
      </div>

      {/* Search trigger */}
      <div className="mt-5 px-3 max-md:mt-0 max-md:ml-auto max-md:px-0">
        <button
          type="button"
          onClick={openPalette}
          className="flex w-full items-center gap-2.5 rounded-xl border border-[#e5ddf5] bg-white/70 px-3 py-2 text-sm text-gray-400 transition hover:border-[#d5c8ef] hover:bg-[#f8f5ff] hover:text-gray-500 focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:outline-none max-md:w-auto max-md:border-0 max-md:bg-transparent max-md:p-2"
        >
          <IconSearch size={15} />
          <span className="flex-1 text-left max-md:hidden">Search…</span>
          <kbd className="rounded-md border border-[#e5ddf5] bg-[#faf8ff] px-1.5 py-0.5 text-[10px] font-bold text-gray-400 max-md:hidden">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Nav */}
      <nav
        aria-label="Admin navigation"
        className="mt-5 flex flex-col gap-1 px-3 max-md:mt-0 max-md:flex-row max-md:gap-1 max-md:overflow-x-auto max-md:px-0"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all duration-150 focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:outline-none max-md:whitespace-nowrap ${
                isActive
                  ? "bg-gradient-to-br from-[#9370DB] to-[#7c5cbf] text-white shadow-[0_4px_14px_rgba(109,78,182,0.35)]"
                  : "text-gray-600 hover:bg-[#f5f2fc] hover:text-zinc-900"
              }`}
            >
              <span className={isActive ? "text-white" : "text-[#9370DB]/70"}>
                {item.icon}
              </span>
              <span className="flex-1 max-md:hidden">{item.label}</span>
              {item.showFlagCount && stats.flaggedCount > 0 ? (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${
                    isActive ? "bg-white/25 text-white" : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {stats.flaggedCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      {/* Bottom: environment + operator */}
      <div className="mt-auto flex flex-col gap-3 px-4 pb-5 max-md:hidden">
        <div className="flex items-center gap-2 rounded-xl border border-amber-200/70 bg-amber-50/70 px-3 py-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full bg-amber-400 motion-safe:animate-[softPulse_2s_ease-in-out_infinite]"
          />
          <p className="text-[11px] leading-tight font-semibold text-amber-800">
            Stripe test mode
            <span className="block font-normal text-amber-700/80">
              demo data · session-only actions
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2.5 rounded-xl border border-[#e9e3f7] bg-white/70 px-3 py-2.5">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#9370DB] to-[#6b4fae] text-[11px] font-bold text-white">
            LT
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-bold text-zinc-900">Landon Thomas</p>
            <p className="text-[11px] text-gray-400">Administrator</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
