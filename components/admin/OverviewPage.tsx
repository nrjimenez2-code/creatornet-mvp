"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { ActivityEvent, ActivityKind, PlatformStats } from "@/types/admin";
import { formatCents, formatCompact } from "@/lib/admin/format";
import { accumulate, dailyTotals, dayLabels } from "@/lib/admin/series";
import { useAdminData } from "@/components/admin/AdminDataContext";
import { TimeAgo } from "@/components/admin/TimeAgo";
import { DonutRing, Sparkline, TrendChart } from "@/components/admin/charts";
import {
  IconAlert,
  IconArrowRight,
  IconBolt,
  IconCalendar,
  IconCard,
  IconCheckCircle,
  IconDollar,
  IconFlag,
  IconPlaySquare,
  IconStar,
  IconUserPlus,
  IconUsers,
} from "@/components/admin/icons";
import {
  Avatar,
  COUNT_CHIP_CLASS,
  EmptyState,
  PageHeader,
  Panel,
  StatCard,
  VideoThumb,
} from "@/components/admin/ui";

/** 32px tinted icon chip per activity kind — replaces the old colored dots. */
const ACTIVITY_CHIPS: Record<ActivityKind, { chipClass: string; icon: ReactNode }> = {
  purchase: { chipClass: "bg-emerald-50 text-emerald-600", icon: <IconDollar size={15} /> },
  upload: { chipClass: "bg-[#f3eefc] text-[#7c5cbf]", icon: <IconPlaySquare size={15} /> },
  booking: { chipClass: "bg-blue-50 text-blue-600", icon: <IconCalendar size={15} /> },
  signup: { chipClass: "bg-gray-100 text-gray-500", icon: <IconUserPlus size={15} /> },
  flag: { chipClass: "bg-amber-50 text-amber-600", icon: <IconFlag size={15} /> },
  stripe_connect: { chipClass: "bg-emerald-50 text-emerald-600", icon: <IconBolt size={15} /> },
};

const MENTION_PATTERN = /(@[a-z0-9_]+)/gi;

type ChecklistState = "done" | "warn" | "todo";

const CHECKLIST_SCORES: Record<ChecklistState, number> = {
  done: 1,
  warn: 0.5,
  todo: 0,
};

interface ChecklistItem {
  label: string;
  hint: string;
  state: ChecklistState;
}

function buildLaunchChecklist(stats: PlatformStats): ChecklistItem[] {
  return [
    { label: "Admin board online", hint: "You're looking at it", state: "done" },
    {
      label: "Flagged queue clear",
      hint:
        stats.flaggedCount > 0
          ? `${stats.flaggedCount} items still awaiting review`
          : "All clear",
      state: stats.flaggedCount > 0 ? "warn" : "done",
    },
    { label: "Stripe in LIVE mode", hint: "still test mode", state: "warn" },
    {
      label: "50+ creators onboarded",
      hint: `${stats.totalCreators} of 50 so far`,
      state: "todo",
    },
    {
      label: "Auth fan-out fix deployed",
      hint: "patch written, not yet shipped",
      state: "todo",
    },
  ];
}

function readinessScore(items: ChecklistItem[]): number {
  const earned = items.reduce((sum, item) => sum + CHECKLIST_SCORES[item.state], 0);
  return (earned / items.length) * 100;
}

