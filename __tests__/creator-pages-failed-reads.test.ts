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
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockClient, type MockClient, type Responder } from "./__mocks__/supabaseQueryMock";

let db: MockClient;

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
