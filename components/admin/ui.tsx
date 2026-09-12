import type { ReactNode } from "react";
import { hueFromId, initials } from "@/lib/admin/format";
import type {
  BookingStatus,
  OrderStatus,
  UserStatus,
  VideoStatus,
} from "@/types/admin";

type BadgeStatus = UserStatus | VideoStatus | OrderStatus | BookingStatus;

/**
 * Shared UI atoms for the Admin Launch Board — CreatorNet visual language.
 *
 * Design tokens (keep in sync across admin components):
 *   accent        #9370DB   deep accent  #7c5cbf   dark accent #6b4fae
 *   panel border  #e9e3f7   panel shadow rgba(109,78,182,0.06)
 *   hover wash    #f8f5ff
 */

export const PANEL_CLASS =
  "rounded-2xl border border-[#e9e3f7] bg-white/90 shadow-[0_2px_16px_rgba(109,78,182,0.06)]";

interface PageHeaderProps {
  title: string;
  subtitle: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[1.75rem] leading-tight font-black tracking-tight text-zinc-900">
          {title}
        </h1>
        <p className="mt-1.5 text-sm text-gray-500">{subtitle}</p>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  /** Small icon rendered in a tinted chip at the top-right. */
  icon?: ReactNode;
  /** Tint for the icon chip, e.g. "bg-emerald-50 text-emerald-600". */
  iconTint?: string;
  /** Sparkline or other footer visual. */
  visual?: ReactNode;
  /** Brand-gradient hero treatment (use for the headline metric). */
  hero?: boolean;
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  iconTint = "bg-[#f3eefc] text-[#7c5cbf]",
  visual,
  hero = false,
}: StatCardProps) {
  if (hero) {
    return (
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#9370DB] to-[#6b4fae] px-5 py-4 shadow-[0_8px_24px_rgba(109,78,182,0.35)] transition-transform duration-200 motion-safe:hover:-translate-y-0.5">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-10 -right-10 h-32 w-32 rounded-full bg-white/10"
        />
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-bold tracking-wider text-white/70 uppercase">
            {label}
          </p>
          {icon ? (
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-white/15 text-white">
              {icon}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-[1.7rem] leading-tight font-black tracking-tight text-white tabular-nums">
          {value}
        </p>
        {hint ? <p className="mt-1 text-xs text-white/70">{hint}</p> : null}
        {visual ? <div className="mt-2">{visual}</div> : null}
      </div>
    );
  }

  return (
    <div className="group rounded-2xl border border-[#e9e3f7] bg-white/90 px-5 py-4 shadow-[0_2px_16px_rgba(109,78,182,0.06)] transition-all duration-200 motion-safe:hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(109,78,182,0.12)]">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-bold tracking-wider text-gray-400 uppercase">
          {label}
        </p>
        {icon ? (
          <span
            className={`inline-flex h-8 w-8 items-center justify-center rounded-xl ${iconTint}`}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-2xl font-black tracking-tight text-zinc-900 tabular-nums">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-gray-400">{hint}</p> : null}
      {visual ? <div className="mt-2">{visual}</div> : null}
    </div>
  );
}

const BADGE_STYLES: Record<BadgeStatus, { chip: string; dot: string }> = {
  // user/video lifecycle
  active: { chip: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  live: { chip: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  banned: { chip: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" },
  removed: { chip: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" },
  flagged: { chip: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-500" },
  hidden: { chip: "bg-gray-100 text-gray-600 border-gray-200", dot: "bg-gray-400" },
  // commerce
  paid: { chip: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  completed: { chip: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  confirmed: { chip: "bg-[#f3eefc] text-[#7c5cbf] border-[#e9e3f7]", dot: "bg-[#9370DB]" },
  pending: { chip: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-500" },
  refunded: { chip: "bg-gray-100 text-gray-600 border-gray-200", dot: "bg-gray-400" },
  canceled: { chip: "bg-gray-100 text-gray-600 border-gray-200", dot: "bg-gray-400" },
  failed: { chip: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" },
};

export function StatusBadge({ status }: { status: BadgeStatus }) {
  const style = BADGE_STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${style.chip}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {status}
    </span>
  );
}

interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  className = "max-w-xs",
}: SearchInputProps) {
  return (
    <div className={`relative w-full ${className}`}>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="6.2" />
        <path d="m20 20-3.6-3.6" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-xl border border-[#e5ddf5] bg-white/90 py-2 pr-3 pl-9 text-sm text-gray-900 shadow-sm transition placeholder:text-gray-400 hover:border-[#d5c8ef] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-1"
      />
    </div>
  );
}

interface FilterPillProps {
  label: string;
  isActive: boolean;
  onClick: () => void;
  count?: number;
}

export function FilterPill({ label, isActive, onClick, count }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition-all duration-150 focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-2 focus-visible:outline-none ${
        isActive
          ? "border-transparent bg-gradient-to-br from-[#9370DB] to-[#7c5cbf] text-white shadow-[0_2px_10px_rgba(109,78,182,0.35)]"
          : "border-[#e5ddf5] bg-white/80 text-gray-600 hover:border-[#d5c8ef] hover:bg-[#f8f5ff]"
      }`}
    >
      {label}
      {typeof count === "number" ? (
        <span
          className={
            isActive
              ? "ml-1.5 tabular-nums opacity-80"
              : "ml-1.5 text-gray-400 tabular-nums"
          }
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

type ActionVariant = "approve" | "neutral" | "danger";

const ACTION_STYLES: Record<ActionVariant, string> = {
  approve:
    "border-emerald-200 bg-emerald-50/60 text-emerald-700 hover:bg-emerald-100/80 hover:border-emerald-300",
  neutral:
    "border-[#e5ddf5] bg-white text-gray-600 hover:bg-[#f8f5ff] hover:border-[#d5c8ef]",
  danger:
    "border-red-200 bg-white text-red-600 hover:bg-red-50 hover:border-red-300",
};

interface ActionButtonProps {
  variant: ActionVariant;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  /** Armed state for two-step destructive confirms — solid red. */
  armed?: boolean;
  title?: string;
  disabled?: boolean;
}

/** Small table/queue action button with consistent styling across pages. */
export function ActionButton({
  variant,
  onClick,
  children,
  armed = false,
  title,
  disabled = false,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-all duration-150 focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 ${
        armed
          ? "border-red-600 bg-red-600 text-white shadow-[0_2px_8px_rgba(220,38,38,0.35)]"
          : ACTION_STYLES[variant]
      }`}
    >
      {children}
    </button>
  );
}

/** Initials avatar with a deterministic hue per id — no external images. */
export function Avatar({
  id,
  name,
  size = 36,
  ringClass,
}: {
  id: string;
  name: string;
  size?: number;
  /** Optional status ring, e.g. "ring-2 ring-amber-400 ring-offset-1". */
  ringClass?: string;
}) {
  const hue = hueFromId(id);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${ringClass ?? ""}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        background: `linear-gradient(135deg, hsl(${hue} 45% 62%), hsl(${(hue + 40) % 360} 50% 48%))`,
      }}
    >
      {initials(name)}
    </span>
  );
}

/** Gradient placeholder standing in for a vertical (9:16) video thumbnail. */
export function VideoThumb({ id, size = 48 }: { id: string; size?: number }) {
  const hue = hueFromId(id);
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg shadow-sm"
      style={{
        width: size * 0.62,
        height: size,
        background: `linear-gradient(160deg, hsl(${hue} 42% 70%), hsl(${(hue + 70) % 360} 45% 42%))`,
      }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/25 to-transparent"
      />
      <svg
        viewBox="0 0 24 24"
        fill="white"
        width={size * 0.34}
        height={size * 0.34}
        aria-hidden="true"
        className="relative drop-shadow"
      >
        <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l10.54-6.86a1.04 1.04 0 0 0 0-1.76L9.56 4.26A1.04 1.04 0 0 0 8 5.14Z" />
      </svg>
    </span>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-[#d5c8ef] bg-white/60 px-6 py-14 text-center">
      <span className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#f3eefc] text-[#9370DB]">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="6.2" />
          <path d="m20 20-3.6-3.6" />
        </svg>
      </span>
      <p className="mt-3 text-sm text-gray-400">{message}</p>
    </div>
  );
}

interface PanelProps {
  children: ReactNode;
  /** Optional standardized header. */
  title?: string;
  /** Amber-tinted header (attention queues). */
  tinted?: boolean;
  /** Right-aligned header content (counts, links). */
  action?: ReactNode;
}

/** Card wrapper used around every admin table/panel. */
export function Panel({ children, title, tinted = false, action }: PanelProps) {
  return (
    <div className={`overflow-hidden ${PANEL_CLASS}`}>
      {title ? (
        <div
          className={`flex items-center justify-between border-b border-[#f0ebfb] px-5 py-3.5 ${
            tinted ? "bg-amber-50/70" : ""
          }`}
        >
          <h2 className="text-sm font-bold text-zinc-900">{title}</h2>
          {action ?? null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Consistent table header cell classes (first column should add pl-5). */
export const TH_CLASS =
  "px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-gray-400";

/** Consistent table row hover treatment. */
export const ROW_HOVER_CLASS = "transition-colors hover:bg-[#f8f5ff]/70";

/** Micro section heading used inside drawers/cards. */
export const MICRO_HEADING_CLASS =
  "text-[10px] font-bold uppercase tracking-wider text-gray-400";

/** Amber count chip used in attention/moderation panel headers. */
export const COUNT_CHIP_CLASS =
  "rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-700 tabular-nums";
