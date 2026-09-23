import type { ReactNode } from "react";

type Tone = "dark" | "light";

export function Skeleton({ className = "", tone = "dark" }: { className?: string; tone?: Tone }) {
  return <span aria-hidden="true" className={`cn-skeleton cn-skeleton--${tone} ${className}`} />;
}

export function LoadingLabel({ children }: { children: ReactNode }) {
  return <span className="sr-only" role="status">{children}</span>;
}

function DarkPage({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <main aria-busy="true" className={`min-h-svh bg-black text-white ${className}`}><LoadingLabel>{label}</LoadingLabel><div aria-hidden="true">{children}</div></main>;
}

function LightPage({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <main aria-busy="true" className={`min-h-svh bg-white text-gray-900 ${className}`}><LoadingLabel>{label}</LoadingLabel><div aria-hidden="true">{children}</div></main>;
}

function MediaTiles({ count = 8, aspect = "aspect-square", columns = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" }: { count?: number; aspect?: string; columns?: string }) {
  return <div className={`grid ${columns} gap-0`}>{Array.from({ length: count }, (_, i) => <Skeleton key={i} className={`block ${aspect} w-full rounded-none border border-white/10`} />)}</div>;
}

export function TagGridSkeleton({ count = 12 }: { count?: number }) {
  return <div aria-busy="true"><LoadingLabel>Loading tag feed…</LoadingLabel><div aria-hidden="true"><MediaTiles count={count} /></div></div>;
}

export function FeedSkeleton({ label = "Loading feed…" }: { label?: string }) {
  return <div aria-busy="true" className="relative h-full min-h-0 w-full bg-black feed-mobile-viewport">
    <LoadingLabel>{label}</LoadingLabel>
    <div aria-hidden="true" className="feed-mobile-slot h-[calc(100dvh-56px)] lg:h-[100dvh] w-full flex items-start justify-center md:px-4">
      <div className="relative flex h-full w-full items-start justify-center lg:-translate-x-28 lg:items-center">
      <div className="relative h-full w-full overflow-hidden rounded-[16px] border border-white/10 bg-black lg:w-[420px] lg:max-w-[420px]">
        <Skeleton className="absolute inset-0 block h-full w-full rounded-none bg-white/[0.035]" />
        <div className="absolute bottom-8 left-4 right-20 space-y-3">
          <div className="flex items-center gap-3"><Skeleton className="block h-10 w-10 rounded-full" /><Skeleton className="block h-4 w-28" /></div>
          <Skeleton className="block h-4 w-3/4" /><Skeleton className="block h-4 w-1/2" />
        </div>
        <div className="absolute bottom-24 right-4 flex flex-col gap-5">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="block h-11 w-11 rounded-full" />)}</div>
      </div>
      </div>
    </div>
  </div>;
}

export function SearchPlayerFrameSkeleton() {
  return <div aria-busy="true" className="relative mx-auto h-[100dvh] w-full overflow-hidden rounded-[16px] border border-white/10 bg-black lg:w-[420px] lg:max-w-[420px]"><LoadingLabel>Loading video…</LoadingLabel><div aria-hidden="true"><Skeleton className="absolute inset-0 h-full w-full rounded-none" /><div className="absolute bottom-8 left-4 right-20 space-y-3"><div className="flex items-center gap-3"><Skeleton className="h-10 w-10 rounded-full" /><Skeleton className="h-4 w-28" /></div><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div><div className="absolute bottom-24 right-4 flex flex-col gap-5">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-11 w-11 rounded-full" />)}</div></div></div>;
}

export function DashboardSkeleton() {
  return <section className="dashboard-feed-shell min-h-svh bg-black text-white" aria-busy="true">
    <LoadingLabel>Loading feed…</LoadingLabel>
    <div aria-hidden="true" className="mx-auto grid grid-cols-1 gap-2 lg:grid-cols-[240px_1fr] lg:gap-6 lg:pr-10">
      <aside className="hidden lg:block sticky top-6 self-start rounded-3xl border border-white/10 bg-black/70 px-6 py-5">
        <Skeleton className="mx-auto block h-16 w-36" />
        <Skeleton className="mt-6 block h-10 w-full rounded-full" />
        <div className="mt-6 space-y-4">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="block h-8 w-4/5 rounded-lg" />)}</div>
        <Skeleton className="mt-8 block h-10 w-full rounded-full" />
      </aside>
      <div className="dashboard-feed-column h-[100dvh] min-h-0 overflow-hidden pb-14 lg:pb-0"><FeedSkeleton label="Loading feed…" /></div>
    </div>
    <div aria-hidden="true" className="dashboard-feed-nav fixed bottom-0 inset-x-0 border-t border-white/10 bg-black/85 lg:hidden"><div className="grid h-[52px] grid-cols-5 items-center justify-items-center">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="block h-6 w-6 rounded-full" />)}</div></div>
  </section>;
}

