import type { Metadata } from "next";
import { redirect } from "next/navigation";
import BackButton from "@/components/BackButton";
import StripeConnectBanner from "@/components/StripeConnectBanner";
import {
  fetchCurrentCreatorEarningsView,
  type CreatorEarningsRow,
} from "@/lib/creatorEarningsView";

import styles from "./earnings.module.css";

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
    <main className={styles.page}>
      <div className={styles.backCorner}><BackButton hrefOverride="/dashboard" className={styles.backButton} /></div>
      <div className={styles.content}>
        <header className={styles.header}>
          <h1>Earnings</h1>
          <p>Your earnings, clearly broken down.</p>
        </header>
        <div className={styles.panel}>
          <div className={styles.overview}>
            <div><p className={styles.totalLabel}>Recorded net earnings</p><p className={styles.total}>{formatMoney(view.recordedEarningsCents, "USD")}</p></div>
            <section className={styles.connection} aria-label="Stripe account setup">
              <StripeConnectBanner appearance="earnings" />
            </section>
          </div>
        {!view.ledgerAvailable ? (
          <div className={styles.unavailable} role="status">
            Detailed transaction history is temporarily unavailable. Your recorded earnings total above is unchanged.
          </div>
        ) : view.rows.length === 0 ? (
          <section aria-labelledby="empty-history-heading">
            <div className={styles.historyHeading}><h2 id="empty-history-heading">Payment history</h2><span>0 payments</span></div>
            <div className={styles.emptyColumns} aria-hidden="true"><span>Payment</span><span>Gross</span><span>Platform fee</span><span>Processing</span><span>Your net</span></div>
            <div className={styles.empty}>
              <svg width="44" height="52" viewBox="0 0 44 52" fill="none" aria-hidden="true"><path d="M8 3h28a3 3 0 0 1 3 3v42l-6-4-6 4-5-4-5 4-6-4-6 4V6a3 3 0 0 1 3-3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M13 16h18M13 25h18" stroke="#7659ef" strokeWidth="1.5"/><path d="M13 34h14" stroke="currentColor" strokeWidth="1.5"/></svg>
              <h3>No tracked payments yet</h3>
              <p>New sales will appear here with a clear breakdown<br className={styles.desktopBreak} /> of fees and your net earnings.</p>
            </div>
          </section>
        ) : (
          <>
            <section className={styles.trackedSummary} aria-labelledby="tracked-summary-heading">
              <div>
                <h2 id="tracked-summary-heading" className="text-lg font-semibold">
                  Tracked transaction summary
                </h2>
                <p className="mt-1 text-xs text-white/50">
                  Totals are kept separate by currency and reflect the transactions listed below.
                </p>
              </div>

              {currencyTotals.map((totals) => (
                <div key={totals.currency} className={styles.currencyTotals}>
                  {[
                    ["Gross sales", totals.grossCents],
                    ["CreatorNet fee (12%)", totals.platformFeeCents],
                    ["Payment processing", totals.processingFeeCents],
                    ["Creator net", totals.currentNetCents],
                  ].map(([label, amount]) => (
                    <div
                      key={String(label)}
                      className={styles.currencyStat}
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

            <section className={styles.history} aria-labelledby="transaction-history-heading">
              <div className="mb-3 flex items-end justify-between gap-4">
                <div>
                  <h2 id="transaction-history-heading" className="text-lg font-semibold">
                    Payment history
                  </h2>
                  <p className="mt-1 text-xs text-white/50">
                    Each row shows the original payment split plus refund and dispute status.
                  </p>
                </div>
                <span className="text-xs text-white/40">{view.rows.length} payments</span>
              </div>

              <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Payment history details">
                <table className={styles.table}>
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
                        <td className="px-4 py-4 font-semibold tabular-nums text-white">
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
          <footer className={styles.footer}>12% platform fee. Payment-processing fees are deducted separately.</footer>
        </div>
      </div>
    </main>
  );
}
