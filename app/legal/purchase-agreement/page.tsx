import type { Metadata } from "next";
import { PURCHASE_POLICY, purchasePoliciesActive } from "@/lib/purchasePolicies";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Versioned Purchase Agreement" };
export default function PurchaseAgreementPage() {
  const active = purchasePoliciesActive(process.env);
  return <main>
    <h1 className="text-3xl font-bold">Versioned Purchase Agreement</h1>
    <p className="mt-3 text-sm">Version: {PURCHASE_POLICY.version}</p>
    {!active && <p role="status" className="mt-4 rounded-lg border p-4 font-semibold">Draft only. This version is not active. Legal review, schema installation and activation approval are required.</p>}
    <p className="mt-4">{PURCHASE_POLICY.application}</p>
    {([
      ["Refund requests", "refunds"], ["Refund eligibility and whole-package mentorships", "eligibility"],
      ["Paid calls", "calls"], ["Delivery and service duration", "delivery"],
      ["Fixed-total installments", "installments"], ["Monthly mentorships", "memberships"],
      ["Automatic payment authorization", "authorization"], ["Refund amounts and fees", "refundFees"],
      [active ? "Governing law and courts" : "Proposed governing law and courts, pending legal review", "jurisdiction"],
      ["Support", "support"],
    ] as const).map(([title, key]) => <section className="mt-8" key={key}>
      <h2 className="text-xl font-semibold">{title}</h2><p className="mt-3 leading-relaxed text-gray-700">{PURCHASE_POLICY[key]}</p>
    </section>)}
  </main>;
}
