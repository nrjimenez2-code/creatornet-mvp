import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms that govern using CreatorNet — accounts, content, purchases, creator payouts, and acceptable use.",
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

export default function TermsPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Terms of Service</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>
      {/* TODO(Noah): the governing-law state and venue for section 8 are still
          pending; add them there when the legal setup is finalized. */}
      <p className="mt-4 text-gray-700 leading-relaxed">
        These Terms govern your use of CreatorNet, operated by CreatorNet LLC
        (&quot;CreatorNet&quot;, &quot;we&quot;, &quot;us&quot;). By accessing or using the
        service you agree to them. If you don&apos;t agree, don&apos;t use CreatorNet.
      </p>

      <Section title="1. Your account">
        <p>
          You must be at least 13 to use CreatorNet, and at least 18 (or the age of majority
          where you live) to buy anything or to sell and receive payouts as a creator. You are
          responsible for your account&apos;s activity and for keeping your sign-in method
          secure.
        </p>
      </Section>

      <Section title="2. Your content">
        <p>
          You keep the rights to content you post. By posting, you grant CreatorNet a
          non-exclusive, worldwide, royalty-free license to host, store, display, and
          distribute that content within the service so we can operate it. You&apos;re
          responsible for having the rights to everything you post.
        </p>
        <p>
          To report content you believe infringes your copyright, email{" "}
          <a className="underline" href="mailto:support@creatornet.net">
            support@creatornet.net
          </a>{" "}
          with the content link and details of your claim. We remove infringing content and may
          suspend repeat infringers.
        </p>
      </Section>

      <Section title="3. Purchases">
        <p>
          Payments are processed by Stripe on Stripe-hosted checkout pages; we never see your
          card details. Prices are set by creators. When you buy a product, course, or 1-on-1
          call, the creator — not CreatorNet — is the seller responsible for delivering it.
        </p>
        <p>
          If something you paid for wasn&apos;t delivered, contact{" "}
          <a className="underline" href="mailto:support@creatornet.net">
            support@creatornet.net
          </a>{" "}
          and we&apos;ll help resolve it with the creator. Except where the law requires
          otherwise, refunds are handled case by case.
        </p>
      </Section>

      <Section title="4. Selling and payouts (creators)">
        <p>
          Creators sell through Stripe Connect and must accept Stripe&apos;s own terms,
          including its age and identity-verification requirements. CreatorNet charges a 12%
          platform fee. Standard payment-processing fees are deducted separately. The
          creator&apos;s net earnings are the sale amount minus those two separate deductions.
          Creators are responsible for
          delivering what they sell, for the accuracy of their listings, and for their own taxes.
        </p>
      </Section>

      <Section title="5. Acceptable use">
        <p>
          No illegal, infringing, hateful, exploitative, deceptive, or otherwise harmful
          content or activity. No attempts to break, probe, or overload the service or to
          access other people&apos;s accounts or data. We may remove content, restrict
          features, or suspend accounts that violate these Terms.
        </p>
      </Section>

      <Section title="6. The service is provided &quot;as is&quot;">
        <p>
          CreatorNet is provided without warranties of any kind, express or implied. We
          don&apos;t guarantee uninterrupted or error-free operation, or the quality of what
          creators sell.
        </p>
      </Section>

      <Section title="7. Limitation of liability">
        <p>
          To the maximum extent the law allows, CreatorNet&apos;s total liability for any claim
          arising out of the service is limited to the greater of $100 or the amount you paid
          us in the 12 months before the claim. We are not liable for indirect, incidental, or
          consequential damages.
        </p>
      </Section>

      <Section title="8. Disputes">
        <p>
          If something goes wrong, contact{" "}
          <a className="underline" href="mailto:support@creatornet.net">
            support@creatornet.net
          </a>{" "}
          first — most issues can be resolved informally. Where a governing-law and venue
          designation is required, it will be added to these Terms as CreatorNet&apos;s legal
          setup is finalized and flagged as a material change.
        </p>
      </Section>

      <Section title="9. Changes">
        <p>
          We may update these Terms; the date above always reflects the current version.
          Material changes will be flagged in the app. Continued use after changes means you
          accept the updated Terms.
        </p>
      </Section>

      <Section title="10. Contact">
        <p>
          <a className="underline" href="mailto:support@creatornet.net">
            support@creatornet.net
          </a>
        </p>
        <address className="not-italic">
          CreatorNet LLC
          <br />
          21095 North 64th Avenue
          <br />
          Glendale, AZ 85308
          <br />
          United States
        </address>
      </Section>
    </main>
  );
}
