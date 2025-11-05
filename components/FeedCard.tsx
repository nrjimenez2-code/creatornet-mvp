"use client";

import VideoCard from "./VideoCard";

// shape used to render each item
export type AnyPost = {
  id?: string | number;
  src: string;
  poster?: string;
  creator?: string;
  caption?: string;
  hashtags?: string;
  likes?: number | string;
  comments?: number | string;
  shares?: number | string;
  ctaLabel?: string;
  onCta?: () => void;
};

export default function FeedList({
  posts = [],
  refreshKey,
}: {
  posts?: AnyPost[];
  refreshKey?: number;
}) {
  return (
    <div key={refreshKey}>
      {posts.map((p: AnyPost, i: number) => {
        const src = p.src;
        const poster = p.poster;
        const creator = p.creator ?? "creator";
        const caption = p.caption ?? "Quick tip goes here";
        const hashtags = p.hashtags ?? "#learn #build";
        const likes = p.likes ?? "0";
        const comments = p.comments ?? 0;
        const shares = p.shares ?? 0;

        return (
          <div key={p.id ?? i} className="snap-start mb-10">
            <VideoCard
              src={src}
              poster={poster}
              creator={creator}
              caption={caption}
              hashtags={hashtags}
              likes={likes}
              comments={comments}
              shares={shares}
              ctaLabel={p.ctaLabel ?? "Buy or Book"}
              onCta={p.onCta}
            />
          </div>
        );
      })}
    </div>
  );
}
