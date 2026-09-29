import { fetchCreatorEarningsView, type LedgerRow } from "@/lib/creatorEarningsView";
import { resolveEarningsPeriod } from "@/lib/earningsPeriod";

let mockRows: LedgerRow[] = [];
let mockFailOffset: number | null = null;
const mockRanges: number[] = [];
const mockFrom = jest.fn(() => {
  let lower = "";
  let upper = "";
  let offset = 0;
  let end = 0;
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    gte: (_key: string, value: string) => { lower = value; return query; },
    lt: (_key: string, value: string) => { upper = value; return query; },
    order: () => query,
    range: (from: number, to: number) => { offset = from; end = to; mockRanges.push(from); return query; },
    returns: async () => mockFailOffset === offset
      ? { data: null, error: { message: "query failed" } }
      : { data: mockRows.filter((row) => ["paid", "refunded"].includes(row.status || "") && row.created_at >= lower && row.created_at < upper).slice(offset, end + 1), error: null },
  };
  return query;
});
jest.mock("@/lib/supabaseAdmin", () => ({ supabaseAdmin: { from: () => mockFrom() } }));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: jest.fn() }));

function row(id: string, overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id, purchase_id: null, order_id: null, booking_payment_id: null, stripe_invoice_id: null,
    gross_amount_cents: 100, creator_net_cents: 80, refunded_amount_cents: 0,
    earnings_reversed_cents: 0, disputed_amount_cents: 0, dispute_status: null,
    currency: "usd", status: "paid", created_at: "2026-09-15T12:00:00.000Z", ...overrides,
  };
}

const period = resolveEarningsPeriod({ period: "custom", tz: "UTC", start: "2026-09-01", end: "2026-09-30" })!;
beforeEach(() => { mockRows = []; mockFailOffset = null; mockRanges.length = 0; mockFrom.mockClear(); });

test("totals cover every matching payment while history is paginated", async () => {
  mockRows = Array.from({ length: 1100 }, (_, i) => row(`usd-${i}`));
  mockRows.push(
    row("partial", { refunded_amount_cents: 40, earnings_reversed_cents: 30 }),
    row("full", { status: "refunded", refunded_amount_cents: 100, earnings_reversed_cents: 80 }),
    row("eur", { currency: "eur", gross_amount_cents: 200, creator_net_cents: 160 }),
    row("pending", { status: "pending", gross_amount_cents: 100000 }),
    row("failed", { status: "failed", gross_amount_cents: 100000 }),
    row("outside", { created_at: "2026-10-01T00:00:00.000Z" }),
  );
  const result = await fetchCreatorEarningsView("creator-1", period, 2);
  expect(result).toMatchObject({ ledgerAvailable: true, paymentCount: 1103, page: 2 });
  expect(result.rows).toHaveLength(20);
  expect(result.totals).toEqual([
    { currency: "EUR", grossCents: 200, netCents: 160 },
    { currency: "USD", grossCents: 110200, netCents: 88050 },
  ]);
  expect(mockRanges).toEqual([0, 500, 1000]);
  expect(result.rows[0].id).toBe("usd-20");
});

test("refund and dispute labels stay compact; empty periods do not use a lifetime total", async () => {
  mockRows = [row("partial", { refunded_amount_cents: 10, earnings_reversed_cents: 8 }), row("full", { status: "refunded", refunded_amount_cents: 100, earnings_reversed_cents: 80 }), row("dispute", { dispute_status: "needs_response", disputed_amount_cents: 100 })];
  const result = await fetchCreatorEarningsView("creator-1", period);
  expect(result.rows.map((item) => item.statusLabel)).toEqual(["Partially refunded", "Refunded", "Dispute: needs response"]);
  mockRows = [];
  expect(await fetchCreatorEarningsView("creator-1", period)).toMatchObject({ totals: [], rows: [], paymentCount: 0, ledgerAvailable: true });
});

test("a later batch failure discards partial totals and reports unavailable", async () => {
  mockRows = Array.from({ length: 501 }, (_, i) => row(`usd-${i}`));
  mockFailOffset = 500;
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  expect(await fetchCreatorEarningsView("creator-1", period)).toMatchObject({ totals: [], rows: [], paymentCount: 0, ledgerAvailable: false });
  error.mockRestore();
});
