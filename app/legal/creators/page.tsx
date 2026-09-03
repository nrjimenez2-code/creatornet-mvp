import type { Metadata } from "next";
import Link from "next/link";

// The creator-side rules, in one place. CreatorNet's 12% platform fee and
// standard payment-processing costs are disclosed as separate deductions.

export const metadata: Metadata = {
  title: "Creator Policy",
  description:
    "What creators agree to on CreatorNet — Stripe onboarding, the 12% platform fee, delivery, and content rules.",
};

const LAST_UPDATED = "September 3, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-gray-700 leading-relaxed">{children}</div>
    </section>
  );
}

export default function CreatorPolicyPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Creator Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>
      <p className="mt-4 text-gray-700 leading-relaxed">
        CreatorNet is a marketplace. Creators list short teaching videos, courses, digital
        products, and 1-on-1 calls or mentorship; buyers pay for a specific listing; the creator
        delivers it. This page is what creators agree to, in addition to the{" "}
        <Link href="/legal/terms" className="text-[#655BFF] underline">
          Terms of Service
        </Link>
        .
      </p>

      <Section title="Getting paid">
        <p>
          To sell anything with a price, you connect a Stripe account through Stripe Connect and
          complete Stripe&apos;s onboarding, including its identity verification. You cannot set a
          price or attach a product until Stripe has enabled both charges and payouts on your
          account.
        </p>
        <p>
          <strong>CreatorNet charges a 12% platform fee.</strong> Standard payment-processing fees
          are deducted separately. Your net earnings are the sale amount minus those two separate
          deductions, and Stripe pays that net amount to your bank on its payout schedule. All prices are in
          US dollars (USD).
        </p>
      </Section>

      <Section title="You are responsible for">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong>Delivering what you sell.</strong> A digital product must have its file
            attached before it can be bought. A call or mentorship must be scheduled and held.
          </li>
          <li>
            <strong>Accurate listings.</strong> The title, description, and price must match what
            the buyer receives.
          </li>
          <li>
            <strong>Your own taxes</strong> on what you earn.
          </li>
          <li>
            <strong>Owning or having the rights to</strong> everything you upload.
          </li>
        </ul>
      </Section>

      <Section title="Refunds and disputes">
        <p>
          When a buyer is owed a refund under our{" "}
          <Link href="/legal/refunds" className="text-[#655BFF] underline">
            Refund Policy
          </Link>
          , the portion of creator earnings associated with the refunded sale is reversed.
          CreatorNet records the platform fee, payment-processing deduction, and creator
          earnings separately. Repeated non-delivery or chargebacks can lead to restricted
          selling or account suspension.
        </p>
      </Section>

      <Section title="Content rules">
        <p>
          No illegal, infringing, hateful, exploitative, deceptive, or otherwise harmful content
          or activity. We may remove content, restrict features, or suspend accounts that violate
          these rules or the Terms.
        </p>
      </Section>

      <Section title="Questions">
        <p>
          Email{" "}
          <a href="mailto:support@creatornet.net" className="text-[#655BFF] underline">
            support@creatornet.net
          </a>
          .
        </p>
      </Section>
    </main>
  );
}
