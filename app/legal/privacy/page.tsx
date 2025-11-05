export default function Page() {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12 prose prose-zinc">
        <h1>Privacy Policy</h1>
        <p>Last updated: {new Date().toLocaleDateString()}</p>
        <h2>What We Collect</h2>
        <ul>
          <li>Account data (email/phone, name, profile)</li>
          <li>Auth & device information</li>
          <li>Usage analytics (pages viewed, actions taken)</li>
          <li>Payment info handled by our processor</li>
        </ul>
        <h2>How We Use Data</h2>
        <ul>
          <li>Provide and secure the service</li>
          <li>Personalize feed and recommendations</li>
          <li>Process purchases and payouts</li>
          <li>Improve performance and user experience</li>
        </ul>
        <h2>Sharing</h2>
        <p>
          We share data with trusted vendors (e.g., cloud hosting, analytics,
          payments) as needed to run CreatorNet. We don’t sell personal data.
        </p>
        <h2>Your Choices</h2>
        <p>
          You can update or delete your account information, and you can contact
          us to request data access or deletion.
        </p>
        <h2>Contact</h2>
        <p>Email: privacy@creatornet.net</p>
      </main>
    );
  }
  