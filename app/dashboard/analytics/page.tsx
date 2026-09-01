// app/dashboard/analytics/page.tsx
import { createServerClient } from "@/lib/supabaseServer";
import ViewsChart from "@/components/analytics/ViewsChart";
import BackButton from "@/components/BackButton";
import { redirect } from "next/navigation";

// --- Types --------------------------------------------------------

type Kpis = {
  views: number;
  unique_clicks: number;
  checkouts_started: number;
  purchases: number;
  gmv_cents: number;
  refunds: number;
  bookings_completed: number;
  mentorship_paid: number;
};

type Point = { date: string; views: number };

// --- Utilities -----------------------------------------------------

function fmtCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function pct(n: number) {
  return (n * 100).toFixed(1) + "%";
}

function safeDiv(n: number, d: number) {
  if (!d) return 0;
  return n / d;
}

function getWindow(days = 7) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);

  const toISODate = (d: Date) => d.toISOString().slice(0, 10);
  return { start: toISODate(start), end: toISODate(end) };
}

// --- Server Loaders ------------------------------------------------

async function loadKpis(
  start: string,
  end: string,
  creatorId: string
): Promise<Kpis> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("creator_kpis", {
    p_start: start,
    p_end: end,
    p_creator_id: creatorId,
  });
  if (error) throw error;
  return (data || {}) as Kpis;
}

async function loadViewsSeries(
  start: string,
  end: string,
  creatorId: string
): Promise<Point[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("creator_views_timeseries", {
    p_start: start,
    p_end: end,
    p_creator_id: creatorId,
  });
  if (error) return [];
  return (data || []) as Point[];
}

// Spec P5 requires a Likes metric. Likes live in their own table (no
// creator_id column), so count them through the likes.post_id -> posts.id
// FK with an inner-join filter — one round trip, no client-side id list.
// Live RLS (verified 2026-08-30): likes and posts SELECT are public, so the
// session client can read both. Soft-fails to 0 like the loaders above, but
// logs the failure so a broken query can't masquerade as a quiet week.
async function loadLikes(
  start: string,
  end: string,
  creatorId: string
): Promise<number> {
  const supabase = createServerClient();

  // `end` is an inclusive date; count up to the start of the next day.
  const endExclusive = new Date(`${end}T00:00:00Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

  const { count, error } = await supabase
    .from("likes")
    .select("id, posts!inner(creator_id)", { count: "exact", head: true })
    .eq("posts.creator_id", creatorId)
    .gte("created_at", `${start}T00:00:00Z`)
    .lt("created_at", endExclusive.toISOString());
  if (error) {
    console.error("[analytics] likes count failed:", error.message);
    return 0;
  }
  return count ?? 0;
}

// --- Page ----------------------------------------------------------

export default async function AnalyticsPage() {
  const { start, end } = getWindow(7);
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/auth");
  }

  const [kpisResult, seriesResult, likesResult] = await Promise.allSettled([
    loadKpis(start, end, user.id),
    loadViewsSeries(start, end, user.id),
    loadLikes(start, end, user.id),
  ]);

  const kpis =
    kpisResult.status === "fulfilled" ? kpisResult.value : ({} as Kpis);
  const series: Point[] =
    seriesResult.status === "fulfilled" ? seriesResult.value : [];
  const likes: number =
    likesResult.status === "fulfilled" ? likesResult.value : 0;

  const safeKpis: Kpis = {
    views: kpis?.views ?? 0,
    unique_clicks: kpis?.unique_clicks ?? 0,
    checkouts_started: kpis?.checkouts_started ?? 0,
    purchases: kpis?.purchases ?? 0,
    gmv_cents: kpis?.gmv_cents ?? 0,
    refunds: kpis?.refunds ?? 0,
    bookings_completed: kpis?.bookings_completed ?? 0,
    mentorship_paid: kpis?.mentorship_paid ?? 0,
  };

  const ctr = safeDiv(safeKpis.unique_clicks, safeKpis.views);
  const cvr = safeDiv(safeKpis.purchases, safeKpis.unique_clicks);
  const aov = safeDiv(safeKpis.gmv_cents, safeKpis.purchases);

  const cards = [
    { label: "Views", value: safeKpis.views.toLocaleString() },
    { label: "Likes", value: likes.toLocaleString() },
    { label: "Unique Clicks", value: safeKpis.unique_clicks.toLocaleString() },
    { label: "Checkouts Started", value: safeKpis.checkouts_started.toLocaleString() },
    { label: "CTR", value: pct(ctr) },
    { label: "Purchases", value: safeKpis.purchases.toLocaleString() },
    { label: "Bookings Completed", value: safeKpis.bookings_completed.toLocaleString() },
    { label: "GMV", value: fmtCurrency(safeKpis.gmv_cents) },
    { label: "AOV", value: fmtCurrency(aov) },
    { label: "CVR", value: pct(cvr) },
    { label: "Refunds", value: safeKpis.refunds.toLocaleString() },
    { label: "Mentorship Paid", value: safeKpis.mentorship_paid.toLocaleString() },
  ];

  return (
    <div className="space-y-6 p-4 md:p-6 bg-black/90 min-h-screen text-white">
      <BackButton />
      <div>
        <h1 className="text-3xl font-semibold">Analytics</h1>
        <p className="text-sm text-white/60">
          Last 7 days ({start} → {end})
        </p>
      </div>

      {/* KPI GRID */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-2xl border border-white/20 bg-black/60 p-4 shadow-sm backdrop-blur"
          >
            <div className="text-sm font-medium text-white/60">
              {c.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight text-white">
              {c.value}
            </div>
          </div>
        ))}
      </div>

      {/* CHART */}
      <div className="rounded-2xl border border-white/20 bg-black/60 p-4 shadow-sm backdrop-blur">
        <div className="text-sm font-medium text-white/60 mb-2">
          Views (Daily)
        </div>
        <ViewsChart data={series} />
      </div>
    </div>
  );
}
