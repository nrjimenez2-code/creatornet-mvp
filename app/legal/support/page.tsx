import type { Metadata } from "next";
import Link from "next/link";

// Stripe wants customer-service contact "including direct communication
// channels, such as email addresses, phone numbers, and live chat (something
// besides contact forms)". Email is the channel CreatorNet actually operates.
// Do NOT add a phone number or chat here unless someone will answer it —
// an unanswered channel is worse for a Stripe review than no channel.

export const metadata: Metadata = {
  title: "Support",
  description: "How to reach CreatorNet about a purchase, a payout, or your account.",
};

export default function SupportPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Support</h1>
      <p className="mt-4 text-gray-700 leading-relaxed">
        The fastest way to reach us is email. Write from the address on your CreatorNet account
        so we can find your purchases.
      </p>

      <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-5">
        <p className="text-sm text-gray-500">Email</p>
        <a
          href="mailto:support@creatornet.net"
          className="mt-1 block text-xl font-semibold text-[#655BFF] underline"
        >
          support@creatornet.net
        </a>
      </div>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">What to include</h2>
        <ul className="mt-3 list-disc pl-5 space-y-2 text-gray-700 leading-relaxed">
          <li>
            <strong>A purchase problem:</strong> the item name, the creator, and the date. If you
            have it, the receipt Stripe emailed you.
          </li>
          <li>
            <strong>A payout problem (creators):</strong> the sale and the date you expected it.
          </li>
          <li>
            <strong>An account problem:</strong> what you were trying to do and what you saw.
          </li>
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Before you write</h2>
        <ul className="mt-3 list-disc pl-5 space-y-2 text-gray-700 leading-relaxed">
          <li>
            <Link href="/legal/refunds" className="text-[#655BFF] underline">
              Refund Policy
            </Link>{" "}
            — when a purchase can be refunded.
          </li>
          <li>
            <Link href="/legal/delivery" className="text-[#655BFF] underline">
              Delivery &amp; Cancellation Policy
            </Link>{" "}
            — how you receive what you bought, and how to stop an installment plan.
          </li>
          <li>
            <Link href="/legal/creators" className="text-[#655BFF] underline">
              Creator Policy
            </Link>{" "}
            — fees, payouts and delivery for sellers.
          </li>
        </ul>
      </section>
    </main>
  );
}