export function ProfileSkeleton({ reviews = false }: { reviews?: boolean }) {
  return <DarkPage label={reviews ? "Loading creator reviews…" : "Loading profile…"} className="px-4 pb-16 pt-4 md:pt-10">
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-col items-center text-center md:mt-8">
        <Skeleton className="block h-32 w-32 rounded-full border border-white/20 sm:h-40 sm:w-40 md:h-48 md:w-48" />
        <Skeleton className="mt-5 block h-8 w-44 sm:w-56" /><Skeleton className="mt-3 block h-4 w-32" />
        <Skeleton className="mt-4 block h-4 w-64 max-w-full" />
        <div className="mt-6 flex gap-8">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="block h-9 w-16" />)}</div>
      </div>
      {reviews ? <div className="mx-auto mt-10 max-w-3xl space-y-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-4"><Skeleton className="block h-4 w-36" /><Skeleton className="mt-4 block h-4 w-full" /><Skeleton className="mt-2 block h-4 w-2/3" /></div>)}</div>
        : <div className="mt-8"><MediaTiles count={8} columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" /></div>}
    </div>
  </DarkPage>;
}

export function TagSkeleton() {
  return <DarkPage label="Loading tag feed…" className="px-4 py-4 md:py-6">
    <div className="mx-auto max-w-6xl"><div className="mb-5 pl-12 sm:pl-14 md:pl-16 lg:pl-0"><Skeleton className="block h-8 w-40" /><Skeleton className="mt-2 block h-4 w-56" /></div><MediaTiles count={12} /></div>
  </DarkPage>;
}

export function SearchResultsSkeleton({ tab = "all", append = false }: { tab?: "all" | "creators" | "videos" | "offerings"; append?: boolean }) {
  return <div aria-busy="true" className="space-y-8"><LoadingLabel>{append ? "Loading more results…" : "Searching…"}</LoadingLabel><div aria-hidden="true" className="space-y-8">
    {(tab === "all" || tab === "creators") && <section><Skeleton className="mb-3 block h-5 w-24" /><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: append ? 2 : 3 }, (_, i) => <div key={i} className="flex gap-3 rounded-xl border border-white/10 p-4"><Skeleton className="block h-11 w-11 shrink-0 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="block h-4 w-2/3" /><Skeleton className="block h-3 w-1/2" /></div></div>)}</div></section>}
    {(tab === "all" || tab === "videos") && <section><Skeleton className="mb-3 block h-5 w-20" /><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{Array.from({ length: append ? 2 : 4 }, (_, i) => <div key={i} className="overflow-hidden rounded-xl border border-white/10"><Skeleton className="block aspect-[3/4] w-full rounded-none" /><div className="space-y-2 p-3"><Skeleton className="block h-3 w-1/2" /><Skeleton className="block h-4 w-4/5" /></div></div>)}</div></section>}
    {(tab === "all" || tab === "offerings") && <section><Skeleton className="mb-3 block h-5 w-20" /><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: append ? 2 : 3 }, (_, i) => <div key={i} className="space-y-3 rounded-xl border border-white/10 p-4"><Skeleton className="block h-4 w-3/4" /><Skeleton className="block h-3 w-1/2" /><Skeleton className="block h-3 w-20" /></div>)}</div></section>}
  </div></div>;
}

export function SearchSkeleton() {
  return <DarkPage label="Loading search…"><div className="sticky top-0 border-b border-white/10"><div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3"><Skeleton className="block h-10 w-10 rounded-full" /><Skeleton className="block h-12 flex-1 rounded-full" /><Skeleton className="block h-10 w-20 rounded-full" /></div></div><div className="mx-auto max-w-6xl px-4 py-5"><div className="mb-5 flex gap-5 border-b border-white/15 pb-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="block h-5 w-16" />)}</div><SearchResultsSkeleton /></div></DarkPage>;
}

function LibraryCardSkeleton() {
  return <div className="overflow-hidden rounded-xl border border-gray-700 bg-black"><Skeleton className="block aspect-[4/3] w-full rounded-none" /><div className="space-y-2 p-3"><Skeleton className="block h-4 w-4/5" /><Skeleton className="block h-3 w-1/2" /><Skeleton className="block h-7 w-16 rounded-md" /></div></div>;
}

