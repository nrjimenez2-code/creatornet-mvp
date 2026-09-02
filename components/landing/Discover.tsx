import {
  ChartIcon,
  CommentIcon,
  CompassIcon,
  HeartIcon,
  LibraryIcon,
  SearchIcon,
  ShareIcon,
  UserIcon,
  UsersIcon,
} from "./icons";

// Section 3: a realistic discovery feed in the product's black-and-violet
// language. The creator, post and offer here are ILLUSTRATIVE — the mockup's
// own examples, which Noah approved. They are labelled as a preview.
export default function Discover() {
  return (
    <section className="cn-site-showcase" id="cn-site-discover">
      <div className="cn-site-width">
        <p className="cn-site-section-label">Discovery</p>
        <h2 className="cn-site-section-title">Find expertise through content—not cold listings.</h2>
        <p className="cn-site-section-intro">
          CreatorNet starts with the way people already discover new ideas: short, useful content
          from creators worth following.
        </p>

        <div className="cn-site-feed-stage" role="img" aria-label="Preview of the CreatorNet feed: a short video with the creator's offer attached">
          <div className="cn-site-app-shell" aria-hidden="true">
            <aside className="cn-site-app-sidebar">
              <div className="cn-site-app-brand">
                <span className="cn-site-app-brand-mark">CN</span>
                CreatorNet
              </div>
              <div className="cn-site-app-search">
                <SearchIcon />
                Search
              </div>
              <div className="cn-site-app-item is-active">
                <CompassIcon />
                Discover
              </div>
              <div className="cn-site-app-item">
                <UsersIcon />
                Following
              </div>
              <div className="cn-site-app-item">
                <UserIcon />
                Profile
              </div>
              <div className="cn-site-app-item">
                <ChartIcon />
                Analytics
              </div>
              <div className="cn-site-app-item">
                <LibraryIcon />
                Library
              </div>
            </aside>
            <div className="cn-site-app-main">
              <div className="cn-site-feed-post">
                <p className="cn-site-feed-message">
                  Three changes that took my store past its first $10k month.
                </p>
                <div className="cn-site-feed-art" />
                <span className="cn-site-feed-offer">Buy · $89.00 USD</span>
                <div className="cn-site-feed-meta">
                  <strong>maya.chen</strong>
                  <span>Your First $10k Store · #Ecommerce</span>
                </div>
                <div className="cn-site-feed-actions">
                  <span className="cn-site-feed-action">
                    <HeartIcon />
                  </span>
                  <span className="cn-site-feed-action">
                    <CommentIcon />
                  </span>
                  <span className="cn-site-feed-action">
                    <ShareIcon />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="cn-site-feature-caption">
          <h3>Content leads naturally to the offer.</h3>
          <p>
            Customers can understand a creator&apos;s perspective before buying. When an offer is
            relevant, the price and next action are attached directly to the post.
          </p>
        </div>
      </div>
    </section>
  );
}