function ChecklistStateIcon({ state }: { state: ChecklistState }) {
  if (state === "done") {
    return (
      <span className="text-emerald-500">
        <IconCheckCircle size={16} />
      </span>
    );
  }
  if (state === "warn") {
    return (
      <span className="text-amber-500">
        <IconAlert size={16} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 rounded-full border-2 border-gray-300"
    />
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5 inline-flex w-4 shrink-0 justify-center">
        <ChecklistStateIcon state={item.state} />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-zinc-900">{item.label}</p>
        <p className="text-xs text-gray-400">{item.hint}</p>
      </div>
    </div>
  );
}

/** Actor handle in bold, then the message with any inline @mentions bolded too. */
function ActivityMessage({ event }: { event: ActivityEvent }) {
  const parts = event.message.split(MENTION_PATTERN);
  return (
    <p className="min-w-0 flex-1 text-sm text-gray-600">
      <span className="font-bold text-zinc-900">@{event.actorUsername}</span>{" "}
      {parts.map((part, index) =>
        part.startsWith("@") ? (
          <span key={`${event.id}-${index}`} className="font-bold text-zinc-900">
            {part}
          </span>
        ) : (
          <span key={`${event.id}-${index}`}>{part}</span>
        ),
      )}
    </p>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const chip = ACTIVITY_CHIPS[event.kind];
  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <span
        aria-hidden="true"
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${chip.chipClass}`}
      >
        {chip.icon}
      </span>
      <ActivityMessage event={event} />
      <span className="shrink-0 text-xs text-gray-400">
        <TimeAgo iso={event.occurredAt} />
      </span>
    </div>
  );
}

interface AttentionRowProps {
  media: ReactNode;
  title: string;
  reason: string;
  href: string;
}

function AttentionRow({ media, title, reason, href }: AttentionRowProps) {
  return (
    <div className="flex items-center gap-3 px-5 py-3">
      {media}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-zinc-900">{title}</p>
        <p className="truncate text-xs text-amber-700">{reason}</p>
      </div>
      <Link
        href={href}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#e5ddf5] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#7c5cbf] transition-all duration-150 hover:border-[#d5c8ef] hover:bg-[#f8f5ff] focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        Review <IconArrowRight size={12} />
      </Link>
    </div>
  );
}

interface OverviewPageProps {
  /** Server-derived feed (buildRecentActivity) — newest 20 real events. */
  activity: ActivityEvent[];
}

export function OverviewPage({ activity }: OverviewPageProps) {
  const { users, videos, orders, stats } = useAdminData();

  const flaggedVideos = videos.filter((video) => video.status === "flagged");
  const flaggedUsers = users.filter((user) => user.status === "flagged");
  const attentionCount = flaggedVideos.length + flaggedUsers.length;
  const hasFlaggedItems = attentionCount > 0;

  const launchChecklist = buildLaunchChecklist(stats);
  const score = readinessScore(launchChecklist);

  const paidOrders = orders.filter((order) => order.status === "paid");
  const gmvSeries = accumulate(
    dailyTotals(paidOrders, (order) => order.createdAt, (order) => order.grossCents, 7),
  );
  const signupSeries = accumulate(
    dailyTotals(users, (user) => user.joinedAt, () => 1, 90),
  );
  const uploadSeries = accumulate(
    dailyTotals(videos, (video) => video.createdAt, () => 1, 14),
  );

  return (
    <div className="motion-safe:animate-[pageIn_0.35s_ease-out]">
      <PageHeader
        title="Overview"
        subtitle="Platform health at a glance — launch readiness in real time."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          hero
          label="GMV"
          value={formatCents(stats.gmvCents)}
          hint={`${formatCents(stats.platformFeeCents)} platform fees (12%)`}
          icon={<IconDollar size={15} />}
          visual={<Sparkline data={gmvSeries} stroke="#ffffff" width={140} height={30} />}
        />
        <StatCard
          label="Total users"
          value={formatCompact(stats.totalUsers)}
          hint={`+${stats.newUsersToday} today`}
          icon={<IconUsers size={15} />}
          visual={<Sparkline data={signupSeries} />}
        />
        <StatCard
          label="Creators"
          value={formatCompact(stats.totalCreators)}
          hint="of 50 launch target"
          icon={<IconStar size={15} />}
          iconTint="bg-amber-50 text-amber-500"
        />
        <StatCard
          label="Videos"
          value={formatCompact(stats.totalVideos)}
          hint={`${stats.uploadsToday} uploaded today`}
          icon={<IconPlaySquare size={15} />}
          visual={<Sparkline data={uploadSeries} />}
        />
        <StatCard
          label="Purchases"
          value={formatCompact(stats.purchaseCount)}
          hint={`${stats.bookingCount} bookings`}
          icon={<IconCard size={15} />}
          iconTint="bg-emerald-50 text-emerald-600"
        />
        <StatCard
          label="Needs review"
          value={String(stats.flaggedCount)}
          hint="flagged items"
          icon={<IconFlag size={15} />}
          iconTint="bg-amber-50 text-amber-600"
        />
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Panel
          title="GMV — last 7 days"
          action={
            <span className="text-[11px] text-gray-400">
              cumulative &middot; paid orders only
            </span>
          }
        >
          <div className="px-5 py-4">
            <TrendChart data={gmvSeries} labels={dayLabels(7)} formatValue={formatCents} />
          </div>
        </Panel>

        <Panel title="Launch readiness">
          <div className="flex items-center gap-5 px-5 py-4">
            <DonutRing percent={score} label="ready" />
            <div className="min-w-0 flex-1">
              {launchChecklist.map((item) => (
                <ChecklistRow key={item.label} item={item} />
              ))}
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Recent activity">
          {activity.length > 0 ? (
            <div className="divide-y divide-[#f0ebfb]">
              {activity.map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </div>
          ) : (
            <div className="p-4">
              <EmptyState message="No activity yet" />
            </div>
          )}
        </Panel>

        <Panel
          title="Needs attention"
          tinted
          action={<span className={COUNT_CHIP_CLASS}>{attentionCount}</span>}
        >
          {hasFlaggedItems ? (
            <div className="divide-y divide-[#f0ebfb]">
              {flaggedVideos.map((video) => (
                <AttentionRow
                  key={video.id}
                  media={<VideoThumb id={video.id} />}
                  title={video.title}
                  reason={video.flagReason ?? "Flagged for review"}
                  href="/admin/content"
                />
              ))}
              {flaggedUsers.map((user) => (
                <AttentionRow
                  key={user.id}
                  media={<Avatar id={user.id} name={user.displayName} />}
                  title={user.displayName}
                  reason={user.flagReason ?? "Flagged for review"}
                  href="/admin/users"
                />
              ))}
            </div>
          ) : (
            <div className="p-4">
              <EmptyState message="Nothing needs attention" />
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
