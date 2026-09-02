import Link from "next/link";
import Faq, { type FaqItem } from "./Faq";

// Section 6. The mockup's last answer pointed creators to "the CreatorNet
// Discord". No such channel exists, and inventing a support route is exactly
// what the brief (and a Stripe reviewer) would hold against us — so it points
// at the support channel that is real and monitored.
const ITEMS: FaqItem[] = [
  {
    q: "What can creators sell on CreatorNet?",
    a: "Creators can list courses, mentorship, 1-on-1 calls, and digital products with clear pricing and deliverables. All prices are in US dollars (USD).",
  },
  {
    q: "How do creators get paid?",
    a: "Creators connect a payout account through Stripe. After CreatorNet's 12% platform fee is deducted, the remainder is routed to the creator's Stripe account.",
  },
  {
    q: "What happens after a customer buys?",
    a: (
      <>
        The customer receives the access details, download, or booking instructions for that
        specific offer — digital items appear in their Library right after payment. See the{" "}
        <Link href="/legal/delivery" style={{ textDecoration: "underline" }}>
          Delivery &amp; Cancellation Policy
        </Link>
        .
      </>
    ),
  },
  {
    q: "Does CreatorNet support refunds and disputes?",
    a: (
      <>
        Yes. The{" "}
        <Link href="/legal/refunds" style={{ textDecoration: "underline" }}>
          Refund Policy
        </Link>{" "}
        sets out when a purchase is refunded, and{" "}
        <a href="mailto:support@creatornet.net" style={{ textDecoration: "underline" }}>
          support@creatornet.net
        </a>{" "}
        handles any transaction issue with the creator involved.
      </>
    ),
  },
  {
    q: "Where can creators get help?",
    a: (
      <>
        Email{" "}
        <a href="mailto:support@creatornet.net" style={{ textDecoration: "underline" }}>
          support@creatornet.net
        </a>{" "}
        for onboarding, product setup, payments, and account questions. The{" "}
        <Link href="/legal/creators" style={{ textDecoration: "underline" }}>
          Creator Policy
        </Link>{" "}
        covers fees, payouts and what creators are responsible for.
      </>
    ),
  },
];

export default function FaqSection() {
  return (
    <section className="cn-site-faq" id="cn-site-faq">
      <div className="cn-site-faq-panel">
        <div className="cn-site-width cn-site-faq-inner">
          <p className="cn-site-section-label">FAQ</p>
          <h2 className="cn-site-section-title">Everything you need before joining.</h2>
          <Faq items={ITEMS} />
        </div>
      </div>
    </section>
  );
}
