import Link from "next/link";
import { ArrowIcon } from "./icons";

// Section 1 of Noah's brief: logo, simple nav, Log in / Join, the
// "The creator marketplace" label, the headline, one supporting line, and the
// two paths. Every action goes to a real route:
//   Log in / Join / Start selling -> /auth   (single auth flow; creators sign in
//                                              then connect Stripe from the dashboard)
//   Explore CreatorNet            -> /dashboard (public; returns 200 signed out)
export default function Cover() {
  return (
    <section className="cn-site-cover-shell">
      <div className="cn-site-cover">
        <div className="cn-site-cover-width">
          <header className="cn-site-nav">
            <Link href="/" aria-label="CreatorNet home">
              {/* The exact production mark. Its black background disappears
                  into the cover — it must never be placed on a light surface. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="cn-site-logo" src="/creatornet-mark.png" alt="CreatorNet" width={235} height={76} />
            </Link>
            <nav className="cn-site-nav-links" aria-label="Page sections">
              <a href="#cn-site-discover">Discover</a>
              <a href="#cn-site-creators">For creators</a>
              <a href="#cn-site-flow">How it works</a>
              <a href="#cn-site-faq">FAQ</a>
            </nav>
            <div className="cn-site-nav-actions">
              <Link className="cn-site-login" href="/auth">
                Log in
              </Link>
              <Link className="cn-site-join" href="/auth">
                Join CreatorNet
              </Link>
            </div>
          </header>

          <div className="cn-site-hero">
            <div className="cn-site-hero-copy">
              <p className="cn-site-marketplace">The creator marketplace</p>
              <h1>Learn from people who do it.</h1>
              <p className="cn-site-hero-description">
                CreatorNet brings courses, mentorship, 1-on-1 calls, and digital products from
                experienced creators into one marketplace.
              </p>
              <div className="cn-site-hero-actions">
                <Link className="cn-site-action-white" href="/dashboard">
                  Explore CreatorNet
                  <ArrowIcon />
                </Link>
                <Link className="cn-site-action-outline" href="/auth">
                  Start selling
                </Link>
              </div>
            </div>
          </div>
        </div>
        <p className="cn-site-hero-note">Clear offers. Direct access.</p>
      </div>
    </section>
  );
}
