/**
 * @jest-environment jsdom
 */
/**
 * Purple "Verified creator" badge on the MAIN FEED overlay — phase 2 of
 * Noah #3 (phase 1 = PR #130: lib/sellReady.ts + VerifiedCreatorBadge).
 *
 * 1. Renders the REAL components/VideoCard.tsx (createRoot + act, no JSX —
 *    same mocks as policy-links-purchase-flow.test.ts) and asserts the badge
 *    is the element right AFTER the creator's name in BOTH name branches
 *    (Link when a profile href exists, plain span when it does not), and
 *    only when `creatorVerified` is true. It is a sibling, not a child, of
 *    the name: the name element `truncate`s (overflow hidden), so a badge
 *    inside it is clipped away for long names — measured in a browser
 *    fixture during review: badge right edge 439px vs link right edge 370px.
 * 2. Source tripwires, because FeedList's realtime/virtualised render is too
 *    heavy to mount here and the SQL cannot run in jest:
 *    - FeedList passes `creatorVerified={p.creator_verified` to VideoCard.
 *    - supabase/schema/023-feed-v3-verified-seller-STAGED.sql declares
 *      `creator_verified boolean` in RETURNS TABLE and selects the ONE
 *      sell-ready expression in both branches (following + discover).
 *
 * Mutation-checked: deleting the <VerifiedCreatorBadge> line makes the two
 * placement tests fail; loosening the mapper makes the mapping test fail.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { createMockClient } from "./__mocks__/supabaseQueryMock";

const REPO_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Module mocks — registered before the component import (jest hoists these).
// ---------------------------------------------------------------------------

const mockClient = createMockClient();
jest.mock("@/lib/supabaseClient", () => ({
  createClient: () => mockClient,
  supabase: mockClient,
}));

const userCtx: { session: null; loading: boolean; userId: string | null } = {
  session: null,
  loading: false,
  userId: null,
};
jest.mock("@/lib/useUser", () => ({
  useUser: () => userCtx,
}));

jest.mock("@/lib/posthog", () => ({
  trackEvent: jest.fn(),
  normalizeCategory: (raw: string | null | undefined) => raw ?? null,
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

jest.mock("@/components/CommentPanel", () => ({
  __esModule: true,
  default: () => null,
}));

import VideoCard from "@/components/VideoCard";
import { VERIFIED_CREATOR_LABEL } from "@/components/VerifiedCreatorBadge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver; VideoCard constructs one for autoplay.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = NoopObserver;

type VideoCardProps = Parameters<typeof VideoCard>[0];

const BADGE = `[role="img"][aria-label="${VERIFIED_CREATOR_LABEL}"]`;
const CREATOR = "Jane Doe";

describe("VideoCard shows the Verified creator badge on the feed overlay", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(props: Partial<VideoCardProps>) {
    await act(async () => {
      root.render(
        createElement(VideoCard, {
          poster: "https://cdn.example.com/p.jpg",
          creator: CREATOR,
          caption: "A tip",
          hashtags: "#fitness",
          postId: "post_1",
          ...props,
        })
      );
    });
  }

  /** The element whose text is exactly the creator's display name. */
  function nameNode(): HTMLElement {
    const all = Array.from(container.querySelectorAll<HTMLElement>("a, span"));
    const node = all.find((el) => el.childNodes[0]?.textContent === CREATOR);
    if (!node) throw new Error("creator name not rendered");
    return node;
  }

  test("Link branch: badge is the element right after the profile link, not inside it", async () => {
    await render({ creatorUsername: "jane", creatorVerified: true });

    const link = nameNode();
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/profile/jane");
    // The link's accessible name stays just the creator's name.
    expect(link.textContent).toBe(CREATOR);
    expect(link.querySelector(BADGE)).toBeNull();

    const badge = link.nextElementSibling as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.matches(BADGE)).toBe(true);
    // Small size on the overlay.
    expect(badge!.style.width).toBe("14px");
    // Exactly one badge on the card.
    expect(container.querySelectorAll(BADGE)).toHaveLength(1);
  });

  test("span branch (no profile href): badge is the element right after the span", async () => {
    await render({ creatorUsername: null, creatorId: null, creatorVerified: true });

    const span = nameNode();
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toBe(CREATOR);
    expect(span.querySelector(BADGE)).toBeNull();

    const badge = span.nextElementSibling as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.matches(BADGE)).toBe(true);
    expect(container.querySelectorAll(BADGE)).toHaveLength(1);
  });

  test("no badge when creatorVerified is false", async () => {
    await render({ creatorUsername: "jane", creatorVerified: false });
    expect(nameNode().textContent).toBe(CREATOR);
    expect(container.querySelector(BADGE)).toBeNull();
  });

  test("no badge when creatorVerified is omitted (pre-migration default)", async () => {
    await render({ creatorUsername: "jane" });
    expect(container.querySelector(BADGE)).toBeNull();
  });

  test("the badge icon is decorative; the label carries the meaning", async () => {
    await render({ creatorUsername: "jane", creatorVerified: true });
    const badge = container.querySelector<HTMLElement>(BADGE)!;
    expect(badge.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(badge.getAttribute("title")).toMatch(/Stripe/);
  });
});

