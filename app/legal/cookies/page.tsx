import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cookies Policy",
  description: "The cookies and browser storage CreatorNet actually uses, and how to opt out.",
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

export default function CookiesPolicyPage() {
  return (
    <main>
      <h1 className="text-3xl font-bold">Cookies Policy</h1>
      <p className="mt-2 text-sm text-gray-500">Last updated: {LAST_UPDATED}</p>

      <Section title="What we actually set">
        <ul className="list-disc pl-6 space-y-2">
          <li>
            <strong>Sign-in cookies (strictly necessary).</strong> Supabase, our
            authentication provider, sets <code>sb-*</code> cookies so you stay signed in. A
            copy of your session is also kept in your browser&apos;s local storage. Without
            these, sign-in doesn&apos;t work.
          </li>
          <li>
            <strong>Analytics (optional).</strong> PostHog sets a <code>ph_*_posthog</code>{" "}
            cookie and local-storage entry with a random identifier so we can understand how
            the app is used. You can decline this — see below.
          </li>
          <li>
            <strong>Preferences.</strong> We use local storage for small things like your
            cookie choice and recent searches. These stay on your device.
          </li>
          <li>
            <strong>Stripe.</strong> Checkout happens on Stripe&apos;s own pages
            (stripe.com), where Stripe sets its own cookies under its own policy. We
            don&apos;t set Stripe cookies on creatornet.net.
          </li>
        </ul>
      </Section>

      <Section title="Opting out of analytics">
        <p>
          Choose &quot;Decline analytics&quot; in the cookie notice, and PostHog stops
          collecting from your browser. Your choice is remembered on this device. Blocking all
          cookies in your browser also works, but will sign you out.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about cookies:{" "}
          <a className="underline" href="mailto:privacy@creatornet.net">
            privacy@creatornet.net
          </a>
          .
        </p>
      </Section>
    </main>
  );
}
