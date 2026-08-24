"use client";

import { Suspense, useState, type MouseEvent } from "react";
import { useSearchParams } from "next/navigation";
import type { AdminVideo, VideoStatus } from "@/types/admin";
import { formatCents, formatCompact } from "@/lib/admin/format";
import { useAdminData } from "@/components/admin/AdminDataContext";
import { TimeAgo } from "@/components/admin/TimeAgo";
import { Drawer } from "@/components/admin/Drawer";
import {
  ActionButton,
  COUNT_CHIP_CLASS,
  EmptyState,
  FilterPill,
  MICRO_HEADING_CLASS,
  PageHeader,
  Panel,
  ROW_HOVER_CLASS,
  SearchInput,
  StatusBadge,
  TH_CLASS,
  VideoThumb,
} from "@/components/admin/ui";
import {
  IconCheck,
  IconEyeOff,
  IconFlag,
  IconTrash,
} from "@/components/admin/icons";

type StatusFilter = "all" | VideoStatus;

const FILTER_OPTIONS: ReadonlyArray<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "live", label: "Live" },
  { key: "flagged", label: "Flagged" },
  { key: "hidden", label: "Hidden" },
  { key: "removed", label: "Removed" },
];

const BOOK_CHIP_CLASS =
  "rounded-full bg-[#f3eefc] px-1.5 text-[11px] font-bold text-[#7c5cbf]";

/** Wraps an action so button clicks never bubble to row (drawer-open) or page (disarm). */
function stopThen(action: () => void) {
  return (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    action();
  };
}

interface RemoveButtonProps {
  videoId: string;
  isArmed: boolean;
  onRequest: (id: string) => void;
  onConfirm: (id: string) => void;
}

/** Two-step destructive control: first click arms, second click removes. */
function RemoveButton({ videoId, isArmed, onRequest, onConfirm }: RemoveButtonProps) {
  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    // Keep the click from bubbling to the page wrapper (which disarms pending
    // state) or to the row (which would open the drawer).
    event.stopPropagation();
    if (isArmed) {
      onConfirm(videoId);
    } else {
      onRequest(videoId);
    }
  }

  return (
    <ActionButton
      variant="danger"
      armed={isArmed}
      onClick={handleClick}
      title={isArmed ? "Click again to permanently remove" : "Remove video"}
    >
      <IconTrash size={13} />
      {isArmed ? "Confirm remove" : "Remove"}
    </ActionButton>
  );
}

interface VideoDrawerProps {
  video: AdminVideo | null;
  onClose: () => void;
  onApprove: (id: string) => void;
  onHide: (id: string) => void;
  onUnhide: (id: string) => void;
  onRemove: (id: string) => void;
}

