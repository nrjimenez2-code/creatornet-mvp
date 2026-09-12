"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/admin/Toast";
import { formatCents } from "@/lib/admin/format";
import {
  REFUND_REASON_OPTIONS,
  reasonMatchesResponsibility,
  type RefundReasonCode,
  type RefundResponsibility,
} from "@/lib/refundAllocation";
import type { AdminOrder } from "@/types/admin";

interface RefundPreviewResponse {
  paymentFeeLedgerId: string;
  currency: string;
  grossAmountCents: number;
  customerRefundCents: number;
  refundedBeforeCents: number;
  cumulativeCustomerRefundTargetCents: number;
  remainingRefundableCents: number;
  creatorEarningsReversalCents: number;
  creatorBalanceImpactCents: number;
  platformFeeRefundCents: number;
  processingFeeAllocationCents: number;
  processingCostBearer: RefundResponsibility;
  allocationRoundingCents: number;
  applicationFeeRefundAmountCents: number;
  applicationFeeRefundTargetCents: number;
  actualStripeProcessingFeeCents: number | null;
}

export function dollarsToCents(value: string): number | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fractional = ""] = normalized.split(".");
  const result = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, "0"));
  return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : null;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
  }
  return fallback;
}

function SummaryRow({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string;
  tone?: "normal" | "positive" | "warning";
}) {
  const valueClass =
    tone === "positive"
      ? "text-emerald-700"
      : tone === "warning"
        ? "text-amber-700"
        : "text-zinc-900";
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#f0ebfb] py-2.5 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

const fieldClass =
  "w-full rounded-xl border border-[#e5ddf5] bg-white px-3 py-2.5 text-sm text-zinc-900 shadow-sm transition placeholder:text-gray-400 hover:border-[#d5c8ef] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:ring-offset-1";

export function RefundDialog({
  order,
  onClose,
}: {
  order: AdminOrder;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const remaining = order.remainingRefundableCents ?? 0;
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [responsibility, setResponsibility] =
    useState<RefundResponsibility>("creator");
  const [reasonCode, setReasonCode] =
    useState<RefundReasonCode>("creator_non_delivery");
  const [notes, setNotes] = useState("");
  const [preview, setPreview] = useState<RefundPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  const getIdempotencyKey = () => {
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = window.crypto.randomUUID();
    }
    return idempotencyKeyRef.current;
  };

  const reasonOptions = useMemo(
    () =>
      REFUND_REASON_OPTIONS.filter(
        (option) =>
          option.responsibility === "either" ||
          option.responsibility === responsibility,
      ),
    [responsibility],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, working]);

  const chooseResponsibility = (next: RefundResponsibility) => {
    setResponsibility(next);
    if (!reasonMatchesResponsibility(reasonCode, next)) {
      const first = REFUND_REASON_OPTIONS.find(
        (option) =>
          option.responsibility === next || option.responsibility === "either",
      );
      if (first) setReasonCode(first.value);
    }
    setPreview(null);
    setError(null);
  };

  const preparePreview = async () => {
    const amountCents = dollarsToCents(amount);
    if (!amountCents || amountCents > remaining) {
      setError(`Enter an amount between $0.01 and ${formatCents(remaining)}.`);
      return;
    }
    if (!order.paymentLedgerId) {
      setError("This transaction is missing its payment ledger.");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/refunds/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentFeeLedgerId: order.paymentLedgerId,
          amountCents,
          reasonCode,
          responsibility,
          internalNotes: notes,
          idempotencyKey: getIdempotencyKey(),
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(errorMessage(body, "The refund preview could not be prepared."));
      }
      const next = (body as { preview?: RefundPreviewResponse }).preview;
      if (!next) throw new Error("The refund preview was incomplete.");
      setPreview(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The refund preview failed.");
    } finally {
      setWorking(false);
    }
  };

  const confirmRefund = async () => {
    if (!preview || !order.paymentLedgerId) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentFeeLedgerId: order.paymentLedgerId,
          amountCents: preview.customerRefundCents,
          reasonCode,
          responsibility,
          internalNotes: notes,
          idempotencyKey: getIdempotencyKey(),
          expectedRefundedBeforeCents: preview.refundedBeforeCents,
          expectedApplicationFeeRefundedBeforeCents:
            preview.applicationFeeRefundTargetCents -
            preview.applicationFeeRefundAmountCents,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok && response.status !== 202) {
        throw new Error(errorMessage(body, "The refund could not be created safely."));
      }
      const disposition =
        body && typeof body === "object" && "disposition" in body
          ? String((body as { disposition?: unknown }).disposition)
          : "processing";
      if (disposition === "completed") {
        toast("success", `Refunded ${formatCents(preview.customerRefundCents)} to the customer`);
      } else {
        toast(
          "info",
          "The customer refund is recorded, but its fee allocation needs review or retry.",
        );
      }
      router.refresh();
      onClose();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "The refund failed.";
      setError(message);
      if (/changed after the preview/i.test(message)) setPreview(null);
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/40 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !working) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="refund-dialog-title"
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-[#e9e3f7] bg-white shadow-[0_24px_70px_rgba(24,16,44,0.28)]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#f0ebfb] px-6 py-5">
          <div>
            <p className="text-[11px] font-bold tracking-wider text-[#7c5cbf] uppercase">
              Admin refund
            </p>
            <h2 id="refund-dialog-title" className="mt-1 text-xl font-black tracking-tight text-zinc-900">
              {preview ? "Confirm customer refund" : order.offerTitle}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {preview
                ? "Review the exact split before creating the Stripe refund."
                : `${formatCents(remaining)} remains refundable.`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={working}
            aria-label="Close refund dialog"
            className="rounded-lg p-2 text-gray-400 transition hover:bg-[#f8f5ff] hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:outline-none disabled:opacity-50"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5">
          {preview ? (
            <>
              <div className="rounded-2xl border border-[#e9e3f7] bg-[#fbf9ff] px-4 py-2">
                <SummaryRow label="Customer receives" value={formatCents(preview.customerRefundCents)} tone="positive" />
                <SummaryRow label="Creator earnings reversed" value={formatCents(preview.creatorEarningsReversalCents)} />
                <SummaryRow label="CreatorNet 12% fee returned" value={formatCents(preview.platformFeeRefundCents)} />
                <SummaryRow
                  label={`Processing cost assigned to ${preview.processingCostBearer === "creator" ? "creator" : "CreatorNet"}`}
                  value={formatCents(preview.processingFeeAllocationCents)}
                  tone="warning"
                />
                <SummaryRow label="Expected creator balance impact" value={formatCents(preview.creatorBalanceImpactCents)} />
                <SummaryRow label="Remaining refundable" value={formatCents(preview.remainingRefundableCents)} />
              </div>
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm leading-relaxed text-amber-900">
                This submits a refund through Stripe to the customer&apos;s original payment method in the current payment mode. It cannot simply be undone.
              </div>
            </>
          ) : (
            <div className="space-y-5">
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label htmlFor="refund-amount" className="text-sm font-bold text-zinc-800">Refund amount</label>
                  <button
                    type="button"
                    onClick={() => setAmount((remaining / 100).toFixed(2))}
                    className="text-xs font-bold text-[#7c5cbf] hover:underline"
                  >
                    Use full amount
                  </button>
                </div>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-gray-400">$</span>
                  <input
                    id="refund-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setPreview(null);
                      setError(null);
                    }}
                    className={`${fieldClass} pl-7 tabular-nums`}
                  />
                </div>
                <p className="mt-1.5 text-xs text-gray-400">The customer always receives the full approved amount.</p>
              </div>

              <fieldset>
                <legend className="text-sm font-bold text-zinc-800">Who is responsible?</legend>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(["creator", "platform"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={responsibility === value}
                      onClick={() => chooseResponsibility(value)}
                      className={`rounded-xl border px-3 py-2.5 text-sm font-bold transition focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:outline-none ${
                        responsibility === value
                          ? "border-transparent bg-gradient-to-br from-[#9370DB] to-[#7c5cbf] text-white shadow-[0_3px_12px_rgba(109,78,182,0.28)]"
                          : "border-[#e5ddf5] bg-white text-gray-600 hover:bg-[#f8f5ff]"
                      }`}
                    >
                      {value === "creator" ? "Creator" : "CreatorNet"}
                    </button>
                  ))}
                </div>
              </fieldset>

              <div>
                <label htmlFor="refund-reason" className="text-sm font-bold text-zinc-800">Reason</label>
                <select
                  id="refund-reason"
                  value={reasonCode}
                  onChange={(event) => {
                    setReasonCode(event.target.value as RefundReasonCode);
                    setPreview(null);
                    setError(null);
                  }}
                  className={`${fieldClass} mt-2`}
                >
                  {reasonOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="refund-notes" className="text-sm font-bold text-zinc-800">Internal notes <span className="font-normal text-gray-400">(optional)</span></label>
                <textarea
                  id="refund-notes"
                  value={notes}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) => {
                    setNotes(event.target.value);
                    setPreview(null);
                  }}
                  placeholder="What was reviewed or approved?"
                  className={`${fieldClass} mt-2 resize-y`}
                />
              </div>
            </div>
          )}

          {error ? (
            <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm font-medium text-red-700">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#f0ebfb] bg-[#fbf9ff]/70 px-6 py-4">
          {preview ? (
            <button
              type="button"
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
              disabled={working}
              className="rounded-xl border border-[#e5ddf5] bg-white px-4 py-2.5 text-sm font-bold text-gray-600 transition hover:bg-[#f8f5ff] focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:outline-none disabled:opacity-50"
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              disabled={working}
              className="rounded-xl border border-[#e5ddf5] bg-white px-4 py-2.5 text-sm font-bold text-gray-600 transition hover:bg-[#f8f5ff] focus-visible:ring-2 focus-visible:ring-[#9370DB] focus-visible:outline-none disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={preview ? confirmRefund : preparePreview}
            disabled={working}
            className={`rounded-xl px-4 py-2.5 text-sm font-bold text-white shadow-sm transition focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
              preview
                ? "bg-red-600 hover:bg-red-700 focus-visible:ring-red-500"
                : "bg-gradient-to-br from-[#9370DB] to-[#7c5cbf] hover:shadow-[0_4px_14px_rgba(109,78,182,0.32)] focus-visible:ring-[#9370DB]"
            }`}
          >
            {working ? "Working…" : preview ? `Confirm ${formatCents(preview.customerRefundCents)} refund` : "Review refund"}
          </button>
        </div>
      </div>
    </div>
  );
}