export function LibrarySkeleton() {
  return <DarkPage label="Loading your library…" className="relative p-6"><Skeleton className="absolute left-4 top-4 hidden h-11 w-11 rounded-full md:block" /><div className="mx-auto max-w-6xl"><div className="mb-6 md:hidden"><Skeleton className="mb-3 block h-11 w-11 rounded-full" /><Skeleton className="block h-7 w-40" /></div><Skeleton className="mb-6 hidden h-8 w-40 md:block" /><div className="mb-6 flex flex-wrap gap-x-5 gap-y-2"><Skeleton className="block h-4 w-28" /><Skeleton className="block h-4 w-24" /><Skeleton className="block h-4 w-32" /></div><Skeleton className="mb-3 block h-5 w-36" /><div className="mb-8 flex gap-4 overflow-hidden">{Array.from({ length: 3 }, (_, i) => <div key={i} className="w-[210px] shrink-0"><LibraryCardSkeleton /></div>)}</div><div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">{Array.from({ length: 10 }, (_, i) => <LibraryCardSkeleton key={i} />)}</div></div></DarkPage>;
}

export function ContinueSkeleton() {
  return <DarkPage label="Loading continue watching…" className="bg-[#0b0b0b]"><div className="mx-auto max-w-6xl px-4 py-8"><Skeleton className="block h-8 w-40" /><ContinueSectionSkeleton /></div></DarkPage>;
}

export function ContinueSectionSkeleton() {
  return <section aria-busy="true" className="mt-6"><LoadingLabel>Loading continue watching…</LoadingLabel><h2 className="text-lg font-semibold text-white/90">Continue Watching</h2><div aria-hidden="true" className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="overflow-hidden rounded-xl border border-white/10 bg-white/5"><Skeleton className="block aspect-[9/16] w-full rounded-none" /><div className="space-y-2 p-3"><Skeleton className="block h-4 w-3/4" /><Skeleton className="block h-2 w-full" /></div></div>)}</div></section>;
}

export function WatchSkeleton() {
  return <DarkPage label="Loading video…" className="mx-auto max-w-3xl px-4 py-6 sm:p-6"><Skeleton className="fixed left-4 top-4 hidden h-11 w-11 rounded-full lg:block" /><div className="mb-4 flex items-center gap-4"><Skeleton className="block h-11 w-11 shrink-0 rounded-full lg:hidden" /><Skeleton className="block h-7 w-64 max-w-full" /></div><div className="rounded-2xl border-4 border-gray-200 bg-black/90 p-1 sm:rounded-[32px] sm:border-[14px] sm:px-2 sm:py-2"><Skeleton className="block h-[50vh] w-full rounded-xl sm:h-[60vh] md:h-[36rem]" /></div><div className="mt-6 flex items-center gap-3"><Skeleton className="block h-12 w-12 rounded-full sm:h-14 sm:w-14" /><div className="flex-1 space-y-2"><Skeleton className="block h-3 w-20" /><Skeleton className="block h-5 w-36" /></div><Skeleton className="block h-10 w-20 rounded-lg" /></div></DarkPage>;
}

export function AnalyticsSkeleton() {
  return <DarkPage label="Loading analytics…" className="relative px-4 pb-6 pt-[68px] sm:px-8 sm:pt-[58px]"><Skeleton className="absolute left-2 top-3 h-11 w-11 rounded-full sm:left-5" /><div className="mx-auto max-w-[1100px]"><Skeleton className="block h-9 w-40" /><Skeleton className="mb-5 mt-2 block h-4 w-64" /><div className="rounded-[18px] border border-[#29292f] bg-[#080809] p-4 sm:p-7"><div className="flex flex-wrap items-end justify-between gap-4 border-b border-[#29292f] pb-4"><Skeleton className="block h-11 w-[270px] max-w-full rounded-[10px]" /><Skeleton className="block h-11 w-36 rounded-[10px]" /></div><div className="grid grid-cols-3 gap-3 border-b border-[#29292f] py-5 sm:gap-6">{Array.from({ length: 3 }, (_, i) => <div key={i} className="space-y-2"><Skeleton className="block h-8 w-20 max-w-full" /><Skeleton className="block h-4 w-24 max-w-full" /></div>)}</div><Skeleton className="mb-3 mt-5 block h-5 w-36" /><Skeleton className="block h-[200px] w-full sm:h-[230px]" /></div></div></DarkPage>;
}

