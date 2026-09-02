import Link from "next/link";

// Section 7: the two paths again, and the footer with the REAL policy routes
// (the four /legal pages from #118 plus Terms/Privacy). The footer brand is
// text, not the PNG — the mark carries a black background and this panel is
// light.
export default function FinalCta() {
  return (
    <section className="cn-site-final">
      <div className="cn-site-final-panel">
        <div className="cn-site-final-copy">
          <p className="cn-site-section-label">Your next move starts here</p>
          <h2>Find the creator who gets you there.</h2>
          <p>
            Explore practical knowledge, choose a clear offer, and learn from someone with real
            experience.
          </p>
          <div className="cn-site-final-actions">
            <Link className="cn-site-action-purple" href="/dashboard">
              Explore CreatorNet
            </Link>
            <Link className="cn-site-action-light-outline" href="/auth">
              Start selling
            </Link>
          </div>
        </div>

        <footer className="cn-site-footer">
          <div>
            <div className="cn-site-footer-brand">CreatorNet</div>
            <div>© 2026 CreatorNet</div>
          </div>
          <nav className="cn-site-footer-links" aria-label="Policies and support">
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/terms">Terms</Link>
            <Link href="/legal/refunds">Refund policy</Link>
            <Link href="/legal/delivery">Delivery &amp; cancellation</Link>
            <Link href="/legal/creators">Creator policy</Link>
            <Link href="/legal/support">Support</Link>
          </nav>
        </footer>
      </div>
    </section>
  );
}
