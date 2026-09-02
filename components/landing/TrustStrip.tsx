import { ChatIcon, ShieldIcon, TagIcon } from "./icons";

// Section 2: the three assurances, nothing else.
export default function TrustStrip() {
  return (
    <section className="cn-site-trust" aria-label="What every purchase includes">
      <div className="cn-site-width cn-site-trust-inner">
        <span className="cn-site-trust-label">Built for trustworthy transactions</span>
        <span className="cn-site-trust-item">
          <TagIcon />
          Defined offers
        </span>
        <span className="cn-site-trust-item">
          <ShieldIcon />
          Secure checkout
        </span>
        <span className="cn-site-trust-item">
          <ChatIcon />
          Creator support
        </span>
      </div>
    </section>
  );
}
