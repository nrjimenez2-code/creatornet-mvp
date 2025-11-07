// app/dashboard/analytics/page.tsx
import { createServerClient } from "@/lib/supabaseServer";
import ViewsChart from "@/components/analytics/ViewsChart";

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

async function loadKpis(start: string, end: string): Promise<Kpis> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("creator_kpis", {
    p_start: start,
    p_end: end,
  });
  if (error) throw error;
  return (data || {}) as Kpis;
}

async function loadViewsSeries(start: string, end: string): Promise<Point[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("creator_views_timeseries", {
    p_start: start,
    p_end: end,
  });
  if (error) return [];
  return (data || []) as Point[];
}

// --- Page ----------------------------------------------------------

export default async function AnalyticsPage() {
  const { start, end } = getWindow(7);
  const [kpis, series] = await Promise.all([
    loadKpis(start, end),
    loadViewsSeries(start, end),
  ]);

  const ctr = safeDiv(kpis.unique_clicks, kpis.views);
  const cvr = safeDiv(kpis.purchases, kpis.unique_clicks);
  const aov = safeDiv(kpis.gmv_cents, kpis.purchases);

  const cards = [
    { label: "Views", value: kpis.views.toLocaleString() },
    { label: "Unique Clicks", value: kpis.unique_clicks.toLocaleString() },
    { label: "CTR", value: pct(ctr) },
    { label: "Purchases", value: kpis.purchases.toLocaleString() },
    { label: "GMV", value: fmtCurrency(kpis.gmv_cents) },
    { label: "AOV", value: fmtCurrency(aov) },
    { label: "CVR", value: pct(cvr) },
    { label: "Refunds", value: kpis.refunds.toLocaleString() },
    { label: "Mentorship Paid", value: kpis.mentorship_paid.toLocaleString() },
  ];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-3xl font-semibold">Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Last 7 days ({start} → {end})
        </p>
      </div>

      {/* KPI GRID */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-2xl border bg-white p-4 shadow-sm"
          >
            <div className="text-sm font-medium text-muted-foreground">
              {c.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tracking-tight">
              {c.value}
            </div>
          </div>
        ))}
      </div>

      {/* CHART */}
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <div className="text-sm font-medium text-muted-foreground mb-2">
          Views (Daily)
        </div>
        <ViewsChart data={series} />
      </div>
    </div>
  );
}