export function EarningsSkeleton() {
  return <DarkPage label="Loading earnings…" className="relative px-4 pb-6 pt-[68px] sm:px-8"><Skeleton className="absolute left-2 top-3 h-11 w-11 rounded-full sm:left-5" /><div className="mx-auto max-w-[1100px]"><Skeleton className="block h-9 w-36" /><Skeleton className="mb-6 mt-2 block h-4 w-64" /><div className="rounded-[18px] border border-[#29292f] bg-[#080809] p-5 sm:p-8"><div className="flex flex-wrap justify-between gap-5 border-b border-[#29292f] pb-7"><div className="space-y-2"><Skeleton className="block h-4 w-48" /><Skeleton className="block h-11 w-56" /></div><Skeleton className="block h-20 w-72 max-w-full rounded-xl" /></div><Skeleton className="mb-5 mt-6 block h-7 w-40" /><div className="space-y-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="block h-14 w-full" />)}</div></div></div></DarkPage>;
}

export function CallsSkeleton() {
  return <DarkPage label="Loading your paid calls…" className="p-6"><div className="mx-auto max-w-3xl"><Skeleton className="block h-4 w-24" /><Skeleton className="mb-3 mt-6 block h-8 w-48" /><Skeleton className="mb-6 block h-4 w-full max-w-xl" /><div className="space-y-4">{Array.from({ length: 3 }, (_, i) => <div key={i} className="rounded-xl border border-gray-600 p-4"><Skeleton className="block h-5 w-2/3" /><Skeleton className="mt-3 block h-9 w-28 rounded-lg" /></div>)}</div></div></DarkPage>;
}

export function ClosersSkeleton() {
  return <DarkPage label="Loading bookings and destinations…" className="relative px-4 pb-10 pt-[78px] sm:px-6 sm:pt-[82px] xl:pt-[46px]"><Skeleton className="absolute left-3 top-3 h-11 w-11 rounded-full sm:left-5" /><div className="mx-auto max-w-[1040px]"><Skeleton className="h-9 w-56" /><Skeleton className="mb-7 mt-2 h-4 w-80 max-w-full" /><div className="space-y-[22px]">
    <section className="rounded-[18px] border border-[#29292f] bg-[#080809] p-[18px] sm:p-[22px]"><Skeleton className="h-6 w-48" /><Skeleton className="mt-2 h-4 w-72 max-w-full" /><div className="mt-5 grid gap-4 sm:grid-cols-2"><Skeleton className="h-12 w-full rounded-[10px]" /><Skeleton className="h-12 w-full rounded-[10px]" /></div><Skeleton className="mt-5 h-11 w-36 rounded-[11px]" /></section>
    <section className="rounded-[18px] border border-[#29292f] bg-[#080809] p-[18px] sm:p-[22px]"><div className="flex justify-between gap-3"><Skeleton className="h-6 w-44" /><Skeleton className="h-11 w-28 rounded-[11px]" /></div><div className="mt-5 border-y border-[#29292f] py-3"><Skeleton className="h-4 w-full" /></div><BookingTargetsSkeleton /></section>
    <section className="rounded-[18px] border border-[#29292f] bg-[#080809] p-[18px] sm:p-[22px]"><Skeleton className="h-6 w-52" /><Skeleton className="mt-2 h-4 w-72 max-w-full" /><div className="mt-5"><BookingListSkeleton /></div></section>
  </div></div></DarkPage>;
}

export function BookingTargetsSkeleton() {
  return <div aria-busy="true"><LoadingLabel>Loading booking destinations…</LoadingLabel><div aria-hidden="true" className="space-y-2 p-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="block h-12 w-full rounded-md" />)}</div></div>;
}

export function BookingListSkeleton() {
  return <div aria-busy="true"><LoadingLabel>Loading bookings…</LoadingLabel><div aria-hidden="true" className="space-y-4">{Array.from({ length: 3 }, (_, i) => <div key={i} className="space-y-3 rounded-xl border border-white/15 p-4"><Skeleton className="block h-5 w-48 max-w-full" /><Skeleton className="block h-4 w-3/4" /><Skeleton className="block h-9 w-28 rounded-lg" /></div>)}</div></div>;
}

export function BookingConnectionsSkeleton() {
  return <section aria-busy="true" className="space-y-3 rounded-xl border border-white/15 bg-white/5 p-4 text-white"><LoadingLabel>Checking booking connections…</LoadingLabel><Skeleton className="block h-5 w-48 max-w-full" /><div aria-hidden="true" className="space-y-2"><Skeleton className="block h-14 w-full rounded-lg" /><Skeleton className="block h-14 w-full rounded-lg" /></div></section>;
}

