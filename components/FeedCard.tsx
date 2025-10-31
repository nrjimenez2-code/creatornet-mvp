"use client";

import React, { useMemo, useState } from "react";
import { User, Heart, MessageCircle, Share2, ShoppingBag } from "lucide-react";

type FeedCardProps = {
  username?: string;
  caption?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  /** Public URL to .mp4 (or leave empty to show only poster) */
  videoUrl?: string;
  /** Public URL to thumbnail/poster image */
  posterUrl?: string;
  /** Optional: category tag for the CTA (e.g., “Buy or Book”) */
  ctaText?: string;
  /** Event hooks (optional) */
  onLike?: (liked: boolean) => void;
  onComment?: () => void;
  onShare?: () => void;
};

export default function FeedCard({
  username = "name",
  caption = "caption / #hashtags",
  likes = 45300,
  comments = 12,
  shares = 3254,
  videoUrl,
  posterUrl,
  ctaText = "Buy or Book",
  onLike,
  onComment,
  onShare,
}: FeedCardProps) {
  const [liked, setLiked] = useState(false);

  const likeCount = useMemo(() => (liked ? likes + 1 : likes), [liked, likes]);
  const fmt = (n: number) =>
    n >= 1000000 ? `${(n / 1_000_000).toFixed(1)}m` :
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` :
    `${n}`;

  function toggleLike() {
    const next = !liked;
    setLiked(next);
    onLike?.(next);
  }

  return (
    <div className="relative w-full h-screen max-w-[430px] mx-auto overflow-hidden bg-black">
      {/* Media */}
      <div className="absolute inset-0">
        {videoUrl ? (
          <video
            className="h-full w-full object-cover"
            src={videoUrl}
            poster={posterUrl}
            playsInline
            muted
            loop
            autoPlay
          />
        ) : posterUrl ? (
          <img
            className="h-full w-full object-cover"
            src={posterUrl}
            alt="post"
          />
        ) : (
          <div className="h-full w-full bg-gray-900" />
        )}
      </div>

      {/* Gradient overlay for text legibility */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/70 to-transparent" />

      {/* Right-side vertical actions */}
      <div className="absolute right-3 bottom-28 flex flex-col items-center gap-6 z-20">
        {/* Profile */}
        <div className="w-12 h-12 rounded-full bg-black/60 backdrop-blur flex items-center justify-center border border-white/20">
          <User size={24} className="text-white" />
        </div>

        {/* Like */}
        <button
          aria-label="Like"
          onClick={toggleLike}
          className="flex flex-col items-center gap-1 text-white"
        >
          <Heart
            size={30}
            strokeWidth={1.8}
            className={liked ? "fill-red-500 stroke-red-500" : ""}
          />
          <span className="text-xs font-semibold">{fmt(likeCount)}</span>
        </button>

        {/* Comment */}
        <button
          aria-label="Comment"
          onClick={onComment}
          className="flex flex-col items-center gap-1 text-white"
        >
          <MessageCircle size={30} strokeWidth={1.8} />
          <span className="text-xs font-semibold">{fmt(comments)}</span>
        </button>

        {/* Share */}
        <button
          aria-label="Share"
          onClick={onShare}
          className="flex flex-col items-center gap-1 text-white"
        >
          <Share2 size={28} strokeWidth={1.8} />
          <span className="text-xs font-semibold">{fmt(shares)}</span>
        </button>
      </div>

      {/* Bottom-left info + CTA */}
      <div className="absolute left-4 bottom-28 z-20 text-white max-w-[70%]">
        <button className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/20 backdrop-blur px-4 py-2 text-sm font-medium hover:bg-white/25 transition">
          <ShoppingBag size={18} />
          <span>{ctaText}</span>
        </button>

        <div className="text-[15px] font-semibold mb-1 drop-shadow">
          {username}
        </div>
        <div className="text-sm text-white/90 leading-snug line-clamp-3">
          {caption}
        </div>
      </div>
    </div>
  );
}