/** Right slide-over with full video detail + status-appropriate moderation actions. */
function VideoDrawer({
  video,
  onClose,
  onApprove,
  onHide,
  onUnhide,
  onRemove,
}: VideoDrawerProps) {
  // The call site keys this component by the selected video id, so a stale
  // "Confirm remove" can never carry over to a different video.
  const [isRemoveArmed, setIsRemoveArmed] = useState(false);

  // Any non-destructive action also disarms: a status change (e.g. flagged →
  // hidden) keeps the same video id, so the keyed remount alone wouldn't reset.
  const runAction = (action: (id: string) => void, id: string) =>
    stopThen(() => {
      setIsRemoveArmed(false);
      action(id);
    });

  const metrics: ReadonlyArray<{ label: string; value: number }> = video
    ? [
        { label: "Views", value: video.viewCount },
        { label: "Likes", value: video.likeCount },
        { label: "Comments", value: video.commentCount },
        { label: "Shares", value: video.shareCount },
      ]
    : [];

  return (
    <Drawer
      open={video !== null}
      onClose={onClose}
      title={video ? `Video details — ${video.title}` : "Video details"}
    >
      {video ? (
        <>
          <div className="relative flex items-end gap-4 bg-gradient-to-br from-[#9370DB] to-[#6b4fae] px-6 pt-14 pb-6">
            <VideoThumb id={video.id} size={84} />
            <div className="min-w-0">
              <p className="text-lg leading-snug font-black text-white">{video.title}</p>
              <p className="text-sm text-white/70">@{video.creatorUsername}</p>
              <div className="mt-2">
                <StatusBadge status={video.status} />
              </div>
            </div>
          </div>

          {/* Clicking anywhere in the body outside the armed Remove disarms it. */}
          <div className="space-y-5 px-6 py-5" onClick={() => setIsRemoveArmed(false)}>
            <div className="grid grid-cols-4 gap-2 text-center">
              {metrics.map((metric) => (
                <div key={metric.label}>
                  <p className="text-base font-black text-zinc-900 tabular-nums">
                    {formatCompact(metric.value)}
                  </p>
                  <p className={MICRO_HEADING_CLASS}>{metric.label}</p>
                </div>
              ))}
            </div>

            {/* INTEGRATION: posts.price_cents / posts.allow_booking */}
            <div className="rounded-xl border border-[#e9e3f7] p-4">
              <p className={MICRO_HEADING_CLASS}>Offer</p>
              {video.priceCents !== null ? (
                <p className="mt-1.5 font-bold text-zinc-900 tabular-nums">
                  Buy · {formatCents(video.priceCents)}
                </p>
              ) : null}
              {video.allowBooking ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-sm text-gray-600">
                  <span className={BOOK_CHIP_CLASS}>Book</span>
                  1:1 booking enabled
                </p>
              ) : null}
              {video.priceCents === null && !video.allowBooking ? (
                <p className="mt-1.5 text-sm text-gray-400">Free content</p>
              ) : null}
            </div>

            <div>
              <div className="flex flex-wrap gap-1.5">
                {video.hashtags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-[#f3eefc] px-2.5 py-1 text-xs font-semibold text-[#7c5cbf]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-400">
                Uploaded <TimeAgo iso={video.createdAt} />
              </p>
            </div>

            {video.flagReason ? (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-800">
                <span className="mt-0.5 shrink-0 text-amber-600">
                  <IconFlag size={13} />
                </span>
                {video.flagReason}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5 border-t border-[#f0ebfb] pt-4">
              {video.status === "flagged" ? (
                <>
                  <ActionButton variant="approve" onClick={runAction(onApprove, video.id)}>
                    <IconCheck size={13} />
                    Approve
                  </ActionButton>
                  <ActionButton variant="neutral" onClick={runAction(onHide, video.id)}>
                    <IconEyeOff size={13} />
                    Hide
                  </ActionButton>
                </>
              ) : null}
              {video.status === "live" ? (
                <ActionButton variant="neutral" onClick={runAction(onHide, video.id)}>
                  <IconEyeOff size={13} />
                  Hide
                </ActionButton>
              ) : null}
              {video.status === "hidden" ? (
                <ActionButton variant="neutral" onClick={runAction(onUnhide, video.id)}>
                  <IconCheck size={13} />
                  Unhide
                </ActionButton>
              ) : null}
              {video.status === "flagged" || video.status === "hidden" ? (
                <RemoveButton
                  videoId={video.id}
                  isArmed={isRemoveArmed}
                  onRequest={() => setIsRemoveArmed(true)}
                  onConfirm={(id) => {
                    onRemove(id);
                    setIsRemoveArmed(false);
                  }}
                />
              ) : null}
              {video.status === "removed" ? (
                <p className="text-xs text-gray-400">
                  Removed from the platform. Stored file retained pending purge policy.
                </p>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </Drawer>
  );
}

function ContentPageInner({ initialQuery }: { initialQuery: string }) {
  // Shared session store — mutations propagate to the sidebar badge and
  // Overview page and survive navigation. INTEGRATION notes live in
  // AdminDataContext.tsx (each action maps to a POST /api/admin/* route).
  const {
    videos,
    approveVideo: approveAction,
    hideVideo: hideAction,
    unhideVideo: unhideAction,
    removeVideo,
  } = useAdminData();
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Live lookup so the open drawer reflects moderation actions instantly.
  const selected = videos.find((video) => video.id === selectedId) ?? null;

  // Every status change or list reshuffle disarms the pending remove confirm,
  // so a stale "Confirm remove" can never resurface armed.
  const approveVideo = (id: string) => {
    approveAction(id);
    setPendingRemoveId(null);
  };

  const hideVideo = (id: string) => {
    hideAction(id);
    setPendingRemoveId(null);
  };

  const unhideVideo = (id: string) => {
    unhideAction(id);
    setPendingRemoveId(null);
  };

  const requestRemove = (id: string) => setPendingRemoveId(id);

  const confirmRemove = (id: string) => {
    removeVideo(id);
    setPendingRemoveId(null);
  };

  const handleQueryChange = (next: string) => {
    setPendingRemoveId(null);
    setQuery(next);
  };

  const handleFilterChange = (key: StatusFilter) => {
    setPendingRemoveId(null);
    setFilter(key);
  };

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (video: AdminVideo): boolean => {
    if (normalizedQuery === "") return true;
    return [video.title, video.creatorUsername, video.creatorName, ...video.hashtags]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  };

  // Counts and rows both respect the active search, so the pills always
  // describe what the table can actually show (matches the Users page).
  const searched = videos.filter(matchesQuery);
  const filtered = searched.filter(
    (video) => filter === "all" || video.status === filter,
  );
  const flagged = videos.filter((video) => video.status === "flagged");
  const countFor = (key: StatusFilter): number =>
    key === "all"
      ? searched.length
      : searched.filter((video) => video.status === key).length;

  return (
    // Clicking anywhere outside an armed Remove button disarms it (the button
    // itself stops propagation) — same guard as the Users page ban flow.
    <div
      onClick={() => setPendingRemoveId(null)}
      className="motion-safe:animate-[pageIn_0.35s_ease-out]"
    >
      <PageHeader
        title="Content"
        subtitle="Review flagged uploads and keep the feed clean before launch."
      />

      {flagged.length > 0 ? (
        <div className="mb-6">
          <Panel
            title="Moderation queue"
            tinted
            action={
              <span className={COUNT_CHIP_CLASS}>{flagged.length} waiting</span>
            }
          >
            <ul className="divide-y divide-[#f0ebfb]">
              {flagged.map((video) => (
                <li
                  key={video.id}
                  onClick={() => setSelectedId(video.id)}
                  className={`flex cursor-pointer flex-wrap items-center gap-4 px-5 py-4 ${ROW_HOVER_CLASS}`}
                >
                  <VideoThumb id={video.id} size={56} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-zinc-900">{video.title}</p>
                    <p className="text-xs text-gray-400">
                      @{video.creatorUsername} · {formatCompact(video.viewCount)} views
                    </p>
                    {video.flagReason ? (
                      <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700">
                        <IconFlag size={12} />
                        {video.flagReason}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ActionButton
                      variant="approve"
                      onClick={stopThen(() => approveVideo(video.id))}
                    >
                      <IconCheck size={13} />
                      Approve
                    </ActionButton>
                    <ActionButton
                      variant="neutral"
                      onClick={stopThen(() => hideVideo(video.id))}
                    >
                      <IconEyeOff size={13} />
                      Hide
                    </ActionButton>
                    <RemoveButton
                      videoId={video.id}
                      isArmed={pendingRemoveId === video.id}
                      onRequest={requestRemove}
                      onConfirm={confirmRemove}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput
          value={query}
          onChange={handleQueryChange}
          placeholder="Search title, creator, or hashtag…"
        />
        <div className="flex flex-wrap items-center gap-2">
          {FILTER_OPTIONS.map((option) => (
            <FilterPill
              key={option.key}
              label={option.label}
              isActive={filter === option.key}
              count={countFor(option.key)}
              onClick={() => handleFilterChange(option.key)}
            />
          ))}
        </div>
      </div>

      <p className="mb-2 text-xs text-gray-400">
        {filtered.length} {filtered.length === 1 ? "video" : "videos"}
      </p>

      {filtered.length === 0 ? (
        <EmptyState message="No videos match your search." />
      ) : (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#f0ebfb]">
                  <th className={`${TH_CLASS} pl-5`}>Video</th>
                  <th className={TH_CLASS}>Offer</th>
                  <th className={TH_CLASS}>Views</th>
                  <th className={TH_CLASS}>Likes</th>
                  <th className={TH_CLASS}>Comments</th>
                  <th className={TH_CLASS}>Uploaded</th>
                  <th className={TH_CLASS}>Status</th>
                  <th className={TH_CLASS}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ebfb]">
                {filtered.map((video) => (
                  <tr
                    key={video.id}
                    onClick={() => setSelectedId(video.id)}
                    className={`cursor-pointer ${ROW_HOVER_CLASS}`}
                  >
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <VideoThumb id={video.id} />
                        <div className="min-w-0">
                          <p
                            className={`font-semibold ${
                              video.status === "removed"
                                ? "text-gray-400 line-through"
                                : "text-zinc-900"
                            }`}
                          >
                            {video.title}
                          </p>
                          <p className="text-xs text-gray-400">@{video.creatorUsername}</p>
                          {video.flagReason ? (
                            <p className="text-xs text-amber-700">{video.flagReason}</p>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {video.priceCents !== null ? (
                        <span className="font-semibold text-zinc-900 tabular-nums">
                          {formatCents(video.priceCents)}
                        </span>
                      ) : (
                        <span className="text-gray-400">Free</span>
                      )}
                      {video.allowBooking ? (
                        <span className={`ml-1 ${BOOK_CHIP_CLASS}`}>Book</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-gray-600 tabular-nums">
                      {formatCompact(video.viewCount)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 tabular-nums">
                      {formatCompact(video.likeCount)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 tabular-nums">
                      {formatCompact(video.commentCount)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-400">
                      <TimeAgo iso={video.createdAt} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={video.status} />
                    </td>
                    <td className="px-4 py-3">
                      {video.status === "removed" ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          {video.status === "hidden" ? (
                            <ActionButton
                              variant="neutral"
                              onClick={stopThen(() => unhideVideo(video.id))}
                            >
                              <IconCheck size={13} />
                              Unhide
                            </ActionButton>
                          ) : (
                            <ActionButton
                              variant="neutral"
                              onClick={stopThen(() => hideVideo(video.id))}
                            >
                              <IconEyeOff size={13} />
                              Hide
                            </ActionButton>
                          )}
                          {video.status !== "live" ? (
                            <RemoveButton
                              videoId={video.id}
                              isArmed={pendingRemoveId === video.id}
                              onRequest={requestRemove}
                              onConfirm={confirmRemove}
                            />
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <VideoDrawer
        key={selectedId ?? "closed"}
        video={selected}
        onClose={() => setSelectedId(null)}
        onApprove={approveVideo}
        onHide={hideVideo}
        onUnhide={unhideVideo}
        onRemove={confirmRemove}
      />
    </div>
  );
}

/**
 * Deep-link support: the command palette navigates here with ?q=<term>.
 * Keying the page content on the param seeds the search state fresh on every
 * palette jump without any URL→state sync effect.
 */
function ContentFromQuery() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  return <ContentPageInner key={initialQuery} initialQuery={initialQuery} />;
}

// useSearchParams requires a Suspense boundary in the App Router.
export function ContentPageClient() {
  return (
    <Suspense fallback={null}>
      <ContentFromQuery />
    </Suspense>
  );
}
