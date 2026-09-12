"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ActionButton, EmptyState, PageHeader, Panel } from "@/components/admin/ui";
import { formatCents } from "@/lib/admin/format";
import type { ExactAdminPage, ExactAdminPlan } from "@/lib/installments/adminView";

const outcomes: Record<string, string> = {
  action_required: "Buyer verification needed",
  payment_method_required: "Payment method needs attention",
  payment_pending: "Payment outcome pending — do not retry",
  terminal_unpaid: "Payment ended unpaid — balance not waived",
  paid_accounted: "Payment received and recorded — hold still needs review",
  review_required: "Payment evidence needs review",
};

export function InstallmentReview({ initial }: { initial: ExactAdminPage }) {
  const [page, setPage] = useState(initial);
  const [cursor, setCursor] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [selected, setSelected] = useState<ExactAdminPlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refreshRequired, setRefreshRequired] = useState(false);
  const requests = useRef(new Map<string, string>());
  const choose = (plan: ExactAdminPlan) => {
    setSelected(plan); setConfirmed(false); setError(""); setNotice("");
  };
  const load = async (next: string | null) => {
    const response = await fetch(`/api/admin/installments${next ? `?after=${encodeURIComponent(next)}` : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Review records could not be refreshed. Do not submit another request yet.");
    const body = await response.json() as ExactAdminPage;
    if (!body || !Array.isArray(body.plans)) throw new Error("Review records could not be refreshed.");
    setPage(body); setCursor(next); setSelected(null); setConfirmed(false); setRefreshRequired(false);
  };
  const refresh = async (next: string | null) => {
    setWorking(true); setError("");
    try { await load(next); } catch { setError("Review records could not be refreshed. Do not submit another request yet."); }
    finally { setWorking(false); }
  };
  const stop = async () => {
    if (!selected || !confirmed || working || refreshRequired) return;
    const plan = selected;
    if (plan.stop && (!plan.stop.ownedByCaller || plan.stop.status === "complete")) return;
    let requestId = plan.stop?.requestId ?? requests.current.get(plan.id);
    if (!requestId) { requestId = crypto.randomUUID(); requests.current.set(plan.id, requestId); }
    setWorking(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/installments", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreementId: plan.id, requestId, confirmation: "STOP_FUTURE_BILLING" }) });
      const body: { status?: string } = await response.json();
      if (!response.ok) throw new Error("needs review");
      setNotice(body.status === "collection_stopped" ?
        "Future billing is stopped. No refund, access change, or balance waiver was performed." :
        "The stop is not confirmed. Its review hold remains; reconcile pending payments before retrying this same request.");
      await load(cursor);
    } catch {
      // A lost response is not proof that the stop failed. The next GET returns
      // the durable original request ID; never manufacture a retry operation.
      setError("The stop is not confirmed. Refresh records to check its saved state before retrying. Do not create a new request.");
      setConfirmed(false);
      setRefreshRequired(true);
    } finally { setWorking(false); }
  };

  return <div>
    <Link href="/admin/commerce" className="mb-4 inline-block text-sm font-semibold text-[#7c5cbf]">← Commerce</Link>
    <PageHeader title="Installment review" subtitle="Staging only · Fixed-total plans, payment holds, and approved billing stops."
      actions={<ActionButton variant="neutral" disabled={working} onClick={() => refresh(cursor)}>{working ? "Working…" : "Refresh records"}</ActionButton>} />
    <p className="mb-5 rounded-xl border border-[#e9e3f7] bg-[#f8f5ff] p-4 text-sm text-gray-600">
      These are saved observations, not a live payment guarantee. Stopping future billing does not issue a refund,
      remove access, or forgive the unpaid balance. Resolve those separately under the agreed policy.
    </p>
    {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mb-4 rounded-xl bg-[#f3eefc] p-4 text-sm text-[#6b4fae]">{notice}</p>}
    {!page.plans.length ? <EmptyState message="No installment plans on this page." /> :
      <div className="space-y-4">{page.plans.map(plan => <Panel key={plan.id}>
        <div className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><h2 className="font-bold text-zinc-900">{plan.title}</h2>
              <p className="mt-1 text-sm text-gray-500">{formatCents(plan.totalCents)} total · {plan.paymentCount} payments · {plan.status.replaceAll("_", " ")}</p>
              <p className="mt-2 break-all text-xs text-gray-400">Plan {plan.id}</p>
            </div>
            <ActionButton variant="danger" disabled={working || refreshRequired || plan.stop?.status === "complete" || !!plan.stop && !plan.stop.ownedByCaller}
              onClick={() => choose(plan)}>
              {plan.stop?.status === "complete" ? "Billing stopped" : plan.stop ? "Review saved stop" : "Stop future billing"}
            </ActionButton>
          </div>
          {plan.stop && !plan.stop.ownedByCaller && plan.stop.status !== "complete" &&
            <p className="mt-3 text-sm text-amber-700">The administrator who started this request must review it. No second request will be created.</p>}
          <p className="mt-3 text-sm text-gray-600">{plan.holds.length ? `Collection held: ${plan.holds.map(h => h.replaceAll("_", " ")).join(", ")}.` : "No saved collection holds. Other collection checks still apply."}</p>
          {plan.recoveries.map((r, i) => <p key={i} className="mt-2 text-sm text-amber-700">
            {outcomes[r.outcome] ?? "Payment evidence needs review"}{r.observedAt ? ` · Observed ${new Date(r.observedAt).toISOString()}` : " · Awaiting observation"}
          </p>)}
          {selected?.id === plan.id && <section aria-label={`Confirm billing stop for ${plan.title}`} className="mt-5 rounded-xl border border-[#e9e3f7] bg-[#f8f5ff] p-4">
            <p className="text-sm text-zinc-800">Confirm stopping future billing for this plan. An unpaid first checkout may be expired.
              Already-started payments must be reconciled; this action cannot undo a charge.</p>
            <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
              <input type="checkbox" className="mt-1 accent-[#9370DB]" checked={confirmed} disabled={working || refreshRequired} onChange={e => setConfirmed(e.target.checked)} />
              I have reviewed this exact plan and authorize stopping future billing only.
            </label>
            <div className="mt-4 flex flex-wrap gap-3">
              <ActionButton variant="neutral" disabled={working} onClick={() => setSelected(null)}>Go back</ActionButton>
              <ActionButton variant="danger" disabled={working || !confirmed || refreshRequired} onClick={stop}>{working ? "Checking saved state…" : "Confirm billing stop"}</ActionButton>
            </div>
          </section>}
        </div>
      </Panel>)}</div>}
    <div className="mt-5 flex gap-3">
      {cursor && <ActionButton variant="neutral" disabled={working} onClick={() => refresh(null)}>First page</ActionButton>}
      {page.nextCursor && <ActionButton variant="neutral" disabled={working} onClick={() => refresh(page.nextCursor)}>Next page</ActionButton>}
    </div>
  </div>;
}
