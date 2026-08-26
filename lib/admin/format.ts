/** Shared formatters for the Admin Launch Board. */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatCents(cents: number): string {
  return USD.format(cents / 100);
}

export function formatCompact(n: number): string {
  return COMPACT.format(n);
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MAX_RELATIVE_DAYS = 30;

export function timeAgo(iso: string): string {
  const seconds = Math.max(
    1,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m ago`;

  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours}h ago`;

  const days = Math.floor(hours / HOURS_PER_DAY);
  if (days <= MAX_RELATIVE_DAYS) return `${days}d ago`;

  return formatDate(iso);
}

/** Deterministic hue from an id — used for avatar/thumbnail placeholders. */
export function hueFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 360;
  }
  return hash;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
