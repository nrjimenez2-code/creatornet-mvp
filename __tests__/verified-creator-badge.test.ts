/**
 * @jest-environment jsdom
 */
/**
 * Purple "Verified creator" check — phase 1 (no DB change).
 *
 * 1. lib/sellReady.ts#isSellReadyProfile is the pure form of the ONE
 *    "cleared to sell" predicate; a table over every column combination pins
 *    its truth table, and a parity test drives BOTH it and the real
 *    lib/creatorStripeConnect.ts#isCreatorSellReady over the same rows so the
 *    two can never drift apart.
 * 2. components/VerifiedCreatorBadge.tsx renders nothing when not verified,
 *    and an accessible purple check when verified.
 * 3. Tripwire: the badge stays a plain server-safe presentational component —
 *    no "use client", no supabase.
 * 4. GET /api/profiles is covered in verified-creator-badge-api.test.ts (node
 *    env — next/server needs the Request global jsdom hides).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_fake";

import { readFileSync } from "fs";
import { join } from "path";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { createMockClient, type MockClient, type Op } from "./__mocks__/supabaseQueryMock";
import { SELL_READY_COLUMNS, isSellReadyProfile } from "@/lib/sellReady";
import { isCreatorSellReady } from "@/lib/creatorStripeConnect";
import VerifiedCreatorBadge, { VERIFIED_CREATOR_LABEL } from "@/components/VerifiedCreatorBadge";

const REPO_ROOT = join(__dirname, "..");

let db: MockClient;
let authUser: { id: string } | null = { id: "viewer_1" };

jest.mock("@/lib/supabaseAdmin", () => ({
  get supabaseAdmin() {
    return db;
  },
}));
jest.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
jest.mock("@/lib/supabaseServer", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
  createSupabaseServer: async () => ({ auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } }),
}));

type Row = { stripe_account_id: string | null; stripe_onboarding_complete: boolean | null };

/** Every combination the two columns can take, with the expected verdict. */
const PREDICATE_TABLE: Array<[label: string, row: Row | null, expected: boolean]> = [
  ["account + onboarding complete", { stripe_account_id: "acct_1", stripe_onboarding_complete: true }, true],
  ["account, onboarding NOT complete", { stripe_account_id: "acct_1", stripe_onboarding_complete: false }, false],
  ["no account, onboarding flag true (stale)", { stripe_account_id: null, stripe_onboarding_complete: true }, false],
  ["no account, not complete", { stripe_account_id: null, stripe_onboarding_complete: false }, false],
  ["account, onboarding null", { stripe_account_id: "acct_1", stripe_onboarding_complete: null }, false],
  ["empty-string account id", { stripe_account_id: "", stripe_onboarding_complete: true }, false],
  ["no profile row", null, false],
];

beforeEach(() => {
  jest.clearAllMocks();
  authUser = { id: "viewer_1" };
  db = createMockClient(() => undefined);
});

describe("isSellReadyProfile (pure predicate)", () => {
  it.each(PREDICATE_TABLE)("%s", (_label, row, expected) => {
    expect(isSellReadyProfile(row)).toBe(expected);
  });

  it("treats undefined like a missing row", () => {
    expect(isSellReadyProfile(undefined)).toBe(false);
  });

  it("names exactly the two columns the server predicate reads", () => {
    const cols = SELL_READY_COLUMNS.split(",").map((c) => c.trim()).sort();
    expect(cols).toEqual(["stripe_account_id", "stripe_onboarding_complete"]);
  });
});

describe("parity with lib/creatorStripeConnect#isCreatorSellReady", () => {
  it.each(PREDICATE_TABLE)("%s (parity)", async (_label, row, expected) => {
    db = createMockClient((op: Op) =>
      op.table === "profiles" && op.kind === "select" ? { data: row, error: null } : undefined
    );

    const serverVerdict = await isCreatorSellReady("creator_1");

    expect(serverVerdict).toBe(expected);
    expect(isSellReadyProfile(row)).toBe(serverVerdict);
  });

  it("the server predicate reads the same columns SELL_READY_COLUMNS names", async () => {
    await isCreatorSellReady("creator_1");
    const [op] = db.opsFor("profiles");
    const asked = (op.columns ?? "").split(",").map((c) => c.trim()).sort();
    const ours = SELL_READY_COLUMNS.split(",").map((c) => c.trim()).sort();
    expect(asked).toEqual(ours);
  });
});

describe("VerifiedCreatorBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders nothing when not verified", async () => {
    await act(async () => {
      root.render(createElement(VerifiedCreatorBadge, { verified: false }));
    });
    expect(container.innerHTML).toBe("");
    expect(container.querySelector('[aria-label]')).toBeNull();
  });

  it("renders an accessible purple check when verified", async () => {
    await act(async () => {
      root.render(createElement(VerifiedCreatorBadge, { verified: true }));
    });
    const badge = container.querySelector('[role="img"]') as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("aria-label")).toBe(VERIFIED_CREATOR_LABEL);
    expect(badge!.getAttribute("title")).toMatch(/Stripe/);
    expect(badge!.style.backgroundColor).toBe("rgb(74, 53, 199)"); // #4A35C7
    expect(badge!.style.width).toBe("18px");
    expect(badge!.querySelector("svg")).not.toBeNull();
  });

  it("supports the small size", async () => {
    await act(async () => {
      root.render(createElement(VerifiedCreatorBadge, { verified: true, size: "sm" }));
    });
    const badge = container.querySelector('[role="img"]') as HTMLElement;
    expect(badge.style.width).toBe("14px");
  });
});

describe("tripwire: badge stays server-safe and auth-free", () => {
  const source = readFileSync(join(REPO_ROOT, "components/VerifiedCreatorBadge.tsx"), "utf8");

  it("has no 'use client' directive", () => {
    expect(source).not.toMatch(/["']use client["']/);
  });

  it("never mentions supabase", () => {
    expect(source.toLowerCase()).not.toContain("supabase");
  });
});
