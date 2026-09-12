import Link from "next/link";
import { PURCHASE_POLICY, policyParagraphs, type PurchasePolicySection } from "@/lib/purchasePolicies";

export default function PurchasePolicyNotice({ section }: { section: PurchasePolicySection }) {
  return <section className="mt-8 space-y-3 rounded-xl border border-gray-300 p-5 text-gray-700">
    <h2 className="text-xl font-semibold">Versioned purchase agreements</h2>
    <p>{PURCHASE_POLICY.application}</p>
    {policyParagraphs(section).map(text => <p key={text}>{text}</p>)}
    <Link href="/legal/purchase-agreement" className="underline">Read the complete purchase agreement and its version</Link>
    <p className="text-sm">The general and earlier-purchase wording below does not replace the explicitly accepted agreement for a versioned purchase.</p>
  </section>;
}
