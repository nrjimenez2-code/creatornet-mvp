"use client";

import { useRef, useState } from "react";
import { ActionButton } from "@/components/admin/ui";

type Result = {
  reconciledCount: number;
  skippedCount: number;
  failureCount: number;
  nextCursor: string | null;
};

function readResult(value: unknown): Result | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of ["reconciledCount", "skippedCount", "failureCount"]) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) return null;
  }
  if (row.nextCursor !== null && (typeof row.nextCursor !== "string" || !row.nextCursor)) return null;
  return row as Result;
}

export function TipReconciliationControl({ onComplete }: { onComplete: () => void }) {
  const [open, setOpen] = useState(false);
  const [limitText, setLimitText] = useState("1");
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const inFlight = useRef(false);
  const limit = /^\d+$/.test(limitText) ? Number(limitText) : NaN;
  const validLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 50;

  const run = async () => {
    if (!confirmed || !validLimit || inFlight.current || uncertain) return;
    inFlight.current = true;
    setWorking(true);
    setConfirmed(false);
    setResult(null);
    try {
      const response = await fetch("/api/admin/tips/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit, ...(cursor ? { cursor } : {}) }),
      });
      const value: unknown = await response.json();
      const next = response.ok ? readResult(value) : null;
      if (!next) throw new Error("Unconfirmed reconciliation result");
      setResult(next);
      setCursor(next.nextCursor);
      onComplete();
    } catch {
      // A failed response can follow committed updates. Never silently repeat it.
      setUncertain(true);
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  };

  return (
    <div>
      <ActionButton variant="neutral" onClick={() => setOpen(!open)} disabled={working}>
        {open ? "Close reconciliation review" : "Review tip reconciliation"}
      </ActionButton>
      {open ? (
        <section aria-label="Tip reconciliation review" className="mt-3 max-w-xl rounded-xl border border-[#e5ddf5] bg-white p-4 text-sm">
          <p className="font-semibold text-zinc-900">Update tip payment records</p>
          <p className="mt-2 text-gray-600">
            Check saved tips against Stripe and update their payment, fee, refund, and dispute records.
            Pending or failed dispute recovery can also retry transfers to recover or restore funds.
          </p>
          <p className="mt-2 text-gray-600">
            The batch size limits tip records. Dispute recovery runs separately, so this is not a review of one selected tip.
            Search filters do not limit reconciliation.
          </p>
          <label className="mt-3 flex items-center gap-2">
            Tip records per batch
            <input aria-label="Tip records per batch" type="number" min="1" max="50" step="1"
              value={limitText} disabled={working || uncertain}
              onChange={(event) => { setLimitText(event.target.value); setConfirmed(false); }}
              className="w-20 rounded-lg border border-[#e5ddf5] px-2 py-1" />
          </label>
          {!validLimit ? <p role="alert" className="mt-2 text-red-700">Enter a whole number from 1 to 50.</p> : null}
          <label className="mt-3 flex items-start gap-2 text-gray-600">
            <input type="checkbox" checked={confirmed} disabled={working || uncertain}
              onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />
            I reviewed the tip and dispute recovery records and approve this batch.
          </label>
          <div className="mt-3">
            <ActionButton variant="neutral" onClick={run} disabled={!confirmed || !validLimit || working || uncertain}>
              {working ? "Reconciling…" : cursor ? "Run next batch" : "Run reconciliation"}
            </ActionButton>
          </div>
          {result ? (
            <p role="status" className={`mt-3 ${result.failureCount ? "text-amber-800" : "text-gray-600"}`}>
              {result.reconciledCount} reconciled, {result.skippedCount} skipped, {result.failureCount} failures.
              {result.failureCount ? " Review failed tip and recovery records before running another batch." : ""}
              {result.nextCursor ? " More tip records may remain; the next batch requires another confirmation." : " This tip batch reached the end of the list."}
            </p>
          ) : null}
          {uncertain ? (
            <p role="alert" className="mt-3 text-amber-800">
              The result could not be confirmed. Some updates may have completed. Review payment and recovery records, then reload this page before considering another run.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
