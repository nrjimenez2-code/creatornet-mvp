// Section 4: both sides of the creator experience — a storefront and an
// analytics view — as realistic interface states. Names and numbers are the
// mockup's illustrative examples, labelled as such.
export default function CreatorTools() {
  return (
    <section className="cn-site-tools" id="cn-site-creators">
      <div className="cn-site-width">
        <div className="cn-site-tools-grid">
          <article className="cn-site-tool">
            <div className="cn-site-profile-demo" role="img" aria-label="Preview of a creator storefront with three offers">
              <div className="cn-site-profile-top" aria-hidden="true">
                <div className="cn-site-profile-avatar">AM</div>
                <strong>Alex Morgan</strong>
                <span>@alexbuilds · Growth strategist</span>
                <div className="cn-site-profile-tags">
                  <span>Marketing</span>
                  <span>Offers</span>
                  <span>Personal brand</span>
                </div>
              </div>
              <div className="cn-site-profile-offers" aria-hidden="true">
                <div className="cn-site-profile-offer">
                  <div>
                    <strong>The Clear Offer Playbook</strong>
                    <span>Digital guide · instant access</span>
                  </div>
                  <em>$79 USD</em>
                </div>
                <div className="cn-site-profile-offer">
                  <div>
                    <strong>Offer Audit</strong>
                    <span>45-minute 1-on-1 call</span>
                  </div>
                  <em>$250 USD</em>
                </div>
                <div className="cn-site-profile-offer">
                  <div>
                    <strong>Growth Mentorship</strong>
                    <span>4 weeks · limited availability</span>
                  </div>
                  <em>$900 USD</em>
                </div>
              </div>
            </div>
            <div className="cn-site-tool-copy">
              <p className="cn-site-section-label">Creator storefront</p>
              <h3>One profile for everything you sell.</h3>
              <p>
                Give customers a clear place to understand your expertise, browse your offers, and
                choose the right way to work with you.
              </p>
            </div>
          </article>

          <article className="cn-site-tool">
            <div className="cn-site-analytics-demo" role="img" aria-label="Preview of creator analytics: views, clicks, purchases and sales over 30 days">
              <div className="cn-site-analytics-head" aria-hidden="true">
                <strong>Analytics</strong>
                <span>Last 30 days · example</span>
              </div>
              <div className="cn-site-metrics" aria-hidden="true">
                <div className="cn-site-metric">
                  <span>Views</span>
                  <strong>48.2K</strong>
                </div>
                <div className="cn-site-metric">
                  <span>Unique clicks</span>
                  <strong>3,941</strong>
                </div>
                <div className="cn-site-metric">
                  <span>Purchases</span>
                  <strong>186</strong>
                </div>
                <div className="cn-site-metric">
                  <span>Sales (USD)</span>
                  <strong>$18,420</strong>
                </div>
              </div>
              <div className="cn-site-chart" aria-hidden="true">
                <span className="cn-site-chart-label">Views · daily</span>
                <svg viewBox="0 0 300 130" preserveAspectRatio="none">
                  <g className="cn-site-chart-grid">
                    <path d="M0 32H300M0 64H300M0 96H300" />
                  </g>
                  <path
                    className="cn-site-chart-line"
                    d="M4 104 C 30 98, 48 84, 70 86 S 110 60, 134 58 S 170 74, 196 50 S 236 30, 262 34 S 288 20, 296 16"
                  />
                </svg>
              </div>
            </div>
            <div className="cn-site-tool-copy">
              <p className="cn-site-section-label">Creator analytics</p>
              <h3>See what turns attention into sales.</h3>
              <p>
                Track views, clicks, purchases, bookings, and sales without piecing together five
                different tools.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
