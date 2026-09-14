/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  INTEREST_LABELS,
  INTEREST_CATEGORIES,
  normalizeInterests,
} from "@/lib/interestCategories";
import { matchInterestTopics } from "@/lib/interestTopics";
declare const createLocalPostgres: () => PGlite;
let db: PGlite;
const migration = readFileSync(
  "supabase/migrations/20260913004646_discover_taxonomy.sql",
  "utf8",
);
jest.setTimeout(90000);
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create table profiles(id uuid primary key, interests jsonb);
 create table posts(id uuid primary key, interests text[], topics text[]);
 create table user_interest_scores(user_id uuid, category text, score integer, updated_at timestamptz, primary key(user_id,category));
 insert into profiles values ('11111111-1111-4111-8111-111111111111',to_jsonb(array['Social Media Growth','Content Creation','Custom historical value']));
 insert into posts values ('22222222-2222-4222-8222-222222222222',array['Entrepreneurship','Social Media Growth'],array['shopify']);
 insert into user_interest_scores values ('11111111-1111-4111-8111-111111111111','social media growth',7,'2026-01-01'),
 ('11111111-1111-4111-8111-111111111111','content creation',13,'2026-02-01');`);
  await db.exec(migration);
});
afterAll(async () => {
  await db.close();
});
test("all eight labels have exactly one stored key", () => {
  expect(normalizeInterests(INTEREST_LABELS)).toEqual(INTEREST_CATEGORIES);
  expect(
    normalizeInterests(["Content Creation", "Social Media Growth"]),
  ).toEqual(["content creation & marketing"]);
});
test("migration preserves originals, unknown values, topics and total score", async () => {
  expect(
    (
      await db.query<{ interests: string[]; interest_topics: string[] }>(
        "select * from profiles",
      )
    ).rows[0],
  ).toMatchObject({
    interests: ["content creation & marketing", "custom historical value"],
    interest_topics: ["content creation", "social media growth"],
  });
  expect(
    (await db.query("select category,score from user_interest_scores")).rows,
  ).toEqual([{ category: "content creation & marketing", score: 20 }]);
  expect((await db.query("select topics from posts")).rows[0]).toEqual({
    topics: ["entrepreneurship", "shopify", "social media growth"],
  });
  expect(
    (await db.query("select count(*)::int n from interest_taxonomy_archive_v1"))
      .rows[0],
  ).toEqual({ n: 5 });
  const before = await db.query(
    "select * from interest_taxonomy_archive_v1 order by source,row_key",
  );
  await db.exec(migration);
  expect(
    (
      await db.query(
        "select * from interest_taxonomy_archive_v1 order by source,row_key",
      )
    ).rows,
  ).toEqual(before.rows);
  expect(
    (await db.query("select score from user_interest_scores")).rows[0],
  ).toEqual({ score: 20 });
});
test("old clients are normalized on future writes and archives are private", async () => {
  await db.exec("update profiles set interests=to_jsonb(array['Tech & AI Automation'])");
  expect((await db.query("select interests from profiles")).rows[0]).toEqual({
    interests: ["technology & ai"],
  });
  await db.exec("update posts set interests=array['Tech & AI Automation']");
  expect((await db.query("select interests from posts")).rows[0]).toEqual({
    interests: ["technology & ai"],
  });
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    try {
      await expect(
        db.query("select * from interest_taxonomy_archive_v1"),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec("reset role");
    }
  }
});
test("topics distinguish ecommerce mentorship and support multiple relevant subjects", () => {
  const result = matchInterestTopics({
    interests: ["Entrepreneurship"],
    title: "Build a Shopify store",
    offers: [
      {
        title: "E-commerce mentorship",
        description: "AI automation for marketing",
      },
    ],
  });
  expect(result.topics).toEqual(
    expect.arrayContaining([
      "ecommerce",
      "ecommerce mentorship",
      "artificial intelligence",
      "automation",
      "marketing",
    ]),
  );
  expect(result.categories).toEqual(
    expect.arrayContaining([
      "business & entrepreneurship",
      "technology & ai",
      "content creation & marketing",
    ]),
  );
  expect(
    matchInterestTopics({ title: "A chair repair hobby" }).topics,
  ).not.toContain("artificial intelligence");
});
