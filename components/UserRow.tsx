// components/UserRow.tsx — one person in a list (followers, following).
// Markup lifted from the file-local CreatorCard in app/search/page.tsx.
"use client";

import Link from "next/link";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";

export type UserRowUser = {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  /** False when no public.profiles row exists — the account never finished
   *  onboarding. Absent on older callers, which are all real profiles. */
  has_profile?: boolean;
};

/** /creators/<username> when there is one, else /creators/<id>; the page resolves both. */
export function userProfileHref(user: Pick<UserRowUser, "id" | "username">): string {
  const slug = user.username && user.username.length > 0 ? user.username : user.id;
  return `/creators/${encodeURIComponent(slug)}`;
}

type UserRowProps = {
  user: UserRowUser;
  /** Fired when the row is followed (e.g. so a modal can close). */
  onNavigate?: () => void;
};

export default function UserRow({ user, onNavigate }: UserRowProps) {
  // A follow whose account never finished onboarding has no profile page. It
  // still belongs in the list (the follower count includes it), but linking it
  // sends the visitor to a 404, so it renders as plain, non-interactive text.
  if (user.has_profile === false) {
    return (
      <div className="rounded-xl border border-white/10 p-3 flex items-center gap-3 opacity-60">
        <div className="h-10 w-10 shrink-0 rounded-full bg-white/10 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={DEFAULT_AVATAR_URL} alt="" className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0">
          <div className="font-medium truncate text-white/70">Account not set up</div>
          <div className="text-xs text-white/40 truncate">This person has not finished their profile</div>
        </div>
      </div>
    );
  }

  return (
    <Link
      href={userProfileHref(user)}
      onClick={onNavigate}
      className="rounded-xl border border-white/10 p-3 hover:bg-white/5 flex items-center gap-3"
    >
      <div className="h-10 w-10 shrink-0 rounded-full bg-white/10 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={user.avatar_url || DEFAULT_AVATAR_URL} alt="" className="h-full w-full object-cover" />
      </div>
      <div className="min-w-0">
        <div className="font-medium truncate text-white">@{user.username || "creator"}</div>
        {user.full_name ? (
          <div className="text-xs text-white/60 truncate">{user.full_name}</div>
        ) : null}
      </div>
    </Link>
  );
}
