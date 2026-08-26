import "server-only";
import { adminClient } from "@/lib/admin/server";
import type {
  AdminBooking,
  AdminInitialData,
  AdminOrder,
  BookingStatus,
  OrderStatus,
} from "@/types/admin";

/**
 * Server-side data for /admin/commerce. Fetched with the service-role client
 * (RLS bypassed) — ONLY call from server components already behind the admin
 * layout gate.
 *
 * Column names verified against supabase/schema/snapshot-2026-08-12.sql;
 * nothing here is invented.
 */

const MAX_ROWS = 500;

interface OrderRow {
  id: string;
  /** Both buyer columns exist and both FK auth.users; older rows may fill only one. */
  buyer_id: string | null;
  buyer_user_id: string | null;
  creator_id: string | null;
  post_id: string | null;
  booking_id: string | null;
  status: string;
  gross_amount: number;
  platform_fee: number;
  creator_amount: number;
  /** Nullable in the live schema — updated_at (NOT NULL) is the fallback. */
  created_at: string | null;
  updated_at: string;
}

interface BookingRow {
  id: string;
  creator_id: string;
  buyer_id: string;
  status: string;
  created_at: string;
}

interface BookingPaymentRow {
  booking_id: string;
  amount_total_cents: number | null;
}

interface ProfileNameRow {
  id: string;
  username: string | null;
  full_name: string | null;
}

/**
 * DB check constraint allows exactly created|paid|refunded|canceled.
 * The board's vocabulary: created = money not captured yet, canceled = the
 * checkout died — closest to "failed" (there is no failed state in the DB).
 */
const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  created: "pending",
  paid: "paid",
  refunded: "refunded",
  canceled: "failed",
};

/** bookings.status is free text with no check constraint — normalize defensively. */
const BOOKING_STATUS_MAP: Record<string, BookingStatus> = {
  pending: "pending",
  confirmed: "confirmed",
  completed: "completed",
  canceled: "canceled",
  cancelled: "canceled",
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

function uniqueIds(values: ReadonlyArray<string | null>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => value !== null)),
  );
}

export async function fetchCommerceInitialData(): Promise<AdminInitialData> {
  const admin = adminClient();

  const [ordersResult, bookingsResult] = await Promise.all([
    admin
      .from("orders")
      .select(
        "id, buyer_id, buyer_user_id, creator_id, post_id, booking_id, status, gross_amount, platform_fee, creator_amount, created_at, updated_at",
      )
      .order("created_at", { ascending: false, nullsFirst: false })
      .limit(MAX_ROWS)
      .returns<OrderRow[]>(),
    admin
      .from("bookings")
      .select("id, creator_id, buyer_id, status, created_at")
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS)
      .returns<BookingRow[]>(),
  ]);

  if (ordersResult.error) {
    throw new Error(`Commerce orders query failed: ${ordersResult.error.message}`);
  }
  if (bookingsResult.error) {
    throw new Error(
      `Commerce bookings query failed: ${bookingsResult.error.message}`,
    );
  }

  const orderRows = ordersResult.data ?? [];
  const bookingRows = bookingsResult.data ?? [];

  const bookingIds = bookingRows.map((row) => row.id);
  const profileIds = uniqueIds([
    ...orderRows.map((row) => row.buyer_id ?? row.buyer_user_id),
    ...orderRows.map((row) => row.creator_id),
    ...bookingRows.map((row) => row.buyer_id),
    ...bookingRows.map((row) => row.creator_id),
  ]);

  const [paymentsResult, profilesResult] = await Promise.all([
    bookingIds.length > 0
      ? admin
          .from("booking_payments")
          .select("booking_id, amount_total_cents")
          .in("booking_id", bookingIds)
          .returns<BookingPaymentRow[]>()
      : Promise.resolve({ data: [] as BookingPaymentRow[], error: null }),
    profileIds.length > 0
      ? admin
          .from("profiles")
          .select("id, username, full_name")
          .in("id", profileIds)
          .returns<ProfileNameRow[]>()
      : Promise.resolve({ data: [] as ProfileNameRow[], error: null }),
  ]);

  if (paymentsResult.error) {
    throw new Error(
      `Commerce booking_payments query failed: ${paymentsResult.error.message}`,
    );
  }
  if (profilesResult.error) {
    throw new Error(
      `Commerce profiles query failed: ${profilesResult.error.message}`,
    );
  }

  const nameById = new Map<string, string>();
  for (const profile of profilesResult.data ?? []) {
    const name = profile.username ?? profile.full_name;
    if (name !== null && name !== "") {
      nameById.set(profile.id, name);
    }
  }
  const usernameFor = (id: string | null): string =>
    (id !== null ? nameById.get(id) : undefined) ?? "unknown";

  // Sum captured totals per booking; a booking with no priced payment shows TBD.
  const amountByBooking = new Map<string, number>();
  for (const payment of paymentsResult.data ?? []) {
    if (payment.amount_total_cents === null) continue;
    amountByBooking.set(
      payment.booking_id,
      (amountByBooking.get(payment.booking_id) ?? 0) + payment.amount_total_cents,
    );
  }

  const orders: AdminOrder[] = orderRows.map((row) => {
    const buyerId = row.buyer_id ?? row.buyer_user_id;
    const kind = row.booking_id !== null ? "booking" : "product";
    return {
      id: row.id,
      buyerUserId: buyerId ?? "",
      buyerUsername: usernameFor(buyerId),
      creatorId: row.creator_id ?? "",
      creatorUsername: usernameFor(row.creator_id),
      postId: row.post_id,
      // Offering titles are not joined here — the row id keeps the label
      // honest and lets the admin cross-reference Stripe/DB directly.
      offerTitle: `Order ${shortId(row.id)}`,
      kind,
      grossCents: row.gross_amount,
      feeCents: row.platform_fee,
      creatorCents: row.creator_amount,
      status: ORDER_STATUS_MAP[row.status] ?? "pending",
      createdAt: row.created_at ?? row.updated_at,
    };
  });

  const bookings: AdminBooking[] = bookingRows.map((row) => ({
    id: row.id,
    creatorId: row.creator_id,
    creatorUsername: usernameFor(row.creator_id),
    buyerUserId: row.buyer_id,
    buyerUsername: usernameFor(row.buyer_id),
    offerTitle: `Booking ${shortId(row.id)}`,
    amountCents: amountByBooking.get(row.id) ?? null,
    status: BOOKING_STATUS_MAP[row.status.toLowerCase()] ?? "pending",
    createdAt: row.created_at,
  }));

  // The commerce page only reads orders/bookings; users/videos stay empty in
  // this page-scoped seed (other pages seed their own slices).
  return { users: [], videos: [], orders, bookings };
}
