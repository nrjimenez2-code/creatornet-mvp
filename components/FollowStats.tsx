// components/FollowStats.tsx — the posts / followers / following stat row.
// Followers and following are buttons that open the paginated list.
"use client";

import { useState } from "react";
import FollowListModal, { type FollowListType } from "./FollowListModal";

type FollowStatsProps = {
  userId: string;
  postsCount: number;
  followersCount: number;
  followingCount: number;
};

const CELL = "flex flex-col items-center gap-1 text-center min-w-[70px]";
const CELL_BUTTON = `${CELL} rounded-lg px-2 py-1 -my-1 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 transition`;
const NUMBER = "text-lg font-semibold text-white";
const LABEL = "text-xs sm:text-sm";

const TITLES: Record<FollowListType, string> = { followers: "Followers", following: "Following" };

export default function FollowStats({ userId, postsCount, followersCount, followingCount }: FollowStatsProps) {
  const [openList, setOpenList] = useState<FollowListType | null>(null);
  const listType: FollowListType = openList ?? "followers";

  return (
    <div className="mt-6 w-full max-w-2xl px-4">
      <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 md:gap-10 text-sm text-white/80">
        <div className={CELL}>
          <span className={NUMBER}>{postsCount}</span>
          <span className={LABEL}>posts</span>
        </div>
        <button type="button" onClick={() => setOpenList("followers")} className={CELL_BUTTON} aria-haspopup="dialog">
          <span className={NUMBER}>{followersCount}</span>
          <span className={LABEL}>followers</span>
        </button>
        <button type="button" onClick={() => setOpenList("following")} className={CELL_BUTTON} aria-haspopup="dialog">
          <span className={NUMBER}>{followingCount}</span>
          <span className={LABEL}>following</span>
        </button>
      </div>

      {/* key remounts the modal per open, so every open starts from a fresh list */}
      <FollowListModal
        key={openList ?? "closed"}
        userId={userId}
        type={listType}
        open={openList !== null}
        onClose={() => setOpenList(null)}
        title={TITLES[listType]}
      />
    </div>
  );
}