export function BookingSlotsSkeleton() {
  return <div aria-busy="true" className="space-y-2"><LoadingLabel>Checking available times…</LoadingLabel><div aria-hidden="true" className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="block h-12 w-full rounded-lg" />)}</div></div>;
}

export function CalendarFormSkeleton() {
  return <div aria-busy="true" className="space-y-5"><LoadingLabel>Loading your calendars…</LoadingLabel><div aria-hidden="true" className="space-y-5"><Skeleton className="block h-12 w-full rounded-lg" /><Skeleton className="block h-16 w-full rounded-lg" /><Skeleton className="block h-12 w-full rounded-lg" /><div className="grid grid-cols-2 gap-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="block h-12 w-full rounded-lg" />)}</div></div></div>;
}

export function GoogleSetupSkeleton() {
  return <DarkPage label="Loading Google Calendar setup…" className="p-6"><div className="mx-auto max-w-2xl space-y-5"><Skeleton className="h-8 w-72 max-w-full" /><Skeleton className="h-4 w-full max-w-lg" /><CalendarFormSkeleton /></div></DarkPage>;
}

export function MembershipCardsSkeleton() {
  return <div aria-busy="true" className="space-y-5"><LoadingLabel>Loading owned memberships and payment status…</LoadingLabel><div aria-hidden="true" className="space-y-5">{Array.from({ length: 2 }, (_, i) => <div key={i} className="rounded-2xl border border-white/15 bg-black p-5 sm:p-6"><Skeleton className="block h-6 w-1/2" /><Skeleton className="mt-3 block h-4 w-2/3" /><div className="mt-5 grid gap-4 sm:grid-cols-2">{Array.from({ length: 4 }, (_, j) => <Skeleton key={j} className="block h-10 w-full" />)}</div></div>)}</div></div>;
}

export function PaymentReviewBodySkeleton({ label = "Checking payment details…" }: { label?: string }) {
  return <div aria-busy="true" className="space-y-4 rounded-xl border border-white/15 p-5"><p role="status" className="text-sm text-white/60">{label}</p><div aria-hidden="true" className="space-y-3"><Skeleton className="block h-6 w-48 max-w-full" /><Skeleton className="block h-4 w-full" /><Skeleton className="block h-4 w-5/6" /><Skeleton className="block h-4 w-2/3" /><Skeleton className="mt-5 block h-11 w-48 rounded-lg" /></div></div>;
}

export function MembershipCompleteBodySkeleton() {
  return <div aria-busy="true" className="space-y-4"><p role="status" className="text-sm text-white/60">Checking payment and paid-period access…</p><div aria-hidden="true" className="space-y-4"><Skeleton className="h-7 w-56 max-w-full" /><Skeleton className="h-4 w-full max-w-lg" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-11 w-44 rounded-lg" /></div></div>;
}

export function MembershipCompleteSkeleton() {
  return <DarkPage label="Checking membership confirmation…" className="p-6"><div className="mx-auto max-w-3xl space-y-5"><Skeleton className="h-8 w-72 max-w-full" /><MembershipCompleteBodySkeleton /></div></DarkPage>;
}

export function SuccessSkeleton() {
  return <main aria-busy="true" className="flex min-h-svh items-center justify-center bg-white p-6 text-gray-900"><div className="w-full max-w-md text-center"><Skeleton tone="light" className="mx-auto mb-4 h-10 w-10 rounded-full" /><Skeleton tone="light" className="mx-auto mb-2 h-7 w-44" /><p role="status" className="text-sm text-gray-600">Checking purchase confirmation…</p><Skeleton tone="light" className="mx-auto mt-8 h-3 w-56 max-w-full" /></div></main>;
}

