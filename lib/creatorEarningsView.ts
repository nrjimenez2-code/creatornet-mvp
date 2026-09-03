import "server-only";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createServerClient } from "@/lib/supabaseServer";

const HISTORY_LIMIT = 100;

type LedgerRow = {
  id: string;
  purchase_id: string | null;
  order_id: string | null;
  booking_payment_id: string | null;
  stripe_invoice_id: string | null;
  gross_amount_cents: number | null;
  platform_fee_cents: number | null;
  processing_fee_cents: number | null;
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
  platformFeeCents: number;
  processingFeeCents: number;
  creatorNetCents: number;
  refundedGrossCents: number;
  reversedEarningsCents: number;
  disputedAmountCents: number;
  disputeStatus: string | null;
  currentNetCents: number;
  currency: string;
  status: string;
  createdAt: string;
};

export type CreatorEarningsView = {
  recordedEarningsCents: number;
  rows: CreatorEarningsRow[];
  ledgerAvailable: boolean;
  historyLimited: boolean;
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

/**
 * Load only the signed-in creator's financial rows. payment_fee_ledger is
 * service-role-only, so callers must derive creatorId from the authenticated
 * server session rather than from a URL or client-provided value.
 */
export async function fetchCreatorEarningsView(
  creatorId: string,
): Promise<CreatorEarningsView> {
  const [profileResult, ledgerResult] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("total_earnings_cents")
      .eq("id", creatorId)
      .maybeSingle<{ total_earnings_cents: number | null }>(),
    supabaseAdmin
      .from("payment_fee_ledger")
      .select(
        "id, purchase_id, order_id, booking_payment_id, stripe_invoice_id, gross_amount_cents, platform_fee_cents, processing_fee_cents, creator_net_cents, refunded_amount_cents, earnings_reversed_cents, disputed_amount_cents, dispute_status, currency, status, created_at",
      )
      .eq("creator_id", creatorId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT + 1)
      .returns<LedgerRow[]>(),
  ]);

  if (profileResult.error) {
    console.error("[earnings-view] profile total query failed:", profileResult.error.message);
  }

  if (ledgerResult.error) {
    console.error("[earnings-view] fee ledger query failed:", ledgerResult.error.message);
    return {
      recordedEarningsCents: cents(profileResult.data?.total_earnings_cents),
      rows: [],
      ledgerAvailable: false,
      historyLimited: false,
    };
  }

  const ledgerRows = ledgerResult.data ?? [];
  const rows = ledgerRows.slice(0, HISTORY_LIMIT).map((row): CreatorEarningsRow => {
    const creatorNetCents = cents(row.creator_net_cents);
    const reversedEarningsCents = Math.min(
      creatorNetCents,
      cents(row.earnings_reversed_cents),
    );

    return {
      id: row.id,
      label: paymentLabel(row),
      grossCents: cents(row.gross_amount_cents),
      platformFeeCents: cents(row.platform_fee_cents),
      processingFeeCents: cents(row.processing_fee_cents),
      creatorNetCents,
      refundedGrossCents: cents(row.refunded_amount_cents),
      reversedEarningsCents,
      disputedAmountCents: cents(row.disputed_amount_cents),
      disputeStatus: row.dispute_status,
      currentNetCents: Math.max(0, creatorNetCents - reversedEarningsCents),
      currency: (row.currency || "usd").toUpperCase(),
      status: row.status || "paid",
      createdAt: row.created_at,
    };
  });

  return {
    recordedEarningsCents: cents(profileResult.data?.total_earnings_cents),
    rows,
    ledgerAvailable: true,
    historyLimited: ledgerRows.length > HISTORY_LIMIT,
  };
}

/** Resolve identity from the server session so no creator id comes from UI input. */
export async function fetchCurrentCreatorEarningsView(): Promise<CreatorEarningsView | null> {
  const supabase = createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return fetchCreatorEarningsView(user.id);
}
