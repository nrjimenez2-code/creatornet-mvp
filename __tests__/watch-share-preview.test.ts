/**
 * Post links unfurl with the post's own title, caption and thumbnail — and
 * nothing at all for moderated or unknown posts.
 *
 * app/watch/[postId]/layout.tsx builds the share card server-side for a page
 * that otherwise requires sign-in. These tests call the real generateMetadata
 * with a stubbed admin client and pin: the card for a visible post (title,
 * caption, CDN poster, noindex kept), the generic card for hidden, removed and
 * unknown posts and for database errors, that a malformed id never reaches the
 * database, and that a post without a poster gets a text-only card.
 */

type Row = Record<string, unknown> | null;
const rows: { posts: Row; profiles: Row; postsError?: { message: string } | null; throwOnPosts?: boolean } = { posts: null, profiles: null };
const calls: string[] = [];
const isFilters: { column: string; value: null }[] = [];

jest.mock("@/lib/supabaseAdmin", () => ({
  supabaseAdmin: {
    from(table: "posts" | "profiles") {
      calls.push(table);
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: (column: string, value: null) => { isFilters.push({ column, value }); return chain; },
        maybeSingle: async () => {
          if (table === "posts" && rows.throwOnPosts) throw new Error("boom");
          if (table === "posts") return { data: rows.posts, error: rows.postsError ?? null };
          return { data: rows.profiles, error: null };
        },
      };
      return chain;
    },
  },
}));

import { generateMetadata } from "@/app/watch/[postId]/layout";

const BUCKET = "https://pub-91a8d994910d498d90b109487939e1db.r2.dev";
const POST_ID = "e5930681-093c-4674-b108-f23f563eb14b";
const visible = {
  id: POST_ID, title: "Hip mobility in 4 minutes", content: "A short routine you can do before every session.",
  poster_url: `${BUCKET}/thumbnails/767658b6/1.jpg`, creator_id: "767658b6", hidden_at: null, removed_at: null,
};
const meta = (postId = POST_ID) => generateMetadata({ params: Promise.resolve({ postId }) });
const generic = { title: "Watch", robots: { index: false, follow: false } };

beforeEach(() => {
  rows.posts = visible; rows.profiles = { full_name: "Noah Jimenez", username: "noahjimenezz" };
  rows.postsError = null; rows.throwOnPosts = false; calls.length = 0; isFilters.length = 0;
});

test("a visible post gets its own title, caption and CDN thumbnail, and stays noindex", async () => {
  const m = await meta();
  expect(m.title).toBe("Hip mobility in 4 minutes");
  expect(m.description).toBe("A short routine you can do before every session.");
  expect(m.robots).toEqual({ index: false, follow: false });
  expect(m.openGraph).toMatchObject({ title: "Hip mobility in 4 minutes", url: `/watch/${POST_ID}` });
  expect((m.openGraph as { images: { url: string }[] }).images).toEqual([{ url: "https://media.creatornet.net/thumbnails/767658b6/1.jpg" }]);
  expect(m.twitter).toMatchObject({ card: "summary_large_image", images: ["https://media.creatornet.net/thumbnails/767658b6/1.jpg"] });
  expect(JSON.stringify(m)).not.toContain("r2.dev");
  // The moderation filter is applied in the query, like every other discovery surface.
  expect(isFilters).toEqual([{ column: "hidden_at", value: null }, { column: "removed_at", value: null }]);
});

test("hidden, removed and unknown posts and database errors all get the generic card", async () => {
  for (const scenario of [
    () => { rows.posts = { ...visible, hidden_at: "2026-09-12T00:00:00Z" }; },
    () => { rows.posts = { ...visible, removed_at: "2026-09-12T00:00:00Z" }; },
    () => { rows.posts = null; },
    () => { rows.postsError = { message: "permission denied" }; },
    () => { rows.throwOnPosts = true; },
  ]) {
    rows.posts = visible; rows.postsError = null; rows.throwOnPosts = false; scenario();
    const m = await meta();
    expect(m).toEqual(generic);
    expect(JSON.stringify(m)).not.toContain("Hip mobility");
  }
});

test("a malformed id never reaches the database", async () => {
  for (const bad of ["", "not-a-uuid", "../../etc/passwd", `${POST_ID}'; drop table posts;--`]) {
    calls.length = 0;
    expect(await meta(bad)).toEqual(generic);
    expect(calls).toEqual([]);
  }
});

test("a post without a poster gets a text-only card; a post without a title is named after its creator", async () => {
  rows.posts = { ...visible, poster_url: null, title: "  " };
  const m = await meta();
  expect(m.title).toBe("A video by Noah Jimenez");
  expect(m.openGraph).not.toHaveProperty("images");
  expect(m.twitter).toMatchObject({ card: "summary" });
  expect(m.twitter).not.toHaveProperty("images");

  rows.profiles = { full_name: null, username: "noahjimenezz" };
  expect((await meta()).title).toBe("A video by @noahjimenezz");
  rows.profiles = null;
  expect((await meta()).title).toBe("Watch");
  expect((await meta()).description).toBe("A short routine you can do before every session.");
});

test("third-party posters are not rewritten and non-https posters are dropped", async () => {
  rows.posts = { ...visible, poster_url: "https://example.com/p.jpg" };
  expect((await meta()).openGraph).toMatchObject({ images: [{ url: "https://example.com/p.jpg" }] });
  rows.posts = { ...visible, poster_url: "/relative.jpg" };
  expect((await meta()).openGraph).not.toHaveProperty("images");
});
