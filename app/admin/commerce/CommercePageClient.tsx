"use client";

// Client half of /admin/commerce. The server container (page.tsx) fetches real
// orders/bookings rows and seeds the page-scoped AdminDataProvider this
// component reads from. Refunds happen in the Stripe dashboard → the
// `charge.refunded` webhook updates the `orders` rows; no admin mutation here.

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AdminBooking, AdminOrder, OrderKind } from "@/types/admin";
import { formatCents } from "@/lib/admin/format";
import { accumulate, dailyTotals } from "@/lib/admin/series";
import { TimeAgo } from "@/components/admin/TimeAgo";
import { useAdminData } from "@/components/admin/AdminDataContext";
import { Sparkline, SplitBar } from "@/components/admin/charts";
import {
  IconAlert,
  IconBolt,
  IconDollar,
  IconInbox,
  IconUsers,
} from "@/components/admin/icons";
import {
  Avatar,
  EmptyState,
  FilterPill,
  PageHeader,
  Panel,
  ROW_HOVER_CLASS,
  SearchInput,
  StatCard,
  StatusBadge,
  TH_CLASS,
} from "@/components/admin/ui";

type CommerceTab = "orders" | "bookings";

const KIND_CHIP_STYLES: Record<OrderKind, string> = {
  product: "bg-gray-100 text-gray-600",
  installments: "bg-blue-50 text-blue-700",
  booking: "bg-[#f3eefc] text-[#7c5cbf]",
};

const TD = "px-4 py-3";
const SPARK_DAYS = 7;

interface Searchable {
  offerTitle: string;
  buyerUsername: string;
  creatorUsername: string;
}

function matchesQuery(row: Searchable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    row.offerTitle.toLowerCase().includes(q) ||
    row.buyerUsername.toLowerCase().includes(q) ||
    row.creatorUsername.toLowerCase().includes(q)
  );
}

function PartyCell({ id, username }: { id: string; username: string }) {
  return (
    <span className="flex items-center gap-2">
      <Avatar id={id} name={`@${username}`} size={22} />
      <span className="text-gray-600">@{username}</span>
    </span>
  );
}

