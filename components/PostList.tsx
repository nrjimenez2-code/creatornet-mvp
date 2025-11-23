"use client";

import VideoCard from "./VideoCard";

type AnyPost = Record<string, any>;

export default function PostList({
  items,
}: {
  items: AnyPost[];
}) {
  if (!items?.length) {
    return (
      <div className="py-10 text-center text-sm text-gray-500">
        No posts yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {items.map((p: AnyPost, i: number) => {
        const src =
          p.src ?? p.videoUrl ?? p.video_url ?? p.url ?? p.media_url ?? "";
        const poster =
          p.poster ?? p.thumbnail ?? p.thumb ?? p.thumbnail_url ?? undefined;
        const creator =
          p.creator ?? p.username ?? p.author ?? p.author_name ?? "creator";
        const caption = p.caption ?? p.title ?? "";
        const hashtags = Array.isArray(p.hashtags)
          ? p.hashtags.map((h: string) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
          : (p.hashtags ?? "");
        const likes = p.likes ?? p.likeCount ?? p.likes_count ?? 0;
        const comments =
          p.comments ?? p.commentCount ?? p.comments_count ?? 0;
        const shares = p.shares ?? p.shareCount ?? p.shares_count ?? 0;
        const creatorId =
          p.creatorId ??
          p.creator_id ??
          p.profileId ??
          null;

        return (
          <VideoCard
            key={p.id ?? i}
            src={src}
            poster={poster}
            creator={creator}
            caption={caption}
            hashtags={hashtags}
            likes={likes}
            comments={comments}
            shares={shares}
            creatorId={creatorId}
            ctaLabel={p.ctaLabel ?? "Buy or Book"}
            onCta={p.onCta}
          />
        );
      })}
    </div>
  );
}