describe("tripwire: FeedList forwards creator_verified to VideoCard", () => {
  const source = readFileSync(join(REPO_ROOT, "components/FeedList.tsx"), "utf8");

  test("passes creatorVerified from the mapped row, hidden when the name is hidden", () => {
    expect(source).toMatch(
      /creatorVerified=\{p\.creator_verified === true && p\.creator_name != null\}/
    );
  });
});

describe("tripwire: migration 023 returns creator_verified from both feed branches", () => {
  const sql = readFileSync(
    join(REPO_ROOT, "supabase/schema/023-feed-v3-verified-seller-STAGED.sql"),
    "utf8"
  );
  const SELL_READY_SQL =
    "(prof.stripe_account_id is not null and coalesce(prof.stripe_onboarding_complete, false))";

  test("is marked STAGED and ordered after 025", () => {
    expect(sql).toMatch(/STAGED — NOT APPLIED/);
    expect(sql).toMatch(/025-feed-v3-purchase-count-STAGED\.sql[^\n]*FIRST/);
  });

  test("declares creator_verified boolean as the LAST column of RETURNS TABLE", () => {
    const returns = sql.match(/returns table \(([\s\S]*?)\)\s*language plpgsql/);
    expect(returns).not.toBeNull();
    const columns = returns![1]
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    expect(columns[columns.length - 1]).toBe("creator_verified boolean");
    // 025's purchase_count must survive (023 is 025 + one column).
    expect(columns).toContain("purchase_count integer");
    expect(columns).toHaveLength(24);
  });

  test("selects the one sell-ready expression in the following AND discover branches", () => {
    const occurrences = sql.split(SELL_READY_SQL).length - 1;
    expect(occurrences).toBe(2);
    // Following branch: bare expression right after purchase_count.
    expect(sql).toMatch(
      /coalesce\(p\.purchase_count, 0\),\s*\(prof\.stripe_account_id is not null and coalesce\(prof\.stripe_onboarding_complete, false\)\)\s*from posts p/
    );
    // Discover branch: aliased inside the subquery and re-selected outside.
    expect(sql).toMatch(/\) as r_creator_verified\s*from posts p/);
    expect(sql).toMatch(/x\.r_purchase_count,\s*x\.r_creator_verified\s*from \(/);
  });

  test("never returns the raw stripe_account_id as a column", () => {
    // Inside the function body the id may only appear in the `is not null` test.
    const body = sql.slice(sql.indexOf("\nbegin;"), sql.indexOf("\ncommit;"));
    expect(body.match(/stripe_account_id(?! is not null)/g)).toBeNull();
  });

  test("has CHECK and ROLLBACK sections", () => {
    expect(sql).toMatch(/CHECK BLOCK/);
    expect(sql).toMatch(/ROLLBACK/);
  });
});
