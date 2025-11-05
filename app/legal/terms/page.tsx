export default function Page() {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12 prose prose-zinc">
        <h1>Terms of Service</h1>
        <p>Last updated: {new Date().toLocaleDateString()}</p>
        <p>
          These Terms govern your use of CreatorNet. By accessing or using the
          service you agree to these Terms.
        </p>
        <h2>Your Account</h2>
        <p>
          You are responsible for your account activity and for keeping your
          login secure. You must be 13+ to use CreatorNet.
        </p>
        <h2>Content & Licensing</h2>
        <p>
          You retain rights to content you post. By posting, you grant
          CreatorNet a license to host, display, and distribute your content
          within the service.
        </p>
        <h2>Payments</h2>
        <p>
          Purchases and payouts are processed via our payment partner. Fees may
          apply as disclosed during checkout or in your dashboard.
        </p>
        <h2>Acceptable Use</h2>
        <p>
          No illegal, infringing, hateful, or otherwise harmful content or
          activity. We may remove content or suspend accounts violating these
          Terms.
        </p>
        <h2>Changes</h2>
        <p>
          We may update these Terms. Continued use after changes means you
          accept the updated Terms.
        </p>
        <h2>Contact</h2>
        <p>Email: support@creatornet.net</p>
      </main>
    );
  }
  