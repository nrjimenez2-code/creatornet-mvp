import "server-only";
import { adminClient } from "@/lib/admin/server";
import type {
  AdminBooking,
  AdminInitialData,
  AdminOrder,
  AdminRefundStatus,
  BookingStatus,
  OrderKind,
  OrderStatus,
} from "@/types/admin";

/** Server-only transaction data for the existing CreatorNet commerce page. */
const MAX_ROWS = 500;

interface OrderRow {
  id: string;
  buyer_id: string | null;
  buyer_user_id: string | null;
  creator_id: string | null;
  post_id: string | null;
  booking_id: string | null;
  status: string;
  gross_amount: number;
  platform_fee: number;
  processing_fee: number | null;
  creator_amount: number;
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
  id: string;
  booking_id: string;
  buyer_id: string | null;
  plan_type: string;
  amount_total_cents: number | null;
  installment_amount_cents: number | null;
  status: string;
  created_at: string;
}

interface PurchaseRow {
  id: string;
  buyer_id: string | null;
  buyer_user_id: string | null;
  booking_id: string | null;
  title: string | null;
  kind: string | null;
  subscription_id: string | null;
  order_id: string | null;
}

interface LedgerRow {
  id: string;
  creator_id: string;
  purchase_id: string | null;
  order_id: string | null;
  booking_payment_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  gross_amount_cents: number;
  platform_fee_cents: number;
  processing_fee_cents: number;
  creator_net_cents: number;
  refunded_amount_cents: number;
  status: string;
  created_at: string;
}

interface RefundOperationRow {
  id: string;
  payment_fee_ledger_id: string;
  status: AdminRefundStatus;
  reason_code: string;
  responsibility: "creator" | "platform";
  customer_refund_amount_cents: number;
  creator_balance_impact_cents: number;
  platform_fee_refund_amount_cents: number;
  processing_fee_allocation_cents: number;
  cumulative_customer_refund_target_cents: number;
  remaining_refundable_cents: number;
  connected_balance_negative: boolean | null;
  webhook_confirmed_at: string | null;
  created_at: string;
}

interface ProfileNameRow {
  id: string;
  username: string | null;
  full_name: string | null;
}

const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  created: "pending",
  paid: "paid",
  refunded: "refunded",
  canceled: "failed",
};

const BOOKING_STATUS_MAP: Record<string, BookingStatus> = {
  pending: "pending",
  confirmed: "confirmed",
  completed: "completed",
  canceled: "canceled",
  cancelled: "canceled",
};

const ACTIVE_REFUND_STATUSES = new Set<AdminRefundStatus>([
  "pending",
  "stripe_refund_created",
  "application_fee_adjusted",
  "needs_reconciliation",
]);

function shortId(id: string): string {
  return id.slice(0, 8);
}

function uniqueIds(values: ReadonlyArray<string | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => value !== null)));
}

function safeCents(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : 0;
}

function paymentKind(
  ledger: LedgerRow,
  order: OrderRow | undefined,
  purchase: PurchaseRow | undefined,
  bookingPayment: BookingPaymentRow | undefined,
): OrderKind {
  if (
    ledger.stripe_invoice_id ||
    purchase?.subscription_id ||
    bookingPayment?.plan_type === "installment"
  ) {
    return "installments";
  }
  if (ledger.booking_payment_id || order?.booking_id || purchase?.booking_id) {
    return "booking";
  }
  return "product";
}