function OrdersTable({ orders }: { orders: AdminOrder[] }) {
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#f0ebfb]">
              <th className={`${TH_CLASS} pl-5`}>Order</th>
              <th className={TH_CLASS}>Buyer</th>
              <th className={TH_CLASS}>Creator</th>
              <th className={TH_CLASS}>Gross</th>
              <th className={TH_CLASS}>Platform fee (12%)</th>
              <th className={TH_CLASS}>Payment processing</th>
              <th className={TH_CLASS}>Creator net</th>
              <th className={TH_CLASS}>Status</th>
              <th className={TH_CLASS}>Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0ebfb]">
            {orders.map((order) => (
              <tr key={order.id} className={ROW_HOVER_CLASS}>
                <td className="px-5 py-3">
                  <p className="font-semibold text-zinc-900">{order.offerTitle}</p>
                  <span
                    className={`mt-0.5 inline-flex rounded-full px-1.5 text-[11px] font-bold ${KIND_CHIP_STYLES[order.kind]}`}
                  >
                    {order.kind}
                  </span>
                </td>
                <td className={TD}>
                  <PartyCell id={order.buyerUserId} username={order.buyerUsername} />
                </td>
                <td className={TD}>
                  <PartyCell id={order.creatorId} username={order.creatorUsername} />
                </td>
                <td className={`${TD} font-bold text-zinc-900 tabular-nums`}>
                  {formatCents(order.grossCents)}
                </td>
                <td className={`${TD} text-gray-400 tabular-nums`}>
                  {formatCents(order.feeCents)}
                </td>
                <td className={`${TD} text-gray-400 tabular-nums`}>
                  {formatCents(order.processingFeeCents)}
                </td>
                <td className={`${TD} font-semibold text-emerald-700 tabular-nums`}>
                  {formatCents(order.creatorCents)}
                </td>
                <td className={TD}>
                  <StatusBadge status={order.status} />
                </td>
                <td className={`${TD} whitespace-nowrap text-gray-400`}>
                  <TimeAgo iso={order.createdAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function BookingsTable({ bookings }: { bookings: AdminBooking[] }) {
  return (
    <Panel>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#f0ebfb]">
              <th className={`${TH_CLASS} pl-5`}>Booking</th>
              <th className={TH_CLASS}>Creator</th>
              <th className={TH_CLASS}>Buyer</th>
              <th className={TH_CLASS}>Amount</th>
              <th className={TH_CLASS}>Status</th>
              <th className={TH_CLASS}>Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0ebfb]">
            {bookings.map((booking) => (
              <tr key={booking.id} className={ROW_HOVER_CLASS}>
                <td className="px-5 py-3 font-semibold text-zinc-900">
                  {booking.offerTitle}
                </td>
                <td className={TD}>
                  <PartyCell id={booking.creatorId} username={booking.creatorUsername} />
                </td>
                <td className={TD}>
                  <PartyCell id={booking.buyerUserId} username={booking.buyerUsername} />
                </td>
                <td className={`${TD} tabular-nums`}>
                  {booking.amountCents !== null ? (
                    <span className="font-bold text-zinc-900">
                      {formatCents(booking.amountCents)}
                    </span>
                  ) : (
                    <span className="text-gray-400">TBD</span>
                  )}
                </td>
                <td className={TD}>
                  <StatusBadge status={booking.status} />
                </td>
                <td className={`${TD} whitespace-nowrap text-gray-400`}>
                  <TimeAgo iso={booking.createdAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CommerceInner({ initialQuery }: { initialQuery: string }) {
  const { orders, bookings } = useAdminData();
  const [tab, setTab] = useState<CommerceTab>("orders");
  const [query, setQuery] = useState(initialQuery);

  const paidOrders = useMemo(
    () => orders.filter((order) => order.status === "paid"),
    [orders],
  );

  const revenue = useMemo(() => {
    const refunded = orders.filter((order) => order.status === "refunded");
    return {
      paidCount: paidOrders.length,
      gmvCents: paidOrders.reduce((sum, order) => sum + order.grossCents, 0),
      feeCents: paidOrders.reduce((sum, order) => sum + order.feeCents, 0),
      processingFeeCents: paidOrders.reduce(
        (sum, order) => sum + order.processingFeeCents,
        0,
      ),
      creatorCents: paidOrders.reduce((sum, order) => sum + order.creatorCents, 0),
      refundedCents: refunded.reduce((sum, order) => sum + order.grossCents, 0),
      refundCount: refunded.length,
    };
  }, [orders, paidOrders]);

  const gmvSpark = useMemo(
    () =>
      accumulate(
        dailyTotals(
          paidOrders,
          (order) => order.createdAt,
          (order) => order.grossCents,
          SPARK_DAYS,
        ),
      ),
    [paidOrders],
  );

  const filteredOrders = useMemo(
    () => orders.filter((order) => matchesQuery(order, query)),
    [orders, query],
  );
  const filteredBookings = useMemo(
    () => bookings.filter((booking) => matchesQuery(booking, query)),
    [bookings, query],
  );

  const resultCount = tab === "orders" ? filteredOrders.length : filteredBookings.length;
  const resultNoun = tab === "orders" ? "orders" : "bookings";

  return (
    <div className="motion-safe:animate-[pageIn_0.35s_ease-out]">
      <PageHeader
        title="Commerce"
        subtitle="Every dollar moving through the platform — orders, fees, and bookings."
      />

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
        <StatCard
          hero
          label="GMV (paid)"
          value={formatCents(revenue.gmvCents)}
          hint={`${revenue.paidCount} paid orders`}
          icon={<IconDollar />}
          visual={<Sparkline data={gmvSpark} stroke="#ffffff" width={140} height={30} />}
        />
        <StatCard
          label="Platform fees"
          value={formatCents(revenue.feeCents)}
          hint="12% of paid GMV"
          icon={<IconBolt />}
        />
        <StatCard
          label="Processing deducted"
          value={formatCents(revenue.processingFeeCents)}
          hint="Separate from platform fees"
          icon={<IconDollar />}
          iconTint="bg-blue-50 text-blue-600"
        />
        <StatCard
          label="Creator payouts"
          value={formatCents(revenue.creatorCents)}
          hint="After both deductions"
          icon={<IconUsers />}
          iconTint="bg-emerald-50 text-emerald-600"
        />
        <StatCard
          label="Refunded"
          value={formatCents(revenue.refundedCents)}
          hint={`${revenue.refundCount} refunds`}
          icon={<IconInbox />}
          iconTint="bg-gray-100 text-gray-500"
        />
      </div>

      <div className="mt-4">
        <Panel
          title="Where each dollar goes"
          action={
            <span className="text-[11px] font-mono text-gray-400">
              12% platform rate
            </span>
          }
        >
          <div className="px-5 py-4">
            <SplitBar
              segments={[
                {
                  label: "Creator payouts",
                  value: revenue.creatorCents,
                  color: "#9370DB",
                },
                { label: "Platform fee", value: revenue.feeCents, color: "#34d399" },
                {
                  label: "Payment processing",
                  value: revenue.processingFeeCents,
                  color: "#60a5fa",
                },
              ]}
              formatValue={formatCents}
            />
          </div>
        </Panel>
      </div>

      {revenue.paidCount === 0 ? (
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full bg-amber-400 motion-safe:animate-[softPulse_2s_ease-in-out_infinite]"
          />
          <IconAlert size={16} className="shrink-0 text-amber-500" />
          <p className="text-xs text-amber-800">
            $0 paid GMV is expected right now: the Stripe checkout webhook has
            never fired in production, so orders stay stuck in
            &ldquo;created&rdquo; and never flip to paid. These totals are live
            database rows — they will populate once the webhook is fixed.
          </p>
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FilterPill
            label="Orders"
            count={orders.length}
            isActive={tab === "orders"}
            onClick={() => setTab("orders")}
          />
          <FilterPill
            label="Bookings"
            count={bookings.length}
            isActive={tab === "bookings"}
            onClick={() => setTab("bookings")}
          />
        </div>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search buyer, creator, or offer…"
        />
      </div>

      <p className="mt-4 mb-2 text-xs text-gray-400">
        {resultCount} {resultNoun}
      </p>

      {tab === "orders" ? (
        filteredOrders.length > 0 ? (
          <OrdersTable orders={filteredOrders} />
        ) : (
          <EmptyState
            message={
              query.trim() === ""
                ? "No orders yet — checkout has not written any rows."
                : `No orders match "${query}".`
            }
          />
        )
      ) : filteredBookings.length > 0 ? (
        <BookingsTable bookings={filteredBookings} />
      ) : (
        <EmptyState
          message={
            query.trim() === ""
              ? "No bookings yet."
              : `No bookings match "${query}".`
          }
        />
      )}
    </div>
  );
}

/**
 * Deep-link support: the command palette navigates here with ?q=<term>.
 * Keying the page content on the param seeds the search state fresh on every
 * palette jump without any URL→state sync effect. (No armed confirm state
 * exists on this page — refunds live in Stripe.)
 */
function CommerceFromQuery() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  return <CommerceInner key={initialQuery} initialQuery={initialQuery} />;
}

export function CommercePageClient() {
  // useSearchParams requires a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <CommerceFromQuery />
    </Suspense>
  );
}
