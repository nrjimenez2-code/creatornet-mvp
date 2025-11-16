"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export type ViewsPoint = { date: string; views: number };

type Props = { data: ViewsPoint[] };

/**
 * Client-only Recharts line chart.
 * The fixed wrapper height ensures the parent always has real dimensions.
 */
export default function ViewsChart({ data }: Props) {
  return (
    <div className="relative h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2f2f2f" />
          <XAxis dataKey="date" tickMargin={8} stroke="#ffffff" tick={{ fill: "#ffffff" }} />
          <YAxis allowDecimals={false} tickMargin={8} stroke="#ffffff" tick={{ fill: "#ffffff" }} />
          <Tooltip
            formatter={(v: any) => [v, "Views"]}
            labelFormatter={(l) => `Date: ${l}`}
            contentStyle={{
              backgroundColor: "rgba(15,15,15,0.9)",
              border: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "12px",
              color: "#ffffff",
            }}
          />
          <Line
            type="monotone"
            dataKey="views"
            dot={false}
            strokeWidth={2}
            stroke="#22c55e"
            activeDot={{ r: 4, fill: "#22c55e" }}
          />
        </LineChart>
      </ResponsiveContainer>
      {(!data || data.length === 0) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-white/60 text-sm">
          No data yet
        </div>
      )}
    </div>
  );
}
