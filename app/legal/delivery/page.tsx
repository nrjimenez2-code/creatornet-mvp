import type { Metadata } from "next";
import Link from "next/link";

// Stripe's checklist asks for a delivery policy AND a cancellation policy.
// CreatorNet sells installment plans as recurring Stripe subscriptions, so the
// cancellation half is not optional. The plan-stops-when-paid-off behaviour
// described below is real: app/api/stripe/webhook/route.ts sets
// cancel_at_period_end on the final invoice.

export const metadata: Metadata = {
  title: "Delivery & Cancellation Policy",
  description:
    "How CreatorNet purchases are delivered, and how to cancel an installment plan.",
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

export default function DeliveryPolicyPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Delivery &amp; Cancellation Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>
      <p className="mt-4 text-gray-700 leading-relaxed">
        Everything sold on CreatorNet is delivered digitally or as a live session. Nothing is
        shipped. The creator you buy from is the seller responsible for delivering it, as the{" "}
        <Link href="/legal/terms" className="text-[#655BFF] underline">
          Terms of Service
        </Link>{" "}
        explain.
      </p>

      <Section title="Digital products, courses and videos">
        <p>
          Access is granted <strong>immediately after your payment succeeds.</strong> Your
          purchase appears in your Library, where you can watch or download it. If it isn&apos;t
          there within a few minutes, email{" "}
          <a href="mailto:support@creatornet.net" className="text-[#655BFF] underline">
            support@creatornet.net
          </a>{" "}
          and we will fix it.
        </p>
      </Section>

      <Section title="1-on-1 calls and mentorship">
        <p>
          After payment, the creator&apos;s booking link is provided so you can schedule the
          session. Sessions are held by the creator, at the time you both agree, using the tool
          the creator specifies. If a creator does not schedule or hold a paid session, our{" "}
          <Link href="/legal/refunds" className="text-[#655BFF] underline">
            Refund Policy
          </Link>{" "}
          applies.
        </p>
      </Section>

      <Section title="Installment plans">
        <p>
          Some items can be paid in monthly installments. An installment plan is a recurring
          monthly charge through Stripe for a fixed number of months, shown to you before you
          agree. <strong>It stops automatically once the final installment is paid</strong> —
          you will not be charged beyond the number of months you agreed to.
        </p>
      </Section>

      <Section title="Cancelling an installment plan">
        <p>
          You can cancel at any time by emailing{" "}
          <a href="mailto:support@creatornet.net" className="text-[#655BFF] underline">
            support@creatornet.net
          </a>{" "}
          from your account&apos;s email address. Cancellation takes effect at the end of the
          current billing month: you will not be charged again after that, and access to any
          not-yet-unlocked portion of the item ends. Installments already paid are not refunded
          except under the{" "}
          <Link href="/legal/refunds" className="text-[#655BFF] underline">
            Refund Policy
          </Link>
          .
        </p>
      </Section>
    </main>
  );
}
