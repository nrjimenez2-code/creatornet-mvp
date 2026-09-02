import { InfoIcon } from "./icons";

// Section 5: the transaction model, stated exactly. The fee (12%), Stripe
// payouts, and "every payment corresponds to a listing" are product facts
// Noah's brief requires verbatim; they match lib/money.ts and the Terms.
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
              CreatorNet keeps a 12% platform fee. The remainder is paid to the creator&apos;s
              connected Stripe account, subject to Stripe&apos;s processing. Every payment
              corresponds to a listed product or service — CreatorNet is a marketplace, not a way
              to send money between people.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
