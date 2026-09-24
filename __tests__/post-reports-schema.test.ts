/** @jest-environment ./test-support/pglite-environment.cjs */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

declare const createLocalPostgres: () => PGlite;

test("report migration keeps rows private and prevents duplicate open reports", async () => {
  const db = createLocalPostgres();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create schema auth;
      create table auth.users (id uuid primary key);
      create table public.posts (id uuid primary key);
    `);
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260924004400_video_reports.sql"), "utf8");
    await db.exec(sql);
    const post = "11111111-1111-4111-8111-111111111111";
    const reporter = "22222222-2222-4222-8222-222222222222";
    await db.query("insert into public.posts (id) values ($1)", [post]);
    await db.query("insert into auth.users (id) values ($1)", [reporter]);
    await db.query("insert into public.post_reports (post_id, reporter_id, reason) values ($1, $2, 'spam')", [post, reporter]);
    await expect(db.query("insert into public.post_reports (post_id, reporter_id, reason) values ($1, $2, 'spam')", [post, reporter]))
      .rejects.toThrow();
    const { rows } = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid='public.post_reports'::regclass");
    expect(rows[0].relrowsecurity).toBe(true);
    const permissions = await db.query<{ can_read: boolean }>("select has_table_privilege('authenticated', 'public.post_reports', 'select') as can_read");
    expect(permissions.rows[0].can_read).toBe(false);
  } finally {
    await db.close();
  }
});
