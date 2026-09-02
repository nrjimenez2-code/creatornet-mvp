import Cover from "./Cover";
import TrustStrip from "./TrustStrip";
import Discover from "./Discover";
import CreatorTools from "./CreatorTools";
import Flow from "./Flow";
import FaqSection from "./FaqSection";
import FinalCta from "./FinalCta";

// components/landing/LandingPage.tsx — the public front door.
//
// Built from Noah's developer package (creatornet-landing-developer-package,
// 2026-09-01) as the visual source of truth. Rendered by app/page.tsx for a
// visitor with no session; signed-in users never see it. Styles live in
// app/landing.css, scoped under .cn-site. Only the FAQ is a client component.
export default function LandingPage() {
  return (
    <main className="cn-site">
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
