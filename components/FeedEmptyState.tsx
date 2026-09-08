"use client";

import Link from "next/link";
import type { FeedTab } from "@/lib/feedV3";

type Props = {
  tab: FeedTab;
  signedIn: boolean;
  /** Switches the feed to the Discover tab (no navigation). */
  onBrowseDiscover: () => void;
};

/**
 * The feed's legitimate-empty state. Three cases, each with a real next
 * action. Before this, a single "No posts yet." line covered all of them —
 * including the Following tab for a signed-out visitor, where it was simply
 * untrue (FeedList never runs the RPC without a session).
 *
 * Visual language mirrors FeedList's own error block so the two read as one
 * system; the sign-in CTA is the app purple.
 */
export default function FeedEmptyState({ tab, signedIn, onBrowseDiscover }: Props) {
  if (tab === "following" && !signedIn) {
    return (
      <>
        <p className="text-sm text-gray-300 font-medium mb-1">
          Sign in to see posts from creators you follow
        </p>
        <p className="text-xs text-gray-500 max-w-md mb-3">
          Your Following feed is built from the creators you follow.
        </p>
        <Link
          href="/auth"
          className="rounded-full bg-[#4A35C7] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[#3D2BA3] transition-colors"
        >
          Sign in
        </Link>
      </>
    );
  }

  if (tab === "following") {
    return (
      <>
        {/* Zero rows does NOT mean zero follows: the Following branch of
            get_feed_v3 joins follows and then filters out hidden, removed and
            media-less posts, so someone who follows five creators with nothing
            visible lands here too. Verified on production: 7 of 8 accounts that
            follow somebody get zero rows. Say only what is true in both cases. */}
        <p className="text-sm text-gray-300 font-medium mb-1">
          Nothing new from creators you follow
        </p>
        <p className="text-xs text-gray-500 max-w-md mb-3">
          Follow more creators from Discover and their posts will show up here.
        </p>
        <button
          type="button"
          onClick={onBrowseDiscover}
          className="rounded-full border border-gray-700 px-4 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-900 transition-colors"
        >
          Browse Discover
        </button>
      </>
    );
  }

  return (
    <>
      <p className="text-sm text-gray-300 font-medium mb-1">No posts yet</p>
      <p className="text-xs text-gray-500 max-w-md">
        Creators are just getting started — check back soon.
      </p>
    </>
  );
}
