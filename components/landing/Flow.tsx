import { InfoIcon } from "./icons";

// Section 5: describe both listed purchases and voluntary free-video tips.
export default function Flow() {
  return (
    <section className="cn-site-marketplace-flow" id="cn-site-flow">
      <div className="cn-site-flow-panel">
        <div className="cn-site-width cn-site-flow-inner">
          <p className="cn-site-section-label">How the marketplace works</p>
          <h2 className="cn-site-section-title">Clear on both sides of every purchase.</h2>

          <div className="cn-site-flow-columns">
            <div className="cn-site-flow-card">
              <h3>For customers</h3>
              <ol className="cn-site-flow-list">
                <li className="cn-site-flow-step">
                  <span className="cn-site-flow-number">1</span>
                  <span>Discover a creator through useful content.</span>
                </li>
                <li className="cn-site-flow-step">
                  <span className="cn-site-flow-number">2</span>
                  <span>Review the exact price in USD, the format, and the deliverables.</span>
                </li>
                <li className="cn-site-flow-step">
                  <span className="cn-site-flow-number">3</span>
                  <span>Purchase the listed offer and receive access or booking instructions.</span>
                </li>
              </ol>
            </div>
            <div className="cn-site-flow-card">
              <h3>For creators</h3>
              <ol className="cn-site-flow-list">
                <li className="cn-site-flow-step">
                  <span className="cn-site-flow-number">1</span>
                  <span>Create a profile and publish a defined product or service.</span>
                </li>
                <li className="cn-site-flow-step">
                  <span className="cn-site-flow-number">2</span>
                  <span>Connect Stripe to accept payments and receive payouts.</span>
                </li>
                <li className="cn-site-flow-step">
                  <span className="cn-site-flow-number">3</span>
                  <span>Use content and analytics to grow the offers customers value.</span>
                </li>
              </ol>
            </div>
          </div>

          <p className="cn-site-flow-note">
            <InfoIcon />
            <span>
              CreatorNet charges a 12% platform fee. Any creator-funded payment-processing
              deduction is disclosed separately. The creator&apos;s net earnings are routed to
              their connected Stripe account. Purchases are for listed products or services.
              Eligible free videos may accept voluntary tips; tips do not unlock content.
              CreatorNet is a marketplace, not a way to send money between people.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
