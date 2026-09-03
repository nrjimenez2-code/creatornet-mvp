import type { Metadata } from "next";
import { redirect } from "next/navigation";
import BackButton from "@/components/BackButton";
import {
  fetchCurrentCreatorEarningsView,
  type CreatorEarningsRow,
} from "@/lib/creatorEarningsView";

export const metadata: Metadata = {
  title: "Earnings",
  description: "Review your CreatorNet sales, fees, processing costs, and net earnings.",
};

export const dynamic = "force-dynamic";

type CurrencyTotals = {
  currency: string;
  grossCents: number;
  platformFeeCents: number;
  processingFeeCents: number;
  currentNetCents: number;
};

function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

function readableStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function totalsByCurrency(rows: CreatorEarningsRow[]): CurrencyTotals[] {
  const totals = new Map<string, CurrencyTotals>();

  for (const row of rows) {
    if (row.status === "pending" || row.status === "failed") continue;
    const current = totals.get(row.currency) ?? {
      currency: row.currency,
      grossCents: 0,
      platformFeeCents: 0,
      processingFeeCents: 0,
      currentNetCents: 0,
    };
    current.grossCents += row.grossCents;
    current.platformFeeCents += row.platformFeeCents;
    current.processingFeeCents += row.processingFeeCents;
    current.currentNetCents += row.currentNetCents;
    totals.set(row.currency, current);
  }

  return Array.from(totals.values()).sort((a, b) => a.currency.localeCompare(b.currency));
}

export default async function EarningsPage() {
  const view = await fetchCurrentCreatorEarningsView();
  if (!view) redirect("/auth");
  const currencyTotals = totalsByCurrency(view.rows);

  return (
    <main className="min-h-screen bg-[#05060A] px-4 py-5 text-white sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <BackButton hrefOverride="/dashboard" />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#8D7DFF]">
              Creator finances
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Earnings</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60">
              Every sale keeps CreatorNet&apos;s 12% platform fee separate from payment
              processing, so you can see exactly how your net earnings are calculated.
            </p>
          </div>
          <div className="rounded-2xl border border-[#6C5CE7]/35 bg-[#6C5CE7]/10 px-5 py-4 sm:min-w-60">
            <p className="text-xs text-white/55">Recorded net earnings</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {formatMoney(view.recordedEarningsCents, "USD")}
            </p>
            <p className="mt-1 text-[11px] text-white/45">From your CreatorNet profile record</p>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/65">
          CreatorNet charges a 12% platform fee. Standard payment-processing fees are deducted
          separately.
        </div>

        {!view.ledgerAvailable ? (
          <div className="mt-6 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-5 text-sm text-amber-100">
            Detailed transaction history is temporarily unavailable. Your recorded earnings total
            above is unchanged.
          </div>
        ) : view.rows.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.04] p-8 text-center">
            <h2 className="font-semibold">No tracked payments yet</h2>
            <p className="mt-2 text-sm text-white/55">
              New sales will appear here with the platform fee, processing deduction, and creator
              net shown separately.
            </p>
          </div>
        ) : (
          <>
            <section className="mt-6 space-y-4" aria-labelledby="tracked-summary-heading">
              <div>
                <h2 id="tracked-summary-heading" className="text-lg font-semibold">
                  Tracked transaction summary
                </h2>
                <p className="mt-1 text-xs text-white/50">
                  Totals are kept separate by currency and reflect the transactions listed below.
                </p>
              </div>

              {currencyTotals.map((totals) => (
                <div key={totals.currency} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[
                    ["Gross sales", totals.grossCents],
                    ["CreatorNet fee (12%)", totals.platformFeeCents],
                    ["Payment processing", totals.processingFeeCents],
                    ["Creator net", totals.currentNetCents],
                  ].map(([label, amount]) => (
                    <div
                      key={String(label)}
                      className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"
                    >
                      <p className="text-xs text-white/50">{label}</p>
                      <p className="mt-1 text-xl font-semibold tabular-nums">
                        {formatMoney(Number(amount), totals.currency)}
                      </p>
                    </div>
                  ))}
                </div>
              ))}
            </section>

            <section className="mt-8" aria-labelledby="transaction-history-heading">
              <div className="mb-3 flex items-end justify-between gap-4">
                <div>
                  <h2 id="transaction-history-heading" className="text-lg font-semibold">
                    Transaction history
                  </h2>
                  <p className="mt-1 text-xs text-white/50">
                    Each row shows the original payment split plus refund and dispute status.
                  </p>
                </div>
                <span className="text-xs text-white/40">{view.rows.length} payments</span>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.035]">
                <table className="w-full min-w-[1080px] text-left text-sm">
                  <thead className="border-b border-white/10 text-xs text-white/45">
                    <tr>
                      <th className="px-4 py-3 font-medium">Payment</th>
                      <th className="px-4 py-3 font-medium">Gross</th>
                      <th className="px-4 py-3 font-medium">CreatorNet fee (12%)</th>
                      <th className="px-4 py-3 font-medium">Processing</th>
                      <th className="px-4 py-3 font-medium">Original creator net</th>
                      <th className="px-4 py-3 font-medium">Refund adjustment</th>
                      <th className="px-4 py-3 font-medium">Dispute</th>
                      <th className="px-4 py-3 font-medium">Current net</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10">
                    {view.rows.map((row) => (
                      <tr key={row.id} className="text-white/80">
                        <td className="px-4 py-4">
                          <p className="font-medium text-white">{row.label}</p>
                          <p className="mt-1 text-xs text-white/45">
                            {new Date(row.createdAt).toLocaleString("en-US")}
                          </p>
                          <span className="mt-2 inline-flex rounded-full bg-white/10 px-2 py-0.5 text-[11px] capitalize text-white/65">
                            {readableStatus(row.status)}
                          </span>
                        </td>
                        <td className="px-4 py-4 tabular-nums">
                          {formatMoney(row.grossCents, row.currency)}
                        </td>
                        <td className="px-4 py-4 tabular-nums">
                          {formatMoney(row.platformFeeCents, row.currency)}
                        </td>
                        <td className="px-4 py-4 tabular-nums">
                          {formatMoney(row.processingFeeCents, row.currency)}
                        </td>
                        <td className="px-4 py-4 tabular-nums">
                          {formatMoney(row.creatorNetCents, row.currency)}
                        </td>
                        <td className="px-4 py-4 tabular-nums text-amber-200">
                          {row.reversedEarningsCents > 0
                            ? `−${formatMoney(row.reversedEarningsCents, row.currency)}`
                            : formatMoney(0, row.currency)}
                        </td>
                        <td className="px-4 py-4 tabular-nums">
                          {row.disputedAmountCents > 0 ? (
                            <>
                              <span className="text-amber-200">
                                {formatMoney(row.disputedAmountCents, row.currency)}
                              </span>
                              <p className="mt-1 text-[11px] capitalize text-white/45">
                                {readableStatus(row.disputeStatus || "open")}
                              </p>
                            </>
                          ) : (
                            <span className="text-white/40">None</span>
                          )}
                        </td>
                        <td className="px-4 py-4 font-semibold tabular-nums text-emerald-300">
                          {formatMoney(row.currentNetCents, row.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="mt-4 text-xs leading-5 text-white/40">
              Detailed history starts when CreatorNet&apos;s payment fee ledger is enabled and may
              not include earlier sales. Your recorded earnings total remains the source for older
              earnings. {view.historyLimited ? "Only the latest 100 tracked payments are shown." : ""}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
