import type { Metadata } from "next";
import { redirect } from "next/navigation";
import BackButton from "@/components/BackButton";
import StripeConnectBanner from "@/components/StripeConnectBanner";
import { fetchCurrentCreatorEarningsView, HISTORY_PAGE_SIZE } from "@/lib/creatorEarningsView";
import { earningsUrl, parseEarningsPage, resolveEarningsPeriod } from "@/lib/earningsPeriod";
import EarningsPeriodPicker from "./EarningsPeriodPicker";
import styles from "./earnings.module.css";

export const metadata: Metadata = {
  title: "Earnings",
  description: "Review your CreatorNet gross and net earnings by timeframe.",
};

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function formatMoney(minorUnits: number, currency: string): string {
  try {
    const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(minorUnits / 10 ** digits);
  } catch {
    return `${currency} ${minorUnits}`;
  }
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  });
}

export default async function EarningsPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const raw = searchParams ? await searchParams : {};
  const period = resolveEarningsPeriod({
    period: single(raw.period), tz: single(raw.tz),
    start: single(raw.start), end: single(raw.end),
  });
  const page = parseEarningsPage(single(raw.page));
  const needsUrlRepair = !period || page === null ||
    Object.values(raw).some(Array.isArray) ||
    (period?.preset !== "custom" && (raw.start !== undefined || raw.end !== undefined));
  const view = period && page && !needsUrlRepair
    ? await fetchCurrentCreatorEarningsView(period, page)
    : null;
  if (period && !needsUrlRepair && !view) redirect("/auth");
  const dates = period ? `${formatDate(period.startDate)} – ${formatDate(period.endDate)}` : "This month";
  const pageCount = view?.ledgerAvailable ? Math.ceil(view.paymentCount / HISTORY_PAGE_SIZE) : 0;

  return (
    <main className={styles.page}>
      <div className={styles.backCorner}><BackButton hrefOverride="/dashboard" className={styles.backButton} /></div>
      <div className={styles.content}>
        <header className={styles.header}>
          <h1>Earnings</h1>
          <p>See what customers paid and what you earned.</p>
        </header>
        <div className={styles.panel}>
          <div className={styles.toolbar}>
            <EarningsPeriodPicker key={period ? `${period.preset}:${period.timeZone}:${period.startDate}:${period.endDate}` : "pending"} period={period} needsUrlRepair={needsUrlRepair} />
            <section className={styles.connection} aria-label="Stripe account setup"><StripeConnectBanner appearance="earnings" /></section>
          </div>
          <p className={styles.selectedDates}>{dates}{period && <span> · {period.timeZone}</span>}</p>
          <div className={styles.totals} aria-label="Period totals">
            <section className={styles.totalCard} aria-label="Gross for selected period">
              <h2>Gross</h2>
              {!view ? <p className={styles.totalUnavailable}>Loading…</p> : !view.ledgerAvailable ? <p className={styles.totalUnavailable}>Unavailable</p> : view.totals.length === 0 ? <p className={styles.totalEmpty}>—</p> :
                view.totals.map((item) => <p key={item.currency} className={styles.total}><span>{item.currency}</span>{formatMoney(item.grossCents, item.currency)}</p>)}
            </section>
            <section className={styles.totalCard} aria-label="Net for selected period">
              <h2>Net</h2>
              {!view ? <p className={styles.totalUnavailable}>Loading…</p> : !view.ledgerAvailable ? <p className={styles.totalUnavailable}>Unavailable</p> : view.totals.length === 0 ? <p className={styles.totalEmpty}>—</p> :
                view.totals.map((item) => <p key={item.currency} className={styles.total}><span>{item.currency}</span>{formatMoney(item.netCents, item.currency)}</p>)}
            </section>
          </div>
          {!period || needsUrlRepair ? (
            <p className={styles.unavailable} role="status">Loading this period in your browser time zone…</p>
          ) : !view?.ledgerAvailable ? (
            <p className={styles.unavailable} role="status">Earnings for this period are temporarily unavailable. Please try again.</p>
          ) : (
            <section className={styles.history} aria-labelledby="payment-history-heading">
              <div className={styles.historyHeading}>
                <h2 id="payment-history-heading">Payment history</h2>
                <span>{view.paymentCount} {view.paymentCount === 1 ? "payment" : "payments"}</span>
              </div>
              {view.paymentCount === 0 ? (
                <div className={styles.empty}><h3>No tracked payments for this period</h3><p>New recorded payments will appear here.</p></div>
              ) : view.rows.length === 0 ? (
                <p className={styles.empty}>No payments on this page. <a href={earningsUrl(period, Math.max(1, page - 1))}>Previous page</a></p>
              ) : (
                <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Payment history details">
                  <table className={styles.table}>
                    <thead><tr><th>Payment / date</th><th>Gross</th><th>Net</th><th>Status</th></tr></thead>
                    <tbody>{view.rows.map((row) => (
                      <tr key={row.id}>
                        <td><strong>{row.label}</strong><small>{new Date(row.createdAt).toLocaleString("en-US", { timeZone: period.timeZone, dateStyle: "medium", timeStyle: "short" })}</small></td>
                        <td>{formatMoney(row.grossCents, row.currency)}</td>
                        <td>{formatMoney(row.currentNetCents, row.currency)}</td>
                        <td><span className={styles.status}>{row.statusLabel}</span></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {pageCount > 1 && <nav className={styles.pagination} aria-label="Payment history pages">
                {page > 1 ? <a href={earningsUrl(period, page - 1)}>Previous</a> : <span />}
                <span>Page {page} of {pageCount}</span>
                {page < pageCount ? <a href={earningsUrl(period, page + 1)}>Next</a> : <span />}
              </nav>}
            </section>
          )}
          <p className={styles.historyNote}>Earlier sales may not appear in this recorded payment history.</p>
        </div>
      </div>
    </main>
  );
}
