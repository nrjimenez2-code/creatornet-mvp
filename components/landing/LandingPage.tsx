import Cover from "./Cover";
import TrustStrip from "./TrustStrip";
import Discover from "./Discover";
import CreatorTools from "./CreatorTools";
import Flow from "./Flow";
import FaqSection from "./FaqSection";
import FinalCta from "./FinalCta";
import SignedInRedirect from "./SignedInRedirect";

// components/landing/LandingPage.tsx — the public front door.
//
// Built from Noah's developer package (creatornet-landing-developer-package,
// 2026-09-01) as the visual source of truth. Rendered by app/page.tsx for a
// visitor with no session cookie. Styles live in app/landing.css, scoped under
// .cn-site. Two client components: the FAQ, and SignedInRedirect — a visitor
// who is signed in on the client but not yet on the server (a sign-in that
// returned to "/" with the session in the URL fragment) is handed to /auth
// instead of being left on the logged-out page.
export default function LandingPage() {
  return (
    <main className="cn-site">
      <SignedInRedirect />
      <Cover />
      <TrustStrip />
      <Discover />
      <CreatorTools />
      <Flow />
      <FaqSection />
      <FinalCta />
    </main>
  );
}