export async function fetchCommerceInitialData(): Promise<AdminInitialData> {
  const admin = adminClient();
  const [ordersResult, bookingsResult, bookingPaymentsResult, ledgersResult, refundsResult] =
    await Promise.all([
      admin
        .from("orders")
        .select(
          "id, buyer_id, buyer_user_id, creator_id, post_id, booking_id, status, gross_amount, platform_fee, processing_fee, creator_amount, created_at, updated_at",
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
      admin
        .from("booking_payments")
        .select(
          "id, booking_id, buyer_id, plan_type, amount_total_cents, installment_amount_cents, status, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS)
        .returns<BookingPaymentRow[]>(),
      admin
        .from("payment_fee_ledger")
        .select(
          "id, creator_id, purchase_id, order_id, booking_payment_id, stripe_payment_intent_id, stripe_invoice_id, gross_amount_cents, platform_fee_cents, processing_fee_cents, creator_net_cents, refunded_amount_cents, status, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS)
        .returns<LedgerRow[]>(),
      admin
        .from("refund_operations")
        .select(
          "id, payment_fee_ledger_id, status, reason_code, responsibility, customer_refund_amount_cents, creator_balance_impact_cents, platform_fee_refund_amount_cents, processing_fee_allocation_cents, cumulative_customer_refund_target_cents, remaining_refundable_cents, connected_balance_negative, webhook_confirmed_at, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS)
        .returns<RefundOperationRow[]>(),
    ]);

  if (ordersResult.error) throw new Error(`Commerce orders query failed: ${ordersResult.error.message}`);
  if (bookingsResult.error) throw new Error(`Commerce bookings query failed: ${bookingsResult.error.message}`);
  if (bookingPaymentsResult.error) {
    throw new Error(`Commerce booking payments query failed: ${bookingPaymentsResult.error.message}`);
  }
  if (ledgersResult.error) throw new Error(`Commerce payment ledger query failed: ${ledgersResult.error.message}`);
  if (refundsResult.error) throw new Error(`Commerce refund operations query failed: ${refundsResult.error.message}`);

  const orderRows = ordersResult.data ?? [];
  const bookingRows = bookingsResult.data ?? [];
  const bookingPaymentRows = bookingPaymentsResult.data ?? [];
  const ledgerRows = ledgersResult.data ?? [];
  const refundRows = refundsResult.data ?? [];
  const purchaseIds = uniqueIds(ledgerRows.map((row) => row.purchase_id));
  const purchasesResult = purchaseIds.length
    ? await admin
        .from("purchases")
        .select("id, buyer_id, buyer_user_id, booking_id, title, kind, subscription_id, order_id")
        .in("id", purchaseIds)
        .returns<PurchaseRow[]>()
    : { data: [] as PurchaseRow[], error: null };
  if (purchasesResult.error) {
    throw new Error(`Commerce purchases query failed: ${purchasesResult.error.message}`);
  }
  const purchaseRows = purchasesResult.data ?? [];

  const profileIds = uniqueIds([
    ...orderRows.map((row) => row.buyer_id ?? row.buyer_user_id),
    ...orderRows.map((row) => row.creator_id),
    ...bookingRows.map((row) => row.buyer_id),
    ...bookingRows.map((row) => row.creator_id),
    ...bookingPaymentRows.map((row) => row.buyer_id),
    ...ledgerRows.map((row) => row.creator_id),
    ...purchaseRows.map((row) => row.buyer_id ?? row.buyer_user_id),
  ]);
  const profilesResult = profileIds.length
    ? await admin
        .from("profiles")
        .select("id, username, full_name")
        .in("id", profileIds)
        .returns<ProfileNameRow[]>()
    : { data: [] as ProfileNameRow[], error: null };
  if (profilesResult.error) {
    throw new Error(`Commerce profiles query failed: ${profilesResult.error.message}`);
  }

  const nameById = new Map<string, string>();
  for (const profile of profilesResult.data ?? []) {
    const name = profile.username ?? profile.full_name;
    if (name) nameById.set(profile.id, name);
  }
  const usernameFor = (id: string | null): string =>
    (id ? nameById.get(id) : undefined) ?? "unknown";

  const orderById = new Map(orderRows.map((row) => [row.id, row]));
  const bookingById = new Map(bookingRows.map((row) => [row.id, row]));
  const bookingPaymentById = new Map(bookingPaymentRows.map((row) => [row.id, row]));
  const purchaseById = new Map(purchaseRows.map((row) => [row.id, row]));
  const refundsByLedger = new Map<string, RefundOperationRow[]>();
  for (const refund of refundRows) {
    const current = refundsByLedger.get(refund.payment_fee_ledger_id) ?? [];
    current.push(refund);
    refundsByLedger.set(refund.payment_fee_ledger_id, current);
  }

  const orders: AdminOrder[] = ledgerRows.map((ledger) => {
    const order = ledger.order_id ? orderById.get(ledger.order_id) : undefined;
    const purchase = ledger.purchase_id ? purchaseById.get(ledger.purchase_id) : undefined;
    const bookingPayment = ledger.booking_payment_id
      ? bookingPaymentById.get(ledger.booking_payment_id)
      : undefined;
    const bookingId =
      order?.booking_id ?? purchase?.booking_id ?? bookingPayment?.booking_id ?? null;
    const booking = bookingId ? bookingById.get(bookingId) : undefined;
    const buyerId =
      order?.buyer_id ??
      order?.buyer_user_id ??
      purchase?.buyer_id ??
      purchase?.buyer_user_id ??
      bookingPayment?.buyer_id ??
      booking?.buyer_id ??
      null;
    const operations = refundsByLedger.get(ledger.id) ?? [];
    const latest = operations[0] ?? null;
    const reservedRefundCents = operations
      .filter((row) => row.status !== "failed")
      .reduce(
        (highest, row) =>
          Math.max(highest, safeCents(row.cumulative_customer_refund_target_cents)),
        safeCents(ledger.refunded_amount_cents),
      );
    const remainingRefundableCents = Math.max(
      0,
      safeCents(ledger.gross_amount_cents) - reservedRefundCents,
    );
    const activeOperation = operations.find((row) => ACTIVE_REFUND_STATUSES.has(row.status));
    let refundBlockedReason: string | null = null;
    if (!ledger.stripe_payment_intent_id) {
      refundBlockedReason = "Payment is not linked to Stripe.";
    } else if (ledger.status !== "paid" && ledger.status !== "refunded") {
      refundBlockedReason = "Payment has not completed.";
    } else if (remainingRefundableCents <= 0) {
      refundBlockedReason = "Payment is fully refunded or already reserved.";
    } else if (activeOperation) {
      refundBlockedReason =
        activeOperation.status === "needs_reconciliation"
          ? "Resolve the current refund before creating another."
          : "A refund is already being processed.";
    }
    const kind = paymentKind(ledger, order, purchase, bookingPayment);
    const labelId = order?.id ?? bookingId ?? ledger.id;
    const offerTitle =
      purchase?.title?.trim() ||
      (kind === "installments"
        ? `Installment ${shortId(ledger.id)}`
        : kind === "booking"
          ? `Booking ${shortId(labelId)}`
          : `Order ${shortId(labelId)}`);

    return {
      id: order?.id ?? `payment-${ledger.id}`,
      buyerUserId: buyerId ?? "",
      buyerUsername: usernameFor(buyerId),
      creatorId: ledger.creator_id,
      creatorUsername: usernameFor(ledger.creator_id),
      postId: order?.post_id ?? null,
      offerTitle,
      kind,
      grossCents: safeCents(ledger.gross_amount_cents),
      feeCents: safeCents(ledger.platform_fee_cents),
      processingFeeCents: safeCents(ledger.processing_fee_cents),
      creatorCents: safeCents(ledger.creator_net_cents),
      status:
        ledger.status === "refunded" ||
        safeCents(ledger.refunded_amount_cents) >= safeCents(ledger.gross_amount_cents)
          ? "refunded"
          : ledger.status === "paid"
            ? "paid"
            : "pending",
      createdAt: ledger.created_at,
      paymentLedgerId: ledger.id,
      refundedCents: safeCents(ledger.refunded_amount_cents),
      remainingRefundableCents,
      refundEligible: refundBlockedReason === null,
      refundBlockedReason,
      latestRefund: latest
        ? {
            id: latest.id,
            status: latest.status,
            reasonCode: latest.reason_code,
            responsibility: latest.responsibility,
            customerRefundCents: safeCents(latest.customer_refund_amount_cents),
            creatorBalanceImpactCents: safeCents(latest.creator_balance_impact_cents),
            platformFeeRefundCents: safeCents(latest.platform_fee_refund_amount_cents),
            processingFeeAllocationCents: safeCents(latest.processing_fee_allocation_cents),
            remainingRefundableCents: safeCents(latest.remaining_refundable_cents),
            connectedBalanceNegative: latest.connected_balance_negative,
            webhookConfirmed: latest.webhook_confirmed_at !== null,
            createdAt: latest.created_at,
          }
        : null,
    };
  });

  const ledgerOrderIds = new Set(
    ledgerRows.map((row) => row.order_id).filter((id): id is string => id !== null),
  );
  for (const row of orderRows) {
    if (ledgerOrderIds.has(row.id)) continue;
    const buyerId = row.buyer_id ?? row.buyer_user_id;
    orders.push({
      id: row.id,
      buyerUserId: buyerId ?? "",
      buyerUsername: usernameFor(buyerId),
      creatorId: row.creator_id ?? "",
      creatorUsername: usernameFor(row.creator_id),
      postId: row.post_id,
      offerTitle: `Order ${shortId(row.id)}`,
      kind: row.booking_id ? "booking" : "product",
      grossCents: safeCents(row.gross_amount),
      feeCents: safeCents(row.platform_fee),
      processingFeeCents: safeCents(row.processing_fee),
      creatorCents: safeCents(row.creator_amount),
      status: ORDER_STATUS_MAP[row.status] ?? "pending",
      createdAt: row.created_at ?? row.updated_at,
      paymentLedgerId: null,
      refundedCents: 0,
      remainingRefundableCents: 0,
      refundEligible: false,
      refundBlockedReason: "Payment ledger is not available.",
      latestRefund: null,
    });
  }
  orders.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const amountByBooking = new Map<string, number>();
  for (const payment of bookingPaymentRows) {
    const amount = payment.amount_total_cents ?? payment.installment_amount_cents;
    if (amount === null) continue;
    amountByBooking.set(
      payment.booking_id,
      (amountByBooking.get(payment.booking_id) ?? 0) + safeCents(amount),
    );
  }
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

  return { users: [], videos: [], orders, bookings };
}
