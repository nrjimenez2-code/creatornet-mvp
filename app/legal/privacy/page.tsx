import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What CreatorNet collects, how it's used, who processes it, and the choices you have.",
};

const LAST_UPDATED = "September 14, 2026";

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-8">
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
          courses, and 1-on-1 calls, operated by CREATORNET LLC NOAH RAY JIMENEZ SOLE MBR % NOAH RAY JIMENEZ SOLE MBR.
        </p>
        <p>
          Business address: 21095 North 64th Avenue, Glendale, AZ 85308, United States.
        </p>
        <p>
          For anything
          privacy-related, contact{" "}
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

      <Section id="connected-calendars" title="Connected calendars and scheduling accounts">
        <p>
          Connecting Google Calendar, Cal.com or Calendly is optional. We receive the
          connected account identity and the permissions you approve so you can offer
          and manage calls through CreatorNet.
        </p>
        <p>
          For Google Calendar, we access your account email, calendar list, selected
          calendars&apos; availability and events needed to check conflicts and synchronize
          bookings. You choose the booking calendar, conflict calendars and available hours.
          We create, reschedule and cancel CreatorNet booking events in your selected calendar.
          Google may send invitations and updates to the attendee&apos;s booking email.
          The granted permission includes events on calendars you own, including unrelated
          events. Synchronization can return other events in the booking calendar; we match
          events to CreatorNet booking records when reconciling changes.
        </p>
        <p>
          For Cal.com and Calendly, we access account identity, booking event types and
          scheduled-event information. We configure provider notifications to reflect
          scheduled, rescheduled and canceled calls. A scheduled call or saved payment
          method does not establish that a call took place.
        </p>
        <p>
          We store encrypted authorization tokens, scheduling settings, and identifiers
          and status information needed to maintain bookings. Our hosting and database
          providers process this information to operate scheduling. Booking participants
          receive the information needed to arrange and manage their call.
        </p>
        <p>
          CreatorNet links verified bookings and, where applicable, later purchases to
          the video that led to them. These milestones support creator reporting and feed
          recommendations. Calendar availability and unrelated event content are not
          feed-ranking signals.
        </p>
        <p>
          You can disconnect in Bookings and manage CreatorNet&apos;s access in your
          provider&apos;s account settings. A completed disconnect removes stored authorization
          tokens and stops the connection. Disconnecting does not cancel existing appointments
          or delete historical booking and purchase records. If disconnecting cannot finish,
          we display that status so you can retry. Retained records are subject to the
          retention terms and deletion choices below.
        </p>
        <p>
          CreatorNet&apos;s use and transfer of information received from Google APIs will
          adhere to the <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>,
          including its Limited Use requirements. Google data is used only for disclosed
          user-facing features. Transfers and human access are limited to the circumstances
          permitted by that policy. We do not sell this data or use it for advertising,
          credit decisions or lending.
        </p>
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
            <strong>PostHog</strong> (US cloud) — product analytics. You can opt out of
            analytics collected from your browser via the cookie notice or the control on
            our Cookies Policy page.
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
          <li>
            Opt out of analytics collected from your browser via the cookie notice
            (&quot;Decline analytics&quot;) or the control on our Cookies Policy page. A small
            number of events our servers record to run the service — like completed
            purchases — aren&apos;t affected by this browser setting.
          </li>
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
