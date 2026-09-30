import "server-only";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createServerClient } from "@/lib/supabaseServer";
import type { EarningsPeriod } from "@/lib/earningsPeriod";

const QUERY_BATCH = 500;
export const HISTORY_PAGE_SIZE = 20;

export type LedgerRow = {
  id: string;
  purchase_id: string | null;
  order_id: string | null;
  booking_payment_id: string | null;
  stripe_invoice_id: string | null;
  gross_amount_cents: number | null;
  creator_net_cents: number | null;
  refunded_amount_cents: number | null;
  earnings_reversed_cents: number | null;
  disputed_amount_cents: number | null;
  dispute_status: string | null;
  currency: string | null;
  status: string | null;
  created_at: string;
};

export type CreatorEarningsRow = {
  id: string;
  label: string;
  grossCents: number;
  currentNetCents: number;
  currency: string;
  createdAt: string;
  statusLabel: string;
};

export type CurrencyTotals = {
  currency: string;
  grossCents: number;
  netCents: number;
};

export type CreatorEarningsView = {
  totals: CurrencyTotals[];
  rows: CreatorEarningsRow[];
  paymentCount: number;
  page: number;
  ledgerAvailable: boolean;
};

function cents(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value as number) : 0;
}

function paymentLabel(row: LedgerRow): string {
  if (row.stripe_invoice_id) return "Installment payment";
  if (row.booking_payment_id) return "Booking payment";
  if (row.purchase_id || row.order_id) return "Product sale";
  return "Creator payment";
}

export function describePaymentStatus(row: LedgerRow): string {
  const dispute = row.dispute_status?.replace(/_/g, " ");
  if (dispute) return `Dispute: ${dispute}`;
  if (cents(row.refunded_amount_cents) >= cents(row.gross_amount_cents) && cents(row.refunded_amount_cents) > 0) return "Refunded";
  if (cents(row.refunded_amount_cents) > 0) return "Partially refunded";
  return "Paid";
}

export function addLedgerRow(totals: Map<string, CurrencyTotals>, row: LedgerRow): CreatorEarningsRow | null {
  if (row.status !== "paid" && row.status !== "refunded") return null;
  const currency = (row.currency || "usd").toUpperCase();
  const grossCents = cents(row.gross_amount_cents);
  const creatorNetCents = cents(row.creator_net_cents);
  const currentNetCents = Math.max(0, creatorNetCents - Math.min(creatorNetCents, cents(row.earnings_reversed_cents)));
  const current = totals.get(currency) ?? { currency, grossCents: 0, netCents: 0 };
  current.grossCents += grossCents;
  current.netCents += currentNetCents;
  totals.set(currency, current);
  return { id: row.id, label: paymentLabel(row), grossCents, currentNetCents, currency, createdAt: row.created_at, statusLabel: describePaymentStatus(row) };
}

/**
 * The ledger is service-role-only. The caller derives creatorId from the
 * authenticated server session, never from a URL or browser request.
 * Scan every matching row in bounded batches; the visible page is only a slice.
 */
export async function fetchCreatorEarningsView(creatorId: string, period: EarningsPeriod, page = 1): Promise<CreatorEarningsView> {
  const totals = new Map<string, CurrencyTotals>();
  const rows: CreatorEarningsRow[] = [];
  let paymentCount = 0;
  let offset = 0;
  const firstIndex = (page - 1) * HISTORY_PAGE_SIZE;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from("payment_fee_ledger")
      .select("id, purchase_id, order_id, booking_payment_id, stripe_invoice_id, gross_amount_cents, creator_net_cents, refunded_amount_cents, earnings_reversed_cents, disputed_amount_cents, dispute_status, currency, status, created_at")
      .eq("creator_id", creatorId)
      .in("status", ["paid", "refunded"])
      .gte("created_at", period.startUtc)
      .lt("created_at", period.endExclusiveUtc)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + QUERY_BATCH - 1)
      .returns<LedgerRow[]>();
    if (error || !data) {
      console.error("[earnings-view] ledger query failed:", error?.message ?? "No data returned");
      return { totals: [], rows: [], paymentCount: 0, page, ledgerAvailable: false };
    }
    for (const ledgerRow of data) {
      const mapped = addLedgerRow(totals, ledgerRow);
      if (!mapped) continue;
      if (paymentCount >= firstIndex && paymentCount < firstIndex + HISTORY_PAGE_SIZE) rows.push(mapped);
      paymentCount++;
    }
    if (data.length < QUERY_BATCH) break;
    offset += QUERY_BATCH;
  }
  return { totals: Array.from(totals.values()).sort((a, b) => a.currency.localeCompare(b.currency)), rows, paymentCount, page, ledgerAvailable: true };
}

export async function fetchCurrentCreatorEarningsView(period: EarningsPeriod, page = 1): Promise<CreatorEarningsView | null> {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  return fetchCreatorEarningsView(user.id, period, page);
}
