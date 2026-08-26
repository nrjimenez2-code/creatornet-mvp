"use client";

import { Suspense, useState, type MouseEvent } from "react";
import { useSearchParams } from "next/navigation";
import {
  AdminDataProvider,
  useAdminData,
} from "@/components/admin/AdminDataContext";
import { Drawer } from "@/components/admin/Drawer";
import { TimeAgo } from "@/components/admin/TimeAgo";
import {
  ActionButton,
  Avatar,
  EmptyState,
  FilterPill,
  MICRO_HEADING_CLASS,
  PageHeader,
  Panel,
  ROW_HOVER_CLASS,
  SearchInput,
  StatusBadge,
  TH_CLASS,
} from "@/components/admin/ui";
import {
  IconBan,
  IconBolt,
  IconCheck,
  IconFlag,
  IconStar,
} from "@/components/admin/icons";
import { formatCents, formatCompact, formatDate } from "@/lib/admin/format";
import type {
  AdminInitialData,
  AdminOrder,
  AdminUser,
} from "@/types/admin";

type UserFilter = "all" | "creators" | "viewers" | "flagged" | "banned";

const FILTERS: ReadonlyArray<{ key: UserFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "creators", label: "Creators" },
  { key: "viewers", label: "Viewers" },
  { key: "flagged", label: "Flagged" },
  { key: "banned", label: "Banned" },
];

const COLUMNS = [
  "User",
  "Role",
  "Earnings",
  "Posts",
  "Followers",
  "Rating",
  "Joined",
  "Status",
  "Actions",
] as const;

const MAX_DRAWER_ORDERS = 4;
const PERCENT_MAX = 100;

function matchesQuery(user: AdminUser, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return (
    user.username.toLowerCase().includes(normalizedQuery) ||
    user.displayName.toLowerCase().includes(normalizedQuery) ||
    user.email.toLowerCase().includes(normalizedQuery)
  );
}

function matchesFilter(user: AdminUser, filter: UserFilter): boolean {
  switch (filter) {
    case "creators":
      return user.isCreator;
    case "viewers":
      return !user.isCreator;
    case "flagged":
      return user.status === "flagged";
    case "banned":
      return user.status === "banned";
    default:
      return true;
  }
}

interface StripeHint {
  label: string;
  className: string;
}

function stripeHint(user: AdminUser): StripeHint {
  if (user.payoutsEnabled) {
    return { label: "Payouts enabled", className: "text-emerald-600" };
  }
  if (!user.onboardingComplete && user.stripeAccountId) {
    return { label: "Onboarding incomplete", className: "text-amber-600" };
  }
  if (user.stripeAccountId === null) {
    return { label: "No Stripe account", className: "text-gray-400" };
  }
  return { label: "Charges only", className: "text-amber-600" };
}

function avatarRing(user: AdminUser): string | undefined {
  if (user.status === "banned") return "ring-2 ring-red-300";
  if (user.status === "flagged") return "ring-2 ring-amber-300";
  return undefined;
}

interface UserRowProps {
  user: AdminUser;
  maxEarnings: number;
  isPendingBan: boolean;
  onSelect: () => void;
  onRequestBan: () => void;
  onConfirmBan: () => void;
  onUnban: () => void;
}

