"use client";

import { useId } from "react";

/**
 * Chart primitives for the Admin Launch Board — pure inline SVG, no chart
 * library. All are deterministic (no Date.now/random) so they render
 * identically on server and client.
 */

const ACCENT = "#9370DB";

function buildPoints(
  data: number[],
  width: number,
  height: number,
  padding: number,
): Array<{ x: number; y: number }> {
  const max = Math.max(...data, 1);
  const span = Math.max(data.length - 1, 1);
  return data.map((value, index) => ({
    x: padding + (index / span) * (width - padding * 2),
    y: height - padding - (value / max) * (height - padding * 2),
  }));
}

function toPath(points: Array<{ x: number; y: number }>): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
}

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  /** Fill the area under the line with a soft gradient. */
  filled?: boolean;
  className?: string;
}

/** Tiny area/line chart for stat cards. */
export function Sparkline({
  data,
  width = 120,
  height = 34,
  stroke = ACCENT,
  filled = true,
  className,
}: SparklineProps) {
  const gradientId = useId();
  if (data.length < 2) return null;
  const points = buildPoints(data, width, height, 3);
  const linePath = toPath(points);
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${height - 1} L${points[0].x.toFixed(1)},${height - 1} Z`;
  const end = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      aria-hidden="true"
    >
      {filled ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${gradientId})`} />
        </>
      ) : null}
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={end.x} cy={end.y} r="2.4" fill={stroke} />
    </svg>
  );
}

interface TrendChartProps {
  data: number[];
  /** Same length as data — used for the first/last x-axis labels. */
  labels: string[];
  formatValue: (value: number) => string;
  height?: number;
}

/** Large area chart (GMV trend) with gridlines and axis labels. */
export function TrendChart({ data, labels, formatValue, height = 190 }: TrendChartProps) {
  const gradientId = useId();
  // Same guard as Sparkline — an empty series must not index points[-1].
  if (data.length === 0) return null;
  const width = 640;
  const pad = { top: 14, right: 16, bottom: 26, left: 16 };
  const max = Math.max(...data, 1);
  const span = Math.max(data.length - 1, 1);
  const points = data.map((value, index) => ({
    x: pad.left + (index / span) * (width - pad.left - pad.right),
    y: pad.top + (1 - value / max) * (height - pad.top - pad.bottom),
  }));
  const linePath = toPath(points);
  const floor = height - pad.bottom;
  const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(1)},${floor} L${points[0].x.toFixed(1)},${floor} Z`;
  const end = points[points.length - 1];
  const gridYs = [0.25, 0.5, 0.75].map(
    (t) => pad.top + t * (height - pad.top - pad.bottom),
  );

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Trend chart ending at ${formatValue(data[data.length - 1] ?? 0)}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.30" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {gridYs.map((y) => (
          <line
            key={y}
            x1={pad.left}
            x2={width - pad.right}
            y1={y}
            y2={y}
            stroke="#ece7f8"
            strokeWidth="1"
            strokeDasharray="3 5"
          />
        ))}

        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={ACCENT}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        <circle
          cx={end.x}
          cy={end.y}
          r="8"
          fill={ACCENT}
          opacity="0.15"
          className="motion-safe:animate-[softPulse_2.4s_ease-in-out_infinite]"
        />
        <circle cx={end.x} cy={end.y} r="3.5" fill={ACCENT} />

        <text
          x={pad.left}
          y={height - 8}
          fontSize="11"
          fill="#9ca3af"
          fontFamily="inherit"
        >
          {labels[0] ?? ""}
        </text>
        <text
          x={width - pad.right}
          y={height - 8}
          fontSize="11"
          fill="#9ca3af"
          textAnchor="end"
          fontFamily="inherit"
        >
          {labels[labels.length - 1] ?? ""}
        </text>
      </svg>
      <div className="pointer-events-none absolute top-0 right-2 rounded-full border border-[#e5ddf5] bg-white/90 px-2.5 py-1 text-xs font-bold text-[#7c5cbf] shadow-sm">
        {formatValue(data[data.length - 1] ?? 0)}
      </div>
    </div>
  );
}

interface DonutRingProps {
  /** 0–100 */
  percent: number;
  size?: number;
  label?: string;
}

/** Progress ring (launch readiness). */
export function DonutRing({ percent, size = 128, label }: DonutRingProps) {
  const gradientId = useId();
  const clamped = Math.max(0, Math.min(100, percent));
  const strokeWidth = 11;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        className="-rotate-90"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#7c5cbf" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#f0ebfb"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-black tracking-tight text-zinc-900 tabular-nums">
          {Math.round(clamped)}%
        </span>
        {label ? (
          <span className="text-[10px] font-semibold tracking-wider text-gray-400 uppercase">
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface SplitSegment {
  label: string;
  value: number;
  color: string;
}

/** Horizontal split bar with legend (e.g. creator payouts vs platform fee). */
export function SplitBar({
  segments,
  formatValue,
}: {
  segments: SplitSegment[];
  formatValue: (value: number) => string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return null;

  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {segments.map((segment) => (
          <div
            key={segment.label}
            className="h-full transition-all duration-500"
            style={{
              width: `${(segment.value / total) * 100}%`,
              background: segment.color,
            }}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: segment.color }}
            />
            <span className="text-xs font-semibold text-gray-600">
              {segment.label}
            </span>
            <span className="text-xs font-bold text-zinc-900 tabular-nums">
              {formatValue(segment.value)}
            </span>
            <span className="text-[11px] text-gray-400 tabular-nums">
              {Math.round((segment.value / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
