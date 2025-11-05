export default function Page() {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12 prose prose-zinc">
        <h1>Cookies Policy</h1>
        <p>Last updated: {new Date().toLocaleDateString()}</p>
        <h2>What Are Cookies?</h2>
        <p>
          Small text files stored on your device to keep you signed in and help
          us understand how the app is used.
        </p>
        <h2>How We Use Them</h2>
        <ul>
          <li>Authentication and session</li>
          <li>Preferences and performance</li>
          <li>Analytics (aggregate usage metrics)</li>
        </ul>
        <h2>Managing Cookies</h2>
        <p>
          You can control cookies via your browser settings. Blocking some
          cookies may affect functionality.
        </p>
        <h2>Contact</h2>
        <p>Email: privacy@creatornet.net</p>
      </main>
    );
  }
  