"use client";

import { useEffect, useRef } from "react";
import { User, Heart, MessageCircle, Share2, ShoppingBag } from "lucide-react";

type PostForCard = {
  id: string;
  user_id: string | null;
  caption: string;
  video_url: string;
  poster_url: string | null;
  created_at: string;
};

type VideoCardProps = {
  post: PostForCard;
  active?: boolean;               // parent (FeedList) controls which one plays
  initialLikes?: number;
  initiallyLiked?: boolean;
  onLikeToggled?: (liked: boolean) => void;
};

export default function VideoCard({
  post,
  active = false,
}: VideoCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Play/pause based on 'active'
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (active) v.play().catch(() => {});
    else v.pause();
  }, [active]);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-black">
      {/* VIDEO - always contain to prevent cropping/zoom */}
      <video
        ref={videoRef}
        src={post.video_url}
        poster={post.poster_url ?? undefined}
        playsInline
        muted
        loop
        // object-contain guarantees no zoom-in crop; shows black bars when needed
        className="h-full w-full object-contain object-center bg-black"
      />

      {/* RIGHT ACTIONS */}
      <div className="absolute right-3 bottom-32 z-30 flex flex-col items-center gap-6 text-white/95">
        {/* Profile bubble */}
        <div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 backdrop-blur-sm grid place-items-center">
          <User className="w-6 h-6" />
        </div>
        {/* Like */}
        <div className="flex flex-col items-center gap-1">
          <Heart className="w-8 h-8" />
          <span className="text-xs font-semibold opacity-90">0</span>
        </div>
        {/* Comment */}
        <div className="flex flex-col items-center gap-1">
          <MessageCircle className="w-8 h-8" />
          <span className="text-xs font-semibold opacity-90">120</span>
        </div>
        {/* Share */}
        <div className="flex flex-col items-center gap-1">
          <Share2 className="w-7 h-7" />
          <span className="text-xs font-semibold opacity-90">3.0k</span>
        </div>
      </div>

      {/* LEFT CAPTION + CTA */}
      <div className="absolute left-4 bottom-32 z-30 max-w-[75%] text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
        <button className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 backdrop-blur-md border border-white/20">
          <ShoppingBag className="w-4 h-4" />
          <span className="text-sm font-medium">Buy or Book</span>
        </button>

        <div className="text-[15px] font-semibold mb-1">
          @{post.user_id ?? "unknown_user"}
        </div>
        <div className="text-sm text-white/90 leading-snug">
          {post.caption}
        </div>
      </div>
    </div>
  );
}