export function CommentRowsSkeleton() {
  return <div aria-busy="true" className="space-y-4"><LoadingLabel>Loading comments…</LoadingLabel><div aria-hidden="true" className="space-y-4">{Array.from({ length: 5 }, (_, i) => <div key={i} className="flex gap-3"><Skeleton className="block h-10 w-10 shrink-0 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="block h-4 w-2/5" /><Skeleton className="block h-4 w-full" /></div></div>)}</div></div>;
}

export function FollowerRowsSkeleton() {
  return <div aria-busy="true" className="space-y-2"><LoadingLabel>Loading people…</LoadingLabel><div aria-hidden="true" className="space-y-2">{Array.from({ length: 6 }, (_, i) => <div key={i} className="flex items-center gap-3 rounded-lg p-2"><Skeleton className="block h-10 w-10 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="block h-4 w-1/2" /><Skeleton className="block h-3 w-1/3" /></div></div>)}</div></div>;
}

export function MembershipSkeleton({ label = "Loading monthly mentorships…" }: { label?: string }) {
  return <DarkPage label={label} className="px-4 py-8 sm:px-6"><div className="mx-auto max-w-4xl space-y-6"><Skeleton className="block h-4 w-28" /><div className="space-y-2"><Skeleton className="block h-9 w-64 max-w-full" /><Skeleton className="block h-4 w-full max-w-xl" /></div><div className="flex gap-3"><Skeleton className="block h-10 w-36 rounded-full" /><Skeleton className="block h-10 w-36 rounded-full" /></div><div className="space-y-5">{Array.from({ length: 3 }, (_, i) => <div key={i} className="rounded-2xl border border-white/15 bg-black p-5 sm:p-6"><div className="flex justify-between gap-3"><Skeleton className="block h-6 w-1/2" /><Skeleton className="block h-7 w-28 rounded-full" /></div><Skeleton className="mt-3 block h-4 w-2/3" /><div className="mt-5 grid gap-4 sm:grid-cols-2">{Array.from({ length: 4 }, (_, j) => <div key={j} className="space-y-2"><Skeleton className="block h-3 w-28" /><Skeleton className="block h-5 w-36" /></div>)}</div></div>)}</div></div></DarkPage>;
}

export function PaymentListSkeleton() {
  return <DarkPage label="Loading payment plans…" className="p-6"><div className="mx-auto max-w-3xl"><Skeleton className="block h-4 w-32" /><Skeleton className="mt-6 block h-8 w-52" /><Skeleton className="mt-3 block h-4 w-full max-w-lg" /><div className="mt-6 space-y-3">{Array.from({ length: 4 }, (_, i) => <div key={i} className="rounded-xl border border-gray-700 p-4"><Skeleton className="block h-5 w-2/3" /><Skeleton className="mt-3 block h-4 w-36" /></div>)}</div></div></DarkPage>;
}

export function PaymentDetailSkeleton({ label = "Checking payment details…", light = false }: { label?: string; light?: boolean }) {
  const content = <div className="mx-auto max-w-3xl space-y-5"><Skeleton tone={light ? "light" : "dark"} className="block h-4 w-28" /><Skeleton tone={light ? "light" : "dark"} className="block h-9 w-64 max-w-full" /><div className={`rounded-2xl border p-5 sm:p-6 ${light ? "border-gray-200 bg-white" : "border-white/15 bg-black"}`}><Skeleton tone={light ? "light" : "dark"} className="block h-5 w-48" /><div className="mt-5 space-y-3">{Array.from({ length: 4 }, (_, i) => <Skeleton tone={light ? "light" : "dark"} key={i} className="block h-4 w-full" />)}</div><Skeleton tone={light ? "light" : "dark"} className="mt-6 block h-11 w-48 rounded-xl" /></div></div>;
  return light ? <LightPage label={label} className="p-6">{content}</LightPage> : <DarkPage label={label} className="p-6">{content}</DarkPage>;
}

export function BookingSkeleton({ slots = false }: { slots?: boolean }) {
  return <DarkPage label={slots ? "Checking available times…" : "Loading booking settings…"} className="p-6"><div className="mx-auto max-w-2xl space-y-5"><Skeleton className="block h-8 w-64 max-w-full" /><Skeleton className="block h-4 w-full max-w-lg" /><div className="rounded-xl border border-white/20 p-4"><Skeleton className="block h-5 w-40" /><div className="mt-5 space-y-3">{Array.from({ length: slots ? 5 : 6 }, (_, i) => <Skeleton key={i} className="block h-12 w-full rounded-lg" />)}</div></div></div></DarkPage>;
}

export function BookingConnectionSkeleton({ complete = false }: { complete?: boolean }) {
  return <DarkPage label={complete ? "Checking connection…" : "Opening connection…"} className="p-8"><div className="mx-auto max-w-lg space-y-4"><Skeleton className="block h-7 w-64 max-w-full" />{!complete && <Skeleton className="block h-5 w-52 max-w-full" />}<Skeleton className="block h-4 w-full" /><Skeleton className="block h-4 w-5/6" /><Skeleton className="block h-10 w-48 rounded-md" /></div></DarkPage>;
}

export function AuthSkeleton() {
  return <LightPage label="Checking sign-in…" className="flex items-center justify-center overflow-hidden bg-gradient-to-br from-[#faf8ff] via-[#fdfbff] to-[#f6ecff]"><div className="w-[420px] max-w-full rounded-2xl bg-white/80 px-8 py-10 text-center shadow-[0_8px_40px_rgba(0,0,0,0.06)] backdrop-blur"><Skeleton tone="light" className="mx-auto block h-9 w-40" /><Skeleton tone="light" className="mx-auto mt-4 block h-4 w-56 max-w-full" /><div className="mt-8 space-y-3"><Skeleton tone="light" className="block h-11 w-full rounded-lg" /><Skeleton tone="light" className="block h-11 w-full rounded-lg" /><Skeleton tone="light" className="block h-11 w-full rounded-lg" /></div></div></LightPage>;
}

export function OnboardingSkeleton() {
  return <LightPage label="Loading onboarding…" className="flex items-start justify-center px-4 py-10 sm:items-center"><div className="w-full max-w-md"><Skeleton tone="light" className="block h-9 w-3/4" /><Skeleton tone="light" className="mt-3 block h-4 w-full" /><Skeleton tone="light" className="mt-6 block h-11 w-full rounded-md" /><div className="mt-5 grid grid-cols-2 gap-2">{Array.from({ length: 10 }, (_, i) => <Skeleton tone="light" key={i} className="block h-12 w-full rounded-md" />)}</div><Skeleton tone="light" className="mt-6 block h-12 w-full rounded-lg" /></div></LightPage>;
}

export function EditorSkeleton() {
  return <DarkPage label="Loading your profile…" className="px-[14px] pb-8 pt-5 min-[601px]:px-6 min-[601px]:pb-12 min-[601px]:pt-[clamp(32px,9vh,100px)]"><div className="mx-auto max-w-[680px] rounded-[20px] border border-[#29292f] bg-[#080809] p-5 min-[601px]:rounded-[22px] min-[601px]:px-11 min-[601px]:py-8"><Skeleton className="h-11 w-24" /><Skeleton className="mt-3 h-9 w-44" /><Skeleton className="mt-2 h-4 w-36" /><div className="mt-8 grid grid-cols-[60px_1fr] gap-4 border-b border-[#252529] pb-8 min-[601px]:flex min-[601px]:items-center"><Skeleton className="h-[60px] w-[60px] rounded-full min-[601px]:h-[72px] min-[601px]:w-[72px]" /><div className="space-y-2"><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-28" /></div><Skeleton className="col-start-2 h-11 w-32 rounded-full min-[601px]:ml-auto" /></div><div className="mt-7 space-y-7"><div><Skeleton className="mb-2 h-4 w-24" /><Skeleton className="h-12 w-full rounded-[10px]" /></div><div><Skeleton className="mb-2 h-4 w-16" /><Skeleton className="h-[120px] w-full rounded-[10px]" /></div></div><div className="mt-7 flex justify-end gap-4 border-t border-[#252529] pt-6"><Skeleton className="h-11 w-20 rounded-[11px]" /><Skeleton className="h-11 w-32 rounded-[11px]" /></div></div></DarkPage>;
}

export function AdminSkeleton({ section = "overview" }: { section?: "overview" | "users" | "content" | "reviews" | "commerce" | "installments" }) {
  const cards = section === "overview" || section === "commerce";
  return <div aria-busy="true" className="space-y-6 text-gray-900"><LoadingLabel>Loading {section}…</LoadingLabel><div aria-hidden="true">
    <Skeleton tone="light" className="block h-8 w-48" /><Skeleton tone="light" className="mt-2 block h-4 w-72 max-w-full" />
    {cards && <div className={`mt-6 grid grid-cols-2 gap-4 ${section === "overview" ? "md:grid-cols-3 xl:grid-cols-6" : "xl:grid-cols-5"}`}>{Array.from({ length: section === "overview" ? 6 : 5 }, (_, i) => <div key={i} className="rounded-2xl border border-[#e9e3f7] bg-white p-5"><Skeleton tone="light" className="block h-4 w-24 max-w-full" /><Skeleton tone="light" className="mt-3 block h-8 w-20 max-w-full" /><Skeleton tone="light" className="mt-3 block h-3 w-full" /></div>)}</div>}
    {section === "overview" ? <div className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">{[0, 1].map(i => <div key={i} className="rounded-2xl border border-[#e9e3f7] bg-white p-5"><Skeleton tone="light" className="block h-6 w-44" /><Skeleton tone="light" className="mt-5 block h-56 w-full rounded-lg" /></div>)}</div> : <div className="mt-6 rounded-2xl border border-[#e9e3f7] bg-white p-4"><div className="mb-4 flex justify-between"><Skeleton tone="light" className="block h-6 w-40" /><Skeleton tone="light" className="block h-9 w-28 rounded-lg" /></div><div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton tone="light" key={i} className="block h-12 w-full rounded-lg" />)}</div></div>}
  </div></div>;
}

export function AdminFrameSkeleton() {
  return <div aria-busy="true" className="relative flex min-h-svh bg-[#faf8ff] text-gray-900 max-md:flex-col"><LoadingLabel>Loading admin workspace…</LoadingLabel>
    <aside aria-hidden="true" className="sticky top-0 flex h-svh w-64 shrink-0 flex-col border-r border-[#e9e3f7] bg-white/80 max-md:static max-md:h-auto max-md:w-full max-md:flex-row max-md:items-center max-md:gap-3 max-md:border-r-0 max-md:border-b max-md:px-4 max-md:py-3"><div className="flex items-center gap-3 px-5 pt-6 max-md:p-0"><Skeleton tone="light" className="h-9 w-9 rounded-xl" /><Skeleton tone="light" className="h-5 w-28 max-md:hidden" /></div><Skeleton tone="light" className="mx-3 mt-5 h-10 w-[232px] rounded-xl max-md:ml-auto max-md:mt-0 max-md:h-9 max-md:w-9" /><div className="mt-5 space-y-1 px-3 max-md:mt-0 max-md:flex max-md:gap-1 max-md:space-y-0 max-md:px-0">{Array.from({ length: 5 }, (_, i) => <Skeleton tone="light" key={i} className="h-10 w-[232px] rounded-xl max-md:w-9" />)}</div><Skeleton tone="light" className="mx-4 mb-5 mt-auto h-14 w-[224px] rounded-xl max-md:hidden" /></aside>
    <main className="relative min-w-0 flex-1 px-8 py-8 max-md:px-4 max-md:py-5"><div className="mx-auto w-full max-w-[1320px]"><AdminSkeleton /></div></main>
  </div>;
}

export function AccessSkeleton() {
  return <LightPage label="Loading access…" className="p-8"><div className="mx-auto max-w-xl"><Skeleton tone="light" className="block h-7 w-40" /><div className="mt-4 space-y-4 rounded-2xl border border-gray-200 p-5"><Skeleton tone="light" className="block h-4 w-32" /><Skeleton tone="light" className="block h-10 w-full" /><Skeleton tone="light" className="block h-9 w-40" /></div></div></LightPage>;
}

export function ModalSkeleton({ kind }: { kind: "composer" | "search" | "comments" | "player" }) {
  if (kind === "search") return <div className="fixed inset-0 z-[110] bg-black/60"><aside role="dialog" aria-modal="true" aria-label="Search CreatorNet" aria-busy="true" className="h-full w-[min(480px,95vw)] border-r border-white/10 bg-[#141414] p-4 text-white"><LoadingLabel>Opening search…</LoadingLabel><Skeleton className="block h-6 w-40" /><Skeleton className="mt-5 block h-12 w-full rounded-full" /><Skeleton className="mt-8 block h-5 w-32" /></aside></div>;
  if (kind === "comments") return <div className="fixed inset-0 z-[100] flex justify-end bg-black/70"><aside role="dialog" aria-modal="true" aria-label="Comments" aria-busy="true" className="h-full w-[400px] max-w-[90vw] border-l border-white/10 bg-black p-4 text-white"><LoadingLabel>Opening comments…</LoadingLabel><Skeleton className="block h-6 w-28" /><div className="mt-6 space-y-5">{Array.from({ length: 5 }, (_, i) => <div key={i} className="flex gap-3"><Skeleton className="block h-10 w-10 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="block h-4 w-1/2" /><Skeleton className="block h-4 w-full" /></div></div>)}</div></aside></div>;
  if (kind === "player") return <div role="dialog" aria-modal="true" aria-label="Search videos" aria-busy="true" className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm"><LoadingLabel>Opening video player…</LoadingLabel><SearchPlayerFrameSkeleton /></div>;
  return <div role="dialog" aria-modal="true" aria-label="Create post" aria-busy="true" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"><div className="w-[min(720px,95vw)] rounded-2xl border border-white/10 bg-[#060606] p-5 text-white"><LoadingLabel>Opening post composer…</LoadingLabel><Skeleton className="block h-6 w-28" /><div className="mt-5 space-y-4"><Skeleton className="block h-36 w-full rounded-xl" /><Skeleton className="block h-11 w-full rounded-lg" /><Skeleton className="block h-11 w-full rounded-lg" /></div></div></div>;
}
