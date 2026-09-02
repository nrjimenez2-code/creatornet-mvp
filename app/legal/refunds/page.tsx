import type { Metadata } from "next";
import Link from "next/link";

// Stripe's website checklist requires a refund policy that "describes the
// conditions under which customers can receive a refund". The Terms already
// say refunds are handled case by case; this page states the cases. Written
// to match the Terms, not to change them — if the two ever disagree, fix both.

export const metadata: Metadata = {
  title: "Refund Policy",
  description:
    "When a CreatorNet purchase can be refunded, how to ask, and how long it takes.",
};

const LAST_UPDATED = "September 2, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-gray-700 leading-relaxed">{children}</div>
    </section>
  );
}

export default function RefundPolicyPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Refund Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>
      <p className="mt-4 text-gray-700 leading-relaxed">
        Every price on CreatorNet is in <strong>US dollars (USD)</strong> and is set by the
        creator. Payment is taken by Stripe on a Stripe-hosted checkout page; CreatorNet never
        sees your card details. This page explains when a purchase can be refunded.
      </p>

      <Section title="You are entitled to a refund when">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong>You didn&apos;t receive what you paid for.</strong> The file never appeared
            in your Library, or a call or mentorship session was never delivered.
          </li>
          <li>
            <strong>What you received is materially different from the listing.</strong>
          </li>
          <li>
            <strong>You were charged more than once</strong> for the same purchase.
          </li>
        </ul>
      </Section>

      <Section title="Refunds are generally not given when">
        <ul className="list-disc pl-5 space-y-2">
          <li>
            You have already downloaded or watched a digital product, course, or video and it
            matches its listing.
          </li>
          <li>A 1-on-1 call or mentorship session took place as described.</li>
          <li>You changed your mind after a session was delivered.</li>
        </ul>
        <p>
          Outside the cases above, refunds are handled case by case, as the{" "}
          <Link href="/legal/terms" className="text-[#655BFF] underline">
            Terms of Service
          </Link>{" "}
          describe. Nothing here limits any refund right you have under the law where you live.
        </p>
      </Section>

      <Section title="How to ask">
        <p>
          Email{" "}
          <a href="mailto:support@creatornet.net" className="text-[#655BFF] underline">
            support@creatornet.net
          </a>{" "}
          from the address on your CreatorNet account. Include the name of the item, the
          creator, the date, and what went wrong. We will work it out with the creator and reply
          to you.
        </p>
        <p>
          Approved refunds go back to the original payment method through Stripe. Stripe
          usually posts them within 5–10 business days, depending on your bank.
        </p>
      </Section>

      <Section title="Installment plans">
        <p>
          Installments already paid are covered by the same rules above. To stop future
          installments, see the{" "}
          <Link href="/legal/delivery" className="text-[#655BFF] underline">
            Delivery &amp; Cancellation Policy
          </Link>
          .
        </p>
      </Section>
    </main>
  );
}
