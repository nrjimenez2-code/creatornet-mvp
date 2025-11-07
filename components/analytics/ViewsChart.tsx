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
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" tickMargin={8} />
          <YAxis allowDecimals={false} tickMargin={8} />
          <Tooltip
            formatter={(v: any) => [v, "Views"]}
            labelFormatter={(l) => `Date: ${l}`}
          />
          <Line type="monotone" dataKey="views" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
