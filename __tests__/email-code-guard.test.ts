/** @jest-environment ./test-support/pglite-environment.cjs */
import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
declare const createLocalPostgres: () => PGlite;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const email = "person@example.test";
const key = hash(email);
const agent = `CreatorNetEmailCode/${"a".repeat(64)}`;
const nonce = hash(agent);
const codeHash = hash("app-code-hmac-fixture");
const user = "00000000-0000-4000-8000-000000000001";
const session = "00000000-0000-4000-8000-000000000002";
let db: PGlite;
async function admit(action = "verify", n = nonce, code = codeHash) {
  return (await db.query<{ result: Record<string, unknown> }>("select public.email_code_admit($1,$2,$3,$4) result", [key, action, code, n])).rows[0].result;
}
async function finish(n = nonce) {
  return (await db.query<{ result: Record<string, unknown> }>("select public.email_code_finish($1,$2) result", [key, n])).rows[0].result;
}
async function hook(method = "otp", uid = user, sid = session) {
  return (await db.query<{ result: Record<string, unknown> }>("select public.creatornet_email_code_token_hook($1::jsonb) result", [JSON.stringify({ authentication_method: method, user_id: uid, claims: { session_id: sid, sub: uid } })])).rows[0].result;
}
beforeAll(async () => {
  db = createLocalPostgres();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create role supabase_auth_admin;
    create schema auth; create table auth.users(id uuid primary key,email text); create table auth.sessions(id uuid primary key,user_id uuid,user_agent text);`);
  await db.exec(readFileSync("supabase/migrations/20260920230602_email_code_attempt_guard.sql", "utf8"));
}, 30000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec("reset role; truncate auth_private.email_code_attempts, auth_private.email_code_ip_limits, auth.users, auth.sessions;");
  await db.query("insert into auth.users values($1,$2)", [user, email]);
  await db.query("insert into auth.sessions values($1,$2,$3)", [session, user, agent]);
  await db.query("insert into auth_private.email_code_attempts(email_key,code_hash,code_expires_at) values($1,$2,clock_timestamp()+interval '10 minutes')", [key, codeHash]);
});
test("five failures lock verification and resend for 15 minutes", async () => {
  for (let i = 0; i < 5; i++) {
    expect((await admit("verify", nonce, hash("wrong"))).allowed).toBe(false);
  }
  for (const action of ["verify", "send"]) {
    expect(await admit(action)).toMatchObject({ allowed: false, reason: "locked" });
  }
  expect((await admit()).retry_after).toBeGreaterThan(890);
  await db.exec("update auth_private.email_code_attempts set locked_until=clock_timestamp()-interval '1 second'");
  expect(await admit()).toMatchObject({ allowed: true, attempts_remaining: 4 });
});
test("resending waits 60 seconds and does not reset attempts", async () => {
  await admit("verify", nonce, hash("wrong"));
  expect((await admit("send")).allowed).toBe(true);
  expect(await admit("send")).toMatchObject({ allowed: false, reason: "resend" });
  expect(await admit()).toMatchObject({ allowed: true, attempts_remaining: 3 });
});
test("overlapping requests receive one admission", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => admit()));
  expect(results.filter(r => r.allowed)).toHaveLength(1);
  expect(results.filter(r => r.reason === "busy")).toHaveLength(9);
});
test("expired ambiguous calls count; an old completion cannot clear a new lease", async () => {
  await admit();
  await db.exec("update auth_private.email_code_attempts set admission_expires_at=clock_timestamp()-interval '1 second'");
  await admit("send");
  const next = hash("next");
  expect(await admit("verify", next)).toMatchObject({ allowed: true, attempts_remaining: 3 });
  expect((await finish()).verified).toBe(false);
  expect(await admit()).toMatchObject({ allowed: false, reason: "busy" });
});
test("correct fifth attempt can succeed, consume its nonce, and reset failures", async () => {
  for (let i = 0; i < 4; i++) { await admit("verify", nonce, hash("wrong")); }
  await admit();
  await db.exec("set role supabase_auth_admin");
  expect((await hook()).error).toBeUndefined();
  expect((await hook()).error).toBeDefined();
  await db.exec("reset role; set role service_role");
  expect(await finish()).toMatchObject({ verified: true, attempts_remaining: 5 });
  expect((await admit()).allowed).toBe(false); // Successful code was consumed.
});
test("direct API calls, fake nonces, wrong users, and expired admissions cannot issue OTP sessions", async () => {
  expect((await hook()).error).toBeDefined();
  await admit();
  await db.query("update auth.sessions set user_agent=$1", [`CreatorNetEmailCode/${"b".repeat(64)}`]);
  expect((await hook()).error).toBeDefined();
  await db.query("update auth.sessions set user_agent=$1", [agent]);
  expect((await hook("otp", "00000000-0000-4000-8000-000000000003")).error).toBeDefined();
  await db.exec("update auth_private.email_code_attempts set admission_expires_at=clock_timestamp()-interval '1 second'");
  expect((await hook()).error).toBeDefined();
});
test.each(["oauth", "token_refresh"])("%s does not need an OTP admission", async method => {
  expect(await hook(method)).toMatchObject({ claims: { session_id: session } });
});
test("expired and replayed application codes cannot reserve a session", async () => {
  await db.exec("update auth_private.email_code_attempts set code_expires_at=clock_timestamp()-interval '1 second'");
  expect(await admit()).toMatchObject({ allowed: false, reason: "invalid" });
  await admit("send");
  expect((await admit()).allowed).toBe(true);
  await finish();
  expect(await admit()).toMatchObject({ allowed: false, reason: "invalid" });
});
test.each(["anon", "authenticated"])("%s cannot reserve, reset, or mint admissions", async role => {
  await db.exec(`set role ${role}`);
  await expect(admit()).rejects.toThrow(/permission denied/);
  await expect(finish()).rejects.toThrow(/permission denied/);
  await expect(hook()).rejects.toThrow(/permission denied/);
  await expect(db.query("select * from auth_private.email_code_attempts")).rejects.toThrow(/permission denied/);
});
test("one IP cannot evade limits by rotating email addresses", async () => {
  const ip = hash("192.0.2.1");
  const check = async () => (await db.query<{ result: { allowed: boolean } }>("select public.email_code_ip_admit($1) result", [ip])).rows[0].result;
  await db.exec("set role service_role");
  for (let i = 0; i < 30; i++) expect((await check()).allowed).toBe(true);
  expect((await check()).allowed).toBe(false);
  await db.exec("reset role; update auth_private.email_code_ip_limits set window_started_at=clock_timestamp()-interval '6 minutes'");
  expect((await check()).allowed).toBe(true);
});
