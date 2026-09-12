/**
 * app/creators/[creatorId]/page.tsx and .../reviews/page.tsx — a failed read
 * must not render as a legitimate empty state.
 *
 * Both are async server components. Each test calls the REAL page function
 * with a stub data layer and renders the element it returns with
 * react-dom/server, then asserts on the markup:
 *  - profile page: posts query error → "Couldn't load this creator's posts",
 *    never "hasn't posted yet"; genuinely no posts → the empty line plus a
 *    Browse the feed link
 *  - reviews page: rating/reviews query error → "Couldn't load reviews" and
 *    a "—" rating, never "0.0 · No written reviews yet"; genuinely none →
 *    the existing empty line
 *  - reviews page: a /creators/<username>/reviews URL resolves via the
 *    username fallback and must NOT render the "Unable to load reviews right
 *    now" card just because the uuid lookup rejected the username (22P02)
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";

import { createElement, type ReactElement } from "react";
import type { OfferCard } from "@/lib/offers";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockClient, type MockClient, type Responder } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
let profileOffers: OfferCard[] = [];
jest.mock("@/components/OffersPanel", () => ({
  __esModule: true,
  default: ({ offers }: { offers: OfferCard[] }) => { profileOffers = offers; return null; },
}));

jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from: (table: string) => db.from(table),
  }),
}));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: { href: string; children?: unknown; className?: string }) =>
    createElement("a", { href, className }, children as never),
}));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ProfileShareButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/FollowButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ProfilePostsGallery", () => ({
  __esModule: true,
  default: () => createElement("div", { "data-testid": "gallery" }),
}));
jest.mock("@/components/ReviewForm", () => ({ __esModule: true, default: () => null }));

import CreatorPublicProfilePage from "@/app/creators/[creatorId]/page";
import CreatorReviewsPage from "@/app/creators/[creatorId]/reviews/page";

const PROFILE = {
  id: "creator_1",
  username: "coach",
  full_name: "Coach Kim",
  tagline: null,
  avatar_url: null,
  bio: null,
};

const params = Promise.resolve({ creatorId: "creator_1" });

async function renderPage(page: (p: { params: typeof params }) => Promise<unknown>) {
  const element = (await page({ params })) as ReactElement;
  return renderToStaticMarkup(element);
}

const profileResponder: Responder = (op) =>
  op.table === "profiles" && op.filters.id === "creator_1" ? { data: PROFILE, error: null } : undefined;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
});

describe("profile offer schema readiness", () => {
  test.each([[false, false], [false, true], [true, false], [true, true]])(
    "monthly schema %s, fixed service schema %s", async (monthly, fixed) => {
      const monthlyBefore = process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY;
      const fixedBefore = process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
      process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY = String(monthly);
      process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = String(fixed);
      profileOffers = [];
      const terms = { version: "monthly-mentorship-v1", minimumMonths: 3, autoRenew: true };
      try {
        db = createMockClient(op => {
          if (op.table === "posts") return { data: [{ id: "visible", creator_id: "creator_1", product_id: "row" }], error: null };
          if (op.table === "products") return { data: [{ id: "row", title: "Mentorship", type: "mentorship", amount_cents: 10000,
            ...(op.columns?.includes("membership_terms") ? { membership_terms: terms } : {}) }], error: null };
          return profileResponder(op);
        });
        await renderPage(CreatorPublicProfilePage);
        const query = db.opsFor("products")[0];
        expect(query.columns?.includes("membership_terms")).toBe(monthly);
        expect(query.columns?.includes("fixed_service_months")).toBe(fixed);
        expect(query.filters.creator_id).toBe("creator_1");
        expect(profileOffers[0]).toMatchObject({ productId: "row", postId: "visible" });
        expect(profileOffers[0].monthlyTerms).toEqual(monthly ? terms : undefined);
      } finally {
        if (monthlyBefore === undefined) delete process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY;
        else process.env.CREATOR_MONTHLY_MENTORSHIPS_SCHEMA_READY = monthlyBefore;
        if (fixedBefore === undefined) delete process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY;
        else process.env.CREATOR_FIXED_SERVICE_SCHEMA_READY = fixedBefore;
      }
    },
  );
});

describe("creator profile page: posts read", () => {
  test("posts query error renders an error line, not 'hasn't posted yet'", async () => {
    db = createMockClient((op) => {
      if (op.table === "posts") return { data: null, error: { message: "timeout" } };
      return profileResponder(op);
    });

    const html = await renderPage(CreatorPublicProfilePage);

    expect(html).toContain("Couldn&#x27;t load this creator&#x27;s posts");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("hasn&#x27;t posted yet");
    expect(html).not.toContain('data-testid="gallery"');
  });

  test("genuinely no posts renders the empty line with a Browse the feed link", async () => {
    db = createMockClient((op) => {
      if (op.table === "posts") return { data: [], error: null };
      return profileResponder(op);
    });

    const html = await renderPage(CreatorPublicProfilePage);

    expect(html).toContain("This creator hasn&#x27;t posted yet.");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Browse the feed");
    expect(html).not.toContain("Couldn&#x27;t load");
  });

  test("with posts the gallery renders (no empty or error state)", async () => {
    db = createMockClient((op) => {
      if (op.table === "posts") return { data: [{ id: "p1", creator_id: "creator_1" }], error: null };
      return profileResponder(op);
    });

    const html = await renderPage(CreatorPublicProfilePage);

    expect(html).toContain('data-testid="gallery"');
    expect(html).not.toContain("hasn&#x27;t posted yet");
    expect(html).not.toContain("Couldn&#x27;t load");
  });
});

describe("creator reviews page: rating/reviews read", () => {
  test("reviews query error renders an error box and a — rating, not 0.0 / no reviews yet", async () => {
    db = createMockClient((op) => {
      if (op.table === "reviews") return { data: null, error: { message: "timeout" } };
      if (op.kind === "rpc") return { data: null, error: { message: "timeout" } };
      return profileResponder(op);
    });

    const html = await renderPage(CreatorReviewsPage);

    expect(html).toContain("Couldn&#x27;t load reviews");
    expect(html).toContain("Rating unavailable right now");
    expect(html).toContain("—");
    expect(html).not.toContain("No written reviews yet");
    expect(html).not.toContain(">0.0<");
    expect(html).not.toContain("Based on 0 reviews");
  });

  test("genuinely no reviews keeps the existing empty line and a 0.0 rating", async () => {
    db = createMockClient((op) => {
      if (op.table === "reviews") return { data: [], error: null };
      if (op.kind === "rpc") return { data: [{ avg_rating: 0, review_count: 0 }], error: null };
      return profileResponder(op);
    });

    const html = await renderPage(CreatorReviewsPage);

    expect(html).toContain("No written reviews yet.");
    expect(html).toContain(">0.0<");
    expect(html).toContain("Based on 0 reviews");
    expect(html).not.toContain("Couldn&#x27;t load reviews");
  });
});

describe("creator reviews page: /creators/<username>/reviews", () => {
  // The page explicitly supports a username in the URL (it falls back to a
  // username lookup when the id lookup finds nothing). Postgres rejects
  // comparing a uuid column to "coach" with SQLSTATE 22P02, and that error
  // used to survive the successful fallback, so a real creator's public
  // reviews page rendered the error card. Verified live on 2026-09-07:
  // /creators/luis/reviews showed the card while /creators/<uuid>/reviews
  // rendered correctly.
  // Mutation check: delete `profileError = null` from the fallback branch in
  // app/creators/[creatorId]/reviews/page.tsx and this test fails.
  const usernameParams = Promise.resolve({ creatorId: "coach" });

  const uuidRejectsUsername: Responder = (op) => {
    if (op.table !== "profiles") return undefined;
    if (op.filters.id === "coach") {
      return {
        data: null,
        error: { code: "22P02", message: 'invalid input syntax for type uuid: "coach"' },
      };
    }
    if (op.filters.username === "coach") return { data: PROFILE, error: null };
    return undefined;
  };

  test("resolves the creator by username instead of rendering the error card", async () => {
    db = createMockClient((op) => {
      if (op.table === "reviews") return { data: [], error: null };
      if (op.kind === "rpc") return { data: [{ avg_rating: 0, review_count: 0 }], error: null };
      return uuidRejectsUsername(op);
    });

    const element = (await CreatorReviewsPage({ params: usernameParams })) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(html).not.toContain("Unable to load reviews right now");
    expect(html).toContain("No written reviews yet.");
  });

  test("still shows the error card when the username fallback also fails", async () => {
    db = createMockClient((op) => {
      if (op.table === "reviews") return { data: [], error: null };
      if (op.kind === "rpc") return { data: [{ avg_rating: 0, review_count: 0 }], error: null };
      if (op.table === "profiles") {
        return {
          data: null,
          error: { code: "22P02", message: 'invalid input syntax for type uuid: "coach"' },
        };
      }
      return undefined;
    });

    const element = (await CreatorReviewsPage({ params: usernameParams })) as ReactElement;
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Unable to load reviews right now");
  });
});
