import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What CreatorNet collects, how it's used, who processes it, and the choices you have.",
};

const LAST_UPDATED = "August 30, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-gray-700 leading-relaxed">{children}</div>
    </section>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Privacy Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>

      <Section title="Who we are">
        <p>
          CreatorNet is a platform where creators share short videos and sell products,
          courses, and 1-on-1 calls. It is operated by [COMPANY LEGAL NAME], [MAILING
          ADDRESS]. For anything privacy-related, contact{" "}
          <a className="underline" href="mailto:privacy@creatornet.net">
            privacy@creatornet.net
          </a>
          .
        </p>
      </Section>

      <Section title="What we collect">
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Account data</strong> — your email address (from email sign-in, Google, or
            Apple), plus the profile you create: username, name, avatar, tagline, bio, and
            interests.
          </li>
          <li>
            <strong>Content you post</strong> — videos, captions, comments, likes, follows, and
            reviews.
          </li>
          <li>
            <strong>Purchase and booking records</strong> — what you bought or booked, from
            which creator, and its fulfillment status. Your card details never touch our
            servers: payment is completed on Stripe&apos;s hosted checkout pages.
          </li>
          <li>
            <strong>Usage data</strong> — pages viewed, videos watched, searches, and similar
            product-analytics events, tied to a random analytics identifier and your account id
            (not your email).
          </li>
          <li>
            <strong>Error data</strong> — if something breaks, our error-reporting tool records
            technical details about the failure. On errors it may also capture a replay of what
            was on your screen in the app so we can reproduce the bug.
          </li>
        </ul>
      </Section>

      <Section title="How we use it">
        <ul className="list-disc pl-6 space-y-2">
          <li>Provide and secure the service (accounts, sign-in, content delivery).</li>
          <li>Personalize your feed and recommendations.</li>
          <li>Process purchases, bookings, and creator payouts.</li>
          <li>Understand what&apos;s working and fix what isn&apos;t (analytics, error reports).</li>
        </ul>
        <p>We do not sell personal data.</p>
      </Section>

      <Section title="Who processes it for us">
        <p>These vendors process data on our behalf to run CreatorNet:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Supabase</strong> — authentication and our database.
          </li>
          <li>
            <strong>Stripe</strong> — payments and creator payouts (Stripe Connect). Card data
            is collected and stored by Stripe, not us.
          </li>
          <li>
            <strong>PostHog</strong> (US cloud) — product analytics. You can opt out via the
            cookie notice or your browser settings.
          </li>
          <li>
            <strong>Sentry</strong> — error reporting, including on-error screen replay as
            described above.
          </li>
          <li>
            <strong>Cloudflare</strong> — storage and delivery of uploaded media.
          </li>
          <li>
            <strong>Vercel</strong> — hosting.
          </li>
        </ul>
        <p>
          Some of these vendors process data in the United States. By using CreatorNet you
          understand your data may be processed there.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          Account and content data is kept while your account exists. Purchase records are kept
          as long as needed for accounting and dispute handling. Analytics and error data is
          kept on our vendors&apos; standard retention schedules.
        </p>
      </Section>

      <Section title="Your choices">
        <ul className="list-disc pl-6 space-y-2">
          <li>Update your profile at any time from the app.</li>
          <li>Opt out of analytics via the cookie notice (&quot;Decline analytics&quot;).</li>
          <li>
            Request access to, or deletion of, your data by emailing{" "}
            <a className="underline" href="mailto:privacy@creatornet.net">
              privacy@creatornet.net
            </a>
            .
          </li>
        </ul>
      </Section>

      <Section title="Children">
        <p>
          CreatorNet is not directed at children under 13, and we don&apos;t knowingly collect
          their data. Purchasing and selling require being 18 or older.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this policy changes, we&apos;ll update this page and the date above. Material
          changes will be flagged in the app.
        </p>
      </Section>
    </main>
  );
}
