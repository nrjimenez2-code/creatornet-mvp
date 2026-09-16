process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fake.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon_fake";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockClient, type MockClient } from "./__mocks__/supabaseQueryMock";

let db: MockClient;
const getUser = jest.fn();
jest.mock("@/lib/supabaseAdmin", () => ({ get supabaseAdmin() { return db; } }));
jest.mock("@/lib/supabaseServer", () => ({ createServerClient: () => ({
  auth: { getUser: () => getUser() }, from: (table: string) => db.from(table),
}) }));
jest.mock("@/lib/posthogServer", () => ({ trackServerEvent: jest.fn() }));
jest.mock("@/lib/updateInterestScore", () => ({ updateInterestScore: jest.fn() }));
jest.mock("next/navigation", () => ({ notFound: () => { throw Error("NOT_FOUND"); } }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ children }: { children: ReactElement }) => children }));
jest.mock("@/components/BackButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ProfileShareButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/FollowStats", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/FollowButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/OffersPanel", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/ProfilePostsGallery", () => ({ __esModule: true,
  default: (props: { initialLikedPostIds: string[] }) => createElement("output", null, JSON.stringify(props)),
}));

import Page, { generateMetadata } from "@/app/creators/[creatorId]/page";
import { readCreatorPublicProfile } from "@/lib/creatorPublicProfile";
import { updateInterestScore } from "@/lib/updateInterestScore";
const profile = { id: "creator-1", username: "Coach", full_name: "Coach", tagline: "Learn", bio: "Bio",
  avatar_url: "https://example.test/avatar.png", interests: ["technology & ai", "education & career skills"] };
const params = Promise.resolve({ creatorId: profile.id });
const viewer = (id: string | null) => ({ data: { user: id ? { id } : null }, error: null });
const ticks = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
beforeEach(() => { jest.clearAllMocks(); getUser.mockResolvedValue(viewer("viewer-a")); });

test("public profile read overlaps verified auth, with one creator read and no early viewer effects", async () => {
  let release!: (value: ReturnType<typeof viewer>) => void;
  getUser.mockReturnValue(new Promise(resolve => { release = resolve; }));
  db = createMockClient(op => op.table === "profiles" ? { data: profile, error: null } : undefined);
  const pending = Page({ params }); await ticks();
  expect(db.opsFor("profiles")).toHaveLength(1);
  expect(db.opsFor("profiles")[0].columns).toContain("interests");
  expect(db.opsFor("posts")).toHaveLength(0);
  expect(db.opsFor("follows")).toHaveLength(0);
  expect(updateInterestScore).not.toHaveBeenCalled();
  release(viewer("viewer-a")); await pending;
  expect(getUser).toHaveBeenCalledTimes(1);
  expect(db.opsFor("profiles")).toHaveLength(1);
  expect(updateInterestScore).toHaveBeenCalledTimes(1);
  expect(updateInterestScore).toHaveBeenCalledWith("viewer-a", "technology & ai", 4);
  expect(db.opsFor("posts")[0].isFilters).toEqual(expect.arrayContaining([
    { column: "hidden_at", value: null }, { column: "removed_at", value: null },
  ]));
});

test("ID precedence and exact username fallback preserve resolution and metadata", async () => {
  db = createMockClient(op => op.table === "profiles" ? { data: profile, error: null } : undefined);
  expect((await readCreatorPublicProfile(profile.id)).data).toEqual(profile);
  expect(db.opsFor("profiles")).toHaveLength(1);
  db = createMockClient(op => op.table !== "profiles" ? undefined : op.filters.id
    ? { data: null, error: { code: "22P02" } }
    : { data: op.filters.username === "Coach" ? profile : null, error: null });
  const metadata = await generateMetadata({ params: Promise.resolve({ creatorId: "Coach" }) });
  expect(metadata).toMatchObject({ title: "Coach (@Coach)", description: "Learn", alternates: { canonical: "/creators/Coach" } });
  expect(db.opsFor("profiles").map(op => op.filters)).toEqual([{ id: "Coach" }, { username: "Coach" }]);
  expect((await readCreatorPublicProfile("coach")).data).toBeNull();
});

test.each([null, [], [null]])("missing primary interests %p keep the existing no-op score call", async interests => {
  db = createMockClient(op => op.table === "profiles" ? { data: { ...profile, interests }, error: null } : undefined);
  await Page({ params }); expect(updateInterestScore).toHaveBeenCalledWith("viewer-a", null, 4);
  expect(db.opsFor("profiles")).toHaveLength(1);
});

test("anonymous viewers create no personalized read or score update", async () => {
  getUser.mockResolvedValue(viewer(null));
  db = createMockClient(op => op.table === "profiles" ? { data: profile, error: null } : undefined);
  await Page({ params }); expect(updateInterestScore).not.toHaveBeenCalled();
  expect(db.opsFor("likes")).toHaveLength(0);
  expect(db.opsFor("follows").every(op => !Object.hasOwn(op.filters, "follower_id") || !Object.hasOwn(op.filters, "following_id"))).toBe(true);
});

test("viewer likes remain independent for two verified viewers", async () => {
  db = createMockClient(op => {
    if (op.table === "profiles") return { data: profile, error: null };
    if (op.table === "posts") return { data: [{ id: "post-1", creator_id: profile.id, video_url: "https://example.test/video.mp4" }], error: null };
    if (op.table === "likes") return { data: op.filters.user_id === "viewer-a" ? [{ post_id: "post-1" }] : [], error: null };
    return undefined;
  });
  const first = renderToStaticMarkup(await Page({ params }) as ReactElement);
  getUser.mockResolvedValue(viewer("viewer-b"));
  const second = renderToStaticMarkup(await Page({ params }) as ReactElement);
  expect(db.opsFor("likes").map(op => op.filters.user_id)).toEqual(["viewer-a", "viewer-b"]);
  expect(first).not.toEqual(second);
  expect(updateInterestScore).toHaveBeenNthCalledWith(1, "viewer-a", "technology & ai", 4);
  expect(updateInterestScore).toHaveBeenNthCalledWith(2, "viewer-b", "technology & ai", 4);
});

test("failed resolution produces notFound and no interest side effect", async () => {
  db = createMockClient(op => op.table === "profiles" ? { data: null, error: { message: "unavailable" } } : undefined);
  await expect(Page({ params })).rejects.toThrow("NOT_FOUND");
  expect(updateInterestScore).not.toHaveBeenCalled(); expect(db.opsFor("posts")).toHaveLength(0);
  expect(await generateMetadata({ params })).toEqual({});
});
