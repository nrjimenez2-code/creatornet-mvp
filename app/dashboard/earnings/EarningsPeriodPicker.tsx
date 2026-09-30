"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  earningsUrl,
  resolveEarningsPeriod,
  validCalendarDate,
  type EarningsPeriod,
  type EarningsPreset,
} from "@/lib/earningsPeriod";

import styles from "./earnings.module.css";
import EarningsTimeframeSelect from "./EarningsTimeframeSelect";

export default function EarningsPeriodPicker({ period, needsUrlRepair }: { period: EarningsPeriod | null; needsUrlRepair: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<EarningsPreset>(period?.preset ?? "this-month");
  const [startDate, setStartDate] = useState(period?.startDate ?? "");
  const [endDate, setEndDate] = useState(period?.endDate ?? "");
  const [error, setError] = useState("");

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    if (needsUrlRepair || period?.timeZone !== zone) {
      const next = resolveEarningsPeriod({
        period: period?.preset ?? "this-month",
        tz: zone,
        start: period?.preset === "custom" ? period.startDate : undefined,
        end: period?.preset === "custom" ? period.endDate : undefined,
      });
      if (next) router.replace(earningsUrl(next));
    }
  }, [needsUrlRepair, period, router]);

  function navigate(preset: EarningsPreset, start?: string, end?: string) {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const next = resolveEarningsPeriod({ period: preset, tz: zone, start, end });
    if (!next) {
      setError("Choose a valid start and end date, with the start on or before the end.");
      return;
    }
    setError("");
    startTransition(() => router.push(earningsUrl(next)));
  }

  function choose(value: EarningsPreset) {
    setSelected(value);
    setError("");
    if (value !== "custom") navigate(value);
    else if (!startDate || !endDate) {
      setStartDate(period?.startDate ?? "");
      setEndDate(period?.endDate ?? "");
    }
  }

  function applyCustom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validCalendarDate(startDate) || !validCalendarDate(endDate) || startDate > endDate) {
      setError("Choose a valid start and end date, with the start on or before the end.");
      return;
    }
    navigate("custom", startDate, endDate);
  }

  return (
    <section className={styles.periodControls} aria-label="Earnings timeframe">
      <label htmlFor="earnings-period">Timeframe</label>
      <EarningsTimeframeSelect value={selected} onChange={choose} disabled={pending} />
      {selected === "custom" && (
        <form className={styles.customRange} onSubmit={applyCustom}>
          <label htmlFor="earnings-start">Start <input id="earnings-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></label>
          <label htmlFor="earnings-end">End <input id="earnings-end" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></label>
          <button type="submit" disabled={pending}>Apply</button>
        </form>
      )}
      {error && <p className={styles.validation} role="alert">{error}</p>}
      {pending && <span className={styles.loadingPeriod}>Updating…</span>}
    </section>
  );
}