function UserRow({
  user,
  maxEarnings,
  isPendingBan,
  onSelect,
  onRequestBan,
  onConfirmBan,
  onUnban,
}: UserRowProps) {
  const hint = user.isCreator ? stripeHint(user) : null;
  const earningsPct =
    maxEarnings > 0 ? (user.totalEarningsCents / maxEarnings) * PERCENT_MAX : 0;

  function handleBanClick(event: MouseEvent<HTMLButtonElement>): void {
    // Keep the click from bubbling to the page wrapper (which resets pending
    // state) and from opening the detail drawer.
    event.stopPropagation();
    if (isPendingBan) {
      onConfirmBan();
    } else {
      onRequestBan();
    }
  }

  function handleUnbanClick(event: MouseEvent<HTMLButtonElement>): void {
    // Same containment as ban — the row click opens the drawer.
    event.stopPropagation();
    onUnban();
  }

  return (
    <tr className={`${ROW_HOVER_CLASS} cursor-pointer`} onClick={onSelect}>
      <td className="px-5 py-3">
        <div className="flex items-center gap-3">
          <Avatar id={user.id} name={user.displayName} ringClass={avatarRing(user)} />
          <div>
            <p className="font-semibold text-zinc-900">{user.displayName}</p>
            <p className="text-xs text-gray-400">
              @{user.username}
              {user.email ? ` · ${user.email}` : null}
            </p>
            {user.flagReason ? (
              <p className="mt-0.5 text-xs text-amber-700">{user.flagReason}</p>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <p className="font-medium text-zinc-900">
          {user.isCreator ? "Creator" : "Viewer"}
        </p>
        {hint ? <p className={`text-xs ${hint.className}`}>{hint.label}</p> : null}
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        {user.totalEarningsCents > 0 ? (
          <>
            <span className="font-semibold text-zinc-900 tabular-nums">
              {formatCents(user.totalEarningsCents)}
            </span>
            <div className="mt-1 h-1 w-20 overflow-hidden rounded-full bg-[#f0ebfb]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#9370DB] to-[#7c5cbf]"
                style={{ width: earningsPct + "%" }}
              />
            </div>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-4 py-3 text-gray-600 tabular-nums">
        {formatCompact(user.postCount)}
      </td>
      <td className="px-4 py-3 text-gray-600 tabular-nums">
        {formatCompact(user.followerCount)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-gray-600 tabular-nums">
        {user.rating !== null ? (
          <span className="inline-flex items-center gap-1">
            {user.rating.toFixed(1)}
            <IconStar size={12} className="text-amber-400" />
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-gray-400 tabular-nums">
        {formatDate(user.joinedAt)}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={user.status} />
      </td>
      <td className="px-4 py-3">
        {user.status === "banned" ? (
          <ActionButton variant="neutral" onClick={handleUnbanClick}>
            <IconCheck size={12} />
            Unban
          </ActionButton>
        ) : (
          <ActionButton
            variant="danger"
            armed={isPendingBan}
            onClick={handleBanClick}
            title={isPendingBan ? "Click again to confirm" : "Ban account"}
          >
            <IconBan size={12} />
            {isPendingBan ? "Confirm ban?" : "Ban"}
          </ActionButton>
        )}
      </td>
    </tr>
  );
}

interface DrawerStatProps {
  label: string;
  value: React.ReactNode;
}

function DrawerStat({ label, value }: DrawerStatProps) {
  return (
    <div>
      <p className={MICRO_HEADING_CLASS}>{label}</p>
      <p className="text-sm font-bold text-zinc-900 tabular-nums">{value}</p>
    </div>
  );
}

interface StripeRowProps {
  label: string;
  isEnabled: boolean;
  value: React.ReactNode;
}

function StripeRow({ label, isEnabled, value }: StripeRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-sm text-gray-600">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${
            isEnabled ? "bg-emerald-500" : "bg-gray-300"
          }`}
        />
        {label}
      </span>
      {value}
    </div>
  );
}

function stripeFlagValue(isEnabled: boolean, onLabel: string, offLabel: string) {
  return (
    <span
      className={`text-xs font-semibold ${
        isEnabled ? "text-emerald-600" : "text-gray-400"
      }`}
    >
      {isEnabled ? onLabel : offLabel}
    </span>
  );
}

interface UserDrawerProps {
  user: AdminUser | null;
  orders: AdminOrder[];
  onClose: () => void;
  onBan: (id: string) => void;
  onUnban: (id: string) => void;
}

function UserDrawer({ user, orders, onClose, onBan, onUnban }: UserDrawerProps) {
  // Drawer-local two-step ban confirm — arms on first click, fires on the
  // second. The call site keys this component by the selected user id, so the
  // armed state remounts fresh whenever a different user (or none) is shown.
  const [isBanArmed, setIsBanArmed] = useState(false);

  const userOrders = user
    ? orders
        .filter(
          (order) =>
            order.buyerUserId === user.id || order.creatorId === user.id,
        )
        .slice(0, MAX_DRAWER_ORDERS)
    : [];

  function handleBanClick(event: MouseEvent<HTMLButtonElement>): void {
    // The drawer body's click handler disarms — keep this click out of it.
    event.stopPropagation();
    if (!user) return;
    if (isBanArmed) {
      onBan(user.id);
      setIsBanArmed(false);
    } else {
      setIsBanArmed(true);
    }
  }

  function handleUnbanClick(): void {
    if (!user) return;
    onUnban(user.id);
  }

  return (
    <Drawer
      open={user !== null}
      onClose={onClose}
      title={user ? `${user.displayName} details` : "User details"}
    >
      {user ? (
        <>
          <div className="relative bg-gradient-to-br from-[#9370DB] to-[#6b4fae] px-6 pt-14 pb-6">
            <div className="flex items-center gap-4">
              <Avatar
                id={user.id}
                name={user.displayName}
                size={56}
                ringClass="ring-4 ring-white/30"
              />
              <div className="min-w-0">
                <p className="truncate text-xl font-black text-white">
                  {user.displayName}
                </p>
                <p className="truncate text-sm text-white/70">
                  @{user.username}
                  {user.email ? ` · ${user.email}` : null}
                </p>
              </div>
            </div>
            <div className="mt-2">
              <StatusBadge status={user.status} />
            </div>
          </div>

          {/* Clicking anywhere in the body outside the armed Ban disarms it —
              mirrors the VideoDrawer + table behavior. */}
          <div
            className="px-6 py-5 space-y-5"
            onClick={() => setIsBanArmed(false)}
          >
            <div className="grid grid-cols-3 gap-3">
              <DrawerStat
                label="Earnings"
                value={
                  user.totalEarningsCents > 0
                    ? formatCents(user.totalEarningsCents)
                    : "—"
                }
              />
              <DrawerStat label="Posts" value={formatCompact(user.postCount)} />
              <DrawerStat
                label="Followers"
                value={formatCompact(user.followerCount)}
              />
              <DrawerStat
                label="Rating"
                value={user.rating !== null ? user.rating.toFixed(1) : "—"}
              />
              <DrawerStat label="Joined" value={formatDate(user.joinedAt)} />
              <DrawerStat
                label="Last active"
                value={<TimeAgo iso={user.lastActiveAt} />}
              />
            </div>

            {/* INTEGRATION: mirrors profiles.stripe_account_id / charges_enabled / payouts_enabled / onboarding_complete */}
            <div className="rounded-xl border border-[#e9e3f7] p-4">
              <h3 className={`flex items-center gap-1.5 ${MICRO_HEADING_CLASS}`}>
                <IconBolt size={12} />
                Stripe Connect
              </h3>
              <div className="mt-3 space-y-2.5">
                <StripeRow
                  label="Account"
                  isEnabled={user.stripeAccountId !== null}
                  value={
                    user.stripeAccountId ? (
                      <span className="font-mono text-xs text-zinc-900">
                        {user.stripeAccountId}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">Not connected</span>
                    )
                  }
                />
                <StripeRow
                  label="Charges enabled"
                  isEnabled={user.chargesEnabled}
                  value={stripeFlagValue(user.chargesEnabled, "✓ Enabled", "Disabled")}
                />
                <StripeRow
                  label="Payouts enabled"
                  isEnabled={user.payoutsEnabled}
                  value={stripeFlagValue(user.payoutsEnabled, "✓ Enabled", "Disabled")}
                />
                <StripeRow
                  label="Onboarding complete"
                  isEnabled={user.onboardingComplete}
                  value={stripeFlagValue(
                    user.onboardingComplete,
                    "✓ Complete",
                    "Incomplete",
                  )}
                />
              </div>
            </div>

            {user.flagReason ? (
              <div className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <IconFlag size={16} className="mt-0.5 shrink-0" />
                <p>{user.flagReason}</p>
              </div>
            ) : null}

            <div>
              <h3 className={MICRO_HEADING_CLASS}>Recent orders</h3>
              {userOrders.length === 0 ? (
                <p className="mt-2 text-sm text-gray-400">No orders yet</p>
              ) : (
                <ul className="mt-2 space-y-2.5">
                  {userOrders.map((order) => (
                    <li
                      key={order.id}
                      className="flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-zinc-900">
                          {order.offerTitle}
                        </p>
                        <p className="text-xs text-gray-400">
                          <TimeAgo iso={order.createdAt} />
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-sm font-semibold text-zinc-900 tabular-nums">
                          {formatCents(order.grossCents)}
                        </span>
                        <StatusBadge status={order.status} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="pt-2">
              {user.status === "banned" ? (
                <ActionButton variant="neutral" onClick={handleUnbanClick}>
                  <IconCheck size={12} />
                  Unban @{user.username}
                </ActionButton>
              ) : (
                <ActionButton
                  variant="danger"
                  armed={isBanArmed}
                  onClick={handleBanClick}
                  title={isBanArmed ? "Click again to confirm" : "Ban account"}
                >
                  <IconBan size={12} />
                  {isBanArmed ? "Confirm ban?" : `Ban @${user.username}`}
                </ActionButton>
              )}
            </div>
          </div>
        </>
      ) : null}
    </Drawer>
  );
}

function AdminUsersInner({ initialQuery }: { initialQuery: string }) {
  // Shared session store — mutations propagate to the sidebar badge and
  // Overview page and survive navigation. INTEGRATION notes live in
  // AdminDataContext.tsx (each action maps to a POST /api/admin/* route).
  const { users, orders, banUser: banUserAction, unbanUser } = useAdminData();
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<UserFilter>("all");
  const [pendingBanId, setPendingBanId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const searched = users.filter((user) => matchesQuery(user, normalizedQuery));
  const visible = searched.filter((user) => matchesFilter(user, filter));
  const maxEarnings = Math.max(
    0,
    ...users.map((user) => user.totalEarningsCents),
  );
  // Live lookup so ban/unban updates the open drawer in place.
  const selected = users.find((user) => user.id === selectedId) ?? null;

  function countFor(key: UserFilter): number {
    return searched.filter((user) => matchesFilter(user, key)).length;
  }

  // Any change to search/filter can hide the armed row — disarm the pending
  // confirm so it can't silently re-surface later already armed.
  function handleQueryChange(next: string): void {
    setPendingBanId(null);
    setQuery(next);
  }

  function handleFilterChange(key: UserFilter): void {
    setPendingBanId(null);
    setFilter(key);
  }

  function banUser(id: string): void {
    banUserAction(id);
    setPendingBanId(null);
  }

  return (
    <div
      onClick={() => setPendingBanId(null)}
      className="motion-safe:animate-[pageIn_0.35s_ease-out]"
    >
      <PageHeader
        title="Users & Creators"
        subtitle="Search, review, and moderate every account on the platform."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchInput
          value={query}
          onChange={handleQueryChange}
          placeholder="Search name, username, or email…"
        />
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map(({ key, label }) => (
            <FilterPill
              key={key}
              label={label}
              isActive={filter === key}
              onClick={() => handleFilterChange(key)}
              count={countFor(key)}
            />
          ))}
        </div>
      </div>

      <p className="mb-2 text-xs text-gray-400">{visible.length} accounts</p>

      {visible.length === 0 ? (
        <EmptyState message="No accounts match your search or filters." />
      ) : (
        <Panel>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#f0ebfb]">
                  {COLUMNS.map((column, index) => (
                    <th
                      key={column}
                      className={index === 0 ? `${TH_CLASS} pl-5` : TH_CLASS}
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ebfb]">
                {visible.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    maxEarnings={maxEarnings}
                    isPendingBan={pendingBanId === user.id}
                    onSelect={() => setSelectedId(user.id)}
                    onRequestBan={() => setPendingBanId(user.id)}
                    onConfirmBan={() => banUser(user.id)}
                    onUnban={() => unbanUser(user.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <UserDrawer
        key={selectedId ?? "closed"}
        user={selected}
        orders={orders}
        onClose={() => setSelectedId(null)}
        onBan={banUserAction}
        onUnban={unbanUser}
      />
    </div>
  );
}

/**
 * Deep-link support: the command palette navigates here with ?q=<term>.
 * Keying the page content on the param seeds the search state fresh on every
 * palette jump without any URL→state sync effect.
 */
function AdminUsersFromQuery() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  return <AdminUsersInner key={initialQuery} initialQuery={initialQuery} />;
}

/**
 * Client half of the Users page. The server container (page.tsx) fetches real
 * rows and passes them here; the nested AdminDataProvider runs in seeded mode
 * for this subtree, so ban/unban hit the real /api/admin/* routes. Drop the
 * nesting once the layout seeds AdminShell with the full AdminInitialData.
 */
export function UsersPageClient({
  initialData,
}: {
  initialData: AdminInitialData;
}) {
  return (
    <AdminDataProvider initialData={initialData}>
      {/* useSearchParams requires a Suspense boundary in the App Router. */}
      <Suspense fallback={null}>
        <AdminUsersFromQuery />
      </Suspense>
    </AdminDataProvider>
  );
}
